import { Inject, Injectable } from '@nestjs/common';
import { InboxPayloadMismatchError, PermanentInfrastructureError } from '../errors';
import { bindContext } from '../execution-context';
import { Failpoints } from '../failpoints';
import { Clock } from '../ports/clock';
import { AppLogger, Metrics } from '../ports/observability';
import { Repositories, UnitOfWork } from '../ports/repositories';
import { persistPending, persistProcessed, persistRejected, SubmissionResult, toResult, withConflictRetries } from './support';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { Money, MoneyProps } from '@/domain/money/money';
import { IdempotencyConflictError, WalletNotFoundError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { settle } from '@/domain/wagering/settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface SubmissionContext {
  source: 'http' | 'sqs';
  correlationId: string;
  /** Presente quando a entrada é SQS: dedup persistente por (consumerName, messageId), na mesma transação. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export const PENDING_REFERENCE_POLICY = Symbol('PENDING_REFERENCE_POLICY');

/**
 * Caso de uso ÚNICO para HTTP e SQS. Estratégia de concorrência: lock pessimista por wallet
 * (SELECT ... FOR UPDATE) + UPDATE versionado como cinto-e-suspensório + CHECK no banco como última defesa.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(PENDING_REFERENCE_POLICY) private readonly policy: PendingReferencePolicy,
    @Inject(Failpoints) private readonly failpoints: Failpoints,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand, ctx: SubmissionContext): Promise<SubmissionResult> {
    const startedAt = performance.now();
    bindContext({ providerId: cmd.providerId, walletId: cmd.walletId });

    // Validação de domínio (lança DomainError → HTTP 400 / SQS DLQ). Nasce em PENDING.
    const incoming = WagerTransaction.create({
      id: uuidv7(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as WagerTransactionKind,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    // Fast path SEM lock: replay de operação já registrada (idempotência persistente, não em memória).
    const known = await this.uow.read((r) => r.transactions.findExisting(cmd.providerId, cmd.idempotencyKey, cmd.externalTransactionId));
    if (known) return this.finish(this.replay(known, incoming, ctx), ctx, startedAt, 'replay');

    const result = await withConflictRetries('submit', this.metrics, () => this.uow.run((repos) => this.process(repos, incoming, ctx)));
    return this.finish(result, ctx, startedAt, result.idempotentReplay ? 'replay' : result.status);
  }

  private finish(result: SubmissionResult, ctx: SubmissionContext, startedAt: number, outcome: string): SubmissionResult {
    bindContext({ transactionId: result.transactionId });
    this.metrics.processingDuration(ctx.source, outcome, (performance.now() - startedAt) / 1000);
    return result;
  }

  /** Mesma key/externalId: payload idêntico ⇒ replay do resultado original; payload diferente ⇒ conflito. */
  private replay(existing: WagerTransaction, incoming: WagerTransaction, ctx: SubmissionContext): SubmissionResult {
    if (!existing.matchesPayload(incoming.payloadHash)) {
      throw new IdempotencyConflictError('Idempotency-Key / externalTransactionId already used with a different payload', {
        externalTransactionId: incoming.externalTransactionId,
      });
    }
    this.metrics.duplicate(ctx.source);
    return toResult(existing, true);
  }

  private async process(repos: Repositories, incoming: WagerTransaction, ctx: SubmissionContext): Promise<SubmissionResult> {
    const now = this.clock.now();

    // (a) Inbox: efeito no máximo uma vez por (consumerName, messageId) — na MESMA transação do efeito financeiro.
    let inbox: InboxMessage | undefined;
    if (ctx.inbox) {
      inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      if (!(await repos.inbox.tryReceive(inbox))) {
        const stored = await repos.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (stored && stored.payloadHash !== ctx.inbox.payloadHash) throw new InboxPayloadMismatchError(ctx.inbox.messageId);
        const done = await repos.transactions.findExisting(incoming.providerId, incoming.idempotencyKey, incoming.externalTransactionId);
        if (!done) throw new PermanentInfrastructureError('inbox row exists without its transaction', 'INBOX_INCONSISTENT');
        this.metrics.duplicate('sqs-inbox');
        return toResult(done, true);
      }
    }
    const markInbox = async () => {
      if (!inbox) return;
      inbox.markProcessed(now);
      await repos.inbox.markProcessed(inbox);
    };

    // (b) Lock pessimista da wallet: serializa só esta wallet; as demais seguem em paralelo.
    const wallet = await repos.wallets.lockById(incoming.walletId);
    if (!wallet) throw new WalletNotFoundError(`wallet ${incoming.walletId} not found`, { walletId: incoming.walletId });
    const expectedVersion = wallet.version;

    // (c) Rechecagem de idempotência SOB o lock: um duplicado concorrente pode ter commitado enquanto esperávamos.
    const existing = await repos.transactions.findExisting(incoming.providerId, incoming.idempotencyKey, incoming.externalTransactionId);
    if (existing) {
      const replayed = this.replay(existing, incoming, ctx);
      await markInbox();
      return replayed;
    }

    // (d) Referência (resolvida por provider + externalId) e regras de negócio — função de domínio pura.
    const reference = incoming.referenceExternalTransactionId
      ? await repos.transactions.findByExternalId(incoming.providerId, incoming.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference && incoming.isReversal() && reference.status === WagerTransactionStatus.Processed ? await repos.transactions.isReversed(reference.id) : false;
    const outcome = settle({ tx: incoming, wallet, reference, referenceAlreadyReversed, now, newEntryId: uuidv7 });

    const eventCtx = { correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId ?? incoming.id, occurredAt: now };
    switch (outcome.outcome) {
      case 'PROCESSED':
        await persistProcessed(repos, { tx: incoming, wallet, expectedVersion, entry: outcome.entry, isNew: true, eventCtx });
        break;
      case 'REJECTED':
        await persistRejected(repos, { tx: incoming, isNew: true, eventCtx });
        break;
      case 'PENDING_REFERENCE':
        incoming.markPendingReference(now, this.policy, wallet.balance);
        await persistPending(repos, { tx: incoming, eventCtx });
        break;
    }
    await markInbox();

    // Ponto de falha para testes de caos: morrer ANTES do commit ⇒ rollback total (nada foi aplicado).
    this.failpoints.hit('submit.before-commit');

    this.metrics.transaction(incoming.status, incoming.kind, ctx.source);
    this.logger.info('wager transaction resolved', { transactionId: incoming.id, status: incoming.status, kind: incoming.kind, failureCode: incoming.failureCode });
    return toResult(incoming, false);
  }
}
