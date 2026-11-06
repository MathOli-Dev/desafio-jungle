/** Erros de domínio: tipados, com `code` estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada monetária inválida (NaN, notação científica, >2 casas, negativa em contrato de entrada...). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}
/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}
/** Débito que levaria o saldo abaixo de zero (defesa do agregado; o fluxo normal rejeita antes). */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}
/** Payload/estado inválido do ponto de vista do domínio (→ HTTP 400, SQS: DLQ). */
export class DomainValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}
/** Transição de estado inválida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
/** Invariante interna violada (ex.: lançamento desbalanceado). Sempre bug. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}
/** Mesma Idempotency-Key (ou externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}
export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}
export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}
export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}
