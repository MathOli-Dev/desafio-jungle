import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../ports/clock';
import { AppLogger, Metrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';
import { PENDING_REFERENCE_POLICY } from './submit-wager-transaction';
import { persistProcessed, persistRejected, withConflictRetries } from './support';
import { FailureCode } from '@/domain/wagering/failure-code';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { settle } from '@/domain/wagering/settlement';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { uuidv7 } from '@/domain/shared/uuid';

export type ReprocessOutcome = 'PROCESSED' | 'REJECTED' | 'RESCHEDULED' | 'SKIPPED';

/**
 * Reprocessa UMA transação PENDING_REFERENCE (chamado pelo worker agendado). Mesma disciplina de lock do fluxo
 * principal: wallet primeiro, depois reler a transação sob o lock (vários workers/instâncias podem disputar a mesma).
 */
@Injectable()
export class ReprocessPendingReferenceUseCase {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(PENDING_REFERENCE_POLICY) private readonly policy: PendingReferencePolicy,
  ) {}

  async execute(transactionId: string): Promise<ReprocessOutcome> {
    const header = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!header || header.status !== WagerTransactionStatus.PendingReference) return 'SKIPPED';

    return withConflictRetries('pending-reference', this.metrics, () =>
      this.uow.run(async (repos): Promise<ReprocessOutcome> => {
        const wallet = await repos.wallets.lockById(header.walletId);
        if (!wallet) return 'SKIPPED';
        const tx = await repos.transactions.findById(transactionId);
        if (!tx || tx.status !== WagerTransactionStatus.PendingReference || !tx.referenceExternalTransactionId) return 'SKIPPED';

        const now = this.clock.now();
        const expectedVersion = wallet.version;
        const reference = await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
        const referenceAlreadyReversed =
          reference && tx.isReversal() && reference.status === WagerTransactionStatus.Processed ? await repos.transactions.isReversed(reference.id) : false;
        const outcome = settle({ tx, wallet, reference, referenceAlreadyReversed, now, newEntryId: uuidv7 });
        const eventCtx = { correlationId: `pending-ref:${tx.id}`, causationId: tx.id, occurredAt: now };

        if (outcome.outcome === 'PROCESSED') {
          await persistProcessed(repos, { tx, wallet, expectedVersion, entry: outcome.entry, isNew: false, eventCtx });
          this.metrics.transaction(tx.status, tx.kind, 'pending-worker');
          this.logger.info('pending reference resolved', { transactionId: tx.id, status: tx.status });
          return 'PROCESSED';
        }
        if (outcome.outcome === 'REJECTED') {
          await persistRejected(repos, { tx, isNew: false, eventCtx });
          this.metrics.transaction(tx.status, tx.kind, 'pending-worker');
          this.logger.info('pending reference rejected', { transactionId: tx.id, failureCode: tx.failureCode });
          return 'REJECTED';
        }

        // Ainda sem referência resolvida: backoff exponencial até esgotar tentativas/TTL; então REJECTED + evento.
        if (tx.scheduleReferenceRetry(now, this.policy) === 'RESCHEDULED') {
          await repos.transactions.update(tx);
          this.metrics.retry('pending-reference-backoff');
          return 'RESCHEDULED';
        }
        const code = outcome.reason === 'REFERENCE_MISSING' ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
        tx.reject(code, { balanceObserved: wallet.balance });
        await persistRejected(repos, { tx, isNew: false, eventCtx });
        this.metrics.transaction(tx.status, tx.kind, 'pending-worker');
        this.logger.warn('pending reference exhausted', { transactionId: tx.id, failureCode: code });
        return 'REJECTED';
      }),
    );
  }
}
