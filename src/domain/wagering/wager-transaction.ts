import { Money, MoneyProps } from '../money/money';
import { DomainValidationError, InvalidTransactionStateError, InvariantViolationError } from '../shared/errors';
import { canonicalHash } from '../shared/hash';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { PendingReferencePolicy } from './pending-reference-policy';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API/fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds que um provedor pode submeter (OPENING é interno). */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/** providerId reservado para transações internas (OPENING). Rejeitado em submissões externas. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Transições válidas (documentadas em ARCHITECTURE.md; reforçadas também por trigger no banco):
 *   PENDING            → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED          (+ reagendamento, que não muda o status)
 *   PROCESSED | REJECTED | FAILED → ∅   (terminais: tentar transicionar é erro de programação)
 */
export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo da wallet observado quando a transação foi resolvida (devolvido em replays). */
  balanceObserved?: Money | undefined;
  referenceAttempts?: number | undefined;
  nextReferenceCheckAt?: Date | undefined;
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

function requireText(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new DomainValidationError(`${field} must be a non-empty string with at most ${max} chars`, { field });
  }
  return value;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _balanceObserved?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /**
   * Hash do payload de NEGÓCIO: sha256 do JSON canônico (chaves ordenadas, sem espaços) de
   * {providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId|null}.
   * Header Idempotency-Key e metadados de transporte NÃO entram no hash.
   */
  static computePayloadHash(f: {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string | undefined;
  }): string {
    return canonicalHash({
      providerId: f.providerId,
      externalTransactionId: f.externalTransactionId,
      playerId: f.playerId,
      walletId: f.walletId,
      roundId: f.roundId,
      gameId: f.gameId,
      kind: f.kind,
      money: { amount: f.money.amount, currency: f.money.currency },
      referenceExternalTransactionId: f.referenceExternalTransactionId ?? null,
    });
  }

  /** Nasce em PENDING. Valida a exigência de referência por kind. OPENING é proibido aqui. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError('OPENING is internal and cannot be submitted', { field: 'kind' });
    }
    if (!(SUBMITTABLE_KINDS as readonly string[]).includes(p.kind)) {
      throw new DomainValidationError(`unsupported kind: ${String(p.kind)}`, { field: 'kind' });
    }
    const providerId = requireText('providerId', p.providerId, 64);
    if (providerId === INTERNAL_PROVIDER_ID) {
      throw new DomainValidationError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`, { field: 'providerId' });
    }
    requireText('externalTransactionId', p.externalTransactionId, 128);
    requireText('idempotencyKey', p.idempotencyKey, 256);
    requireText('playerId', p.playerId, 128);
    requireText('roundId', p.roundId, 128);
    requireText('gameId', p.gameId, 128);
    if (p.money.isNegative()) throw new DomainValidationError('amount cannot be negative', { field: 'money' });
    if (p.kind !== WagerTransactionKind.Loss && !p.money.isPositive()) {
      throw new DomainValidationError(`amount must be greater than zero for ${p.kind}`, { field: 'money' });
    }
    const ref = p.referenceExternalTransactionId;
    if (ref !== undefined) requireText('referenceExternalTransactionId', ref, 128);
    if ((p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback) && ref === undefined) {
      throw new DomainValidationError(`${p.kind} requires referenceExternalTransactionId`, { field: 'referenceExternalTransactionId' });
    }
    if (ref !== undefined && ref === p.externalTransactionId) {
      throw new DomainValidationError('a transaction cannot reference itself', { field: 'referenceExternalTransactionId' });
    }
    if (p.kind === WagerTransactionKind.Bet && ref !== undefined) {
      throw new DomainValidationError('BET cannot reference another transaction', { field: 'referenceExternalTransactionId' });
    }
    const payloadHash = WagerTransaction.computePayloadHash({ ...p, money: p.money.toJSON() });
    return new WagerTransaction(
      p.id, p.providerId, p.externalTransactionId, p.idempotencyKey, payloadHash, p.walletId, p.playerId,
      p.roundId, p.gameId, p.kind, p.money, ref, p.createdAt, WagerTransactionStatus.Pending,
    );
  }

  /** Transação interna de abertura da wallet (CREDIT do saldo inicial). */
  static opening(p: { id: string; walletId: string; playerId: string; money: Money; createdAt: Date }): WagerTransaction {
    const externalTransactionId = `opening:${p.walletId}`;
    const payloadHash = WagerTransaction.computePayloadHash({
      providerId: INTERNAL_PROVIDER_ID, externalTransactionId, playerId: p.playerId, walletId: p.walletId,
      roundId: 'opening', gameId: 'opening', kind: WagerTransactionKind.Opening, money: p.money.toJSON(),
    });
    return new WagerTransaction(
      p.id, INTERNAL_PROVIDER_ID, externalTransactionId, externalTransactionId, payloadHash, p.walletId, p.playerId,
      'opening', 'opening', WagerTransactionKind.Opening, p.money, undefined, p.createdAt, WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir do banco: não revalida regras de transição. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId, s.playerId,
      s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt, s.balanceObserved, s.referenceAttempts ?? 0, s.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceObserved(): Money | undefined {
    return this._balanceObserved;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transições (lançam InvalidTransactionStateError quando a origem não permite)

  /** PENDING → PENDING_REFERENCE: referência ainda não chegou (ou ainda não foi resolvida). */
  markPendingReference(now: Date, policy: PendingReferencePolicy, balanceObserved: Money): void {
    this.assertStatus('markPendingReference', WagerTransactionStatus.Pending);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceCheckAt = new Date(now.getTime() + policy.delayFor(0));
    this._balanceObserved = balanceObserved;
  }

  /**
   * Reagenda a próxima checagem (backoff exponencial). Não muda o status.
   * Devolve 'EXHAUSTED' quando o limite de tentativas ou o TTL foi atingido — o chamador então rejeita.
   */
  scheduleReferenceRetry(now: Date, policy: PendingReferencePolicy): 'RESCHEDULED' | 'EXHAUSTED' {
    this.assertStatus('scheduleReferenceRetry', WagerTransactionStatus.PendingReference);
    const attempts = this._referenceAttempts + 1;
    if (attempts >= policy.maxAttempts || now.getTime() - this.createdAt.getTime() >= policy.ttlMs) {
      return 'EXHAUSTED';
    }
    this._referenceAttempts = attempts;
    this._nextReferenceCheckAt = new Date(now.getTime() + policy.delayFor(attempts));
    return 'RESCHEDULED';
  }

  /** PENDING | PENDING_REFERENCE → PROCESSED. */
  markProcessed(at: Date, balanceObserved: Money, referenceTransactionId?: string): void {
    this.assertStatus('markProcessed', WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = at;
    this._balanceObserved = balanceObserved;
    this._referenceTransactionId = referenceTransactionId;
    this._nextReferenceCheckAt = undefined;
  }

  /** PENDING | PENDING_REFERENCE → REJECTED (violação de regra de negócio). */
  reject(code: FailureCode, ctx: { balanceObserved?: Money; referenceTransactionId?: string } = {}): void {
    this.assertStatus('reject', WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceObserved = ctx.balanceObserved ?? this._balanceObserved;
    this._referenceTransactionId = ctx.referenceTransactionId;
    this._nextReferenceCheckAt = undefined;
  }

  /** PENDING | PENDING_REFERENCE → FAILED (erro permanente de infraestrutura; auditável). */
  fail(code: FailureCode): void {
    this.assertStatus('fail', WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK é o inverso da referência: reverter BET credita; reverter WIN/REFUND debita.
   * LOSS não tem lançamento (lança erro).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvariantViolationError('ROLLBACK needs its reference to define the ledger direction');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default:
        throw new InvariantViolationError(`${this.kind} does not produce a ledger entry`);
    }
  }

  private assertStatus(action: string, ...allowed: WagerTransactionStatus[]): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(`cannot ${action} a transaction in status ${this._status}`, {
        transactionId: this.id,
        status: this._status,
      });
    }
  }
}
