export type TransientKind =
  | 'LOCK_TIMEOUT' | 'DEADLOCK' | 'SERIALIZATION' | 'CONNECTION' | 'TIMEOUT'
  | 'UNIQUE_CONFLICT' | 'VERSION_CONFLICT' | 'BROKER';

/** Falha temporária de infraestrutura: seguro tentar de novo (HTTP 503 + Retry-After; SQS: retry com backoff). */
export class TransientInfrastructureError extends Error {
  constructor(message: string, readonly kind: TransientKind, override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}

/** Conflito otimista (UPDATE ... WHERE version = ? afetou 0 linhas). Com o lock pessimista não deveria ocorrer. */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(message: string, cause?: unknown) {
    super(message, 'VERSION_CONFLICT', cause);
    this.name = 'ConcurrencyConflictError';
  }
}

/** Falha permanente de infraestrutura (ex.: violação de invariante no banco). Não adianta tentar de novo. */
export class PermanentInfrastructureError extends Error {
  constructor(message: string, readonly reason: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'PermanentInfrastructureError';
  }
}

/** Mesmo messageId com conteúdo diferente: bug do produtor; vai para a DLQ. */
export class InboxPayloadMismatchError extends Error {
  constructor(readonly messageId: string) {
    super(`inbox message ${messageId} was already received with a different payload`);
    this.name = 'InboxPayloadMismatchError';
  }
}

/** Mensagem SQS ilegível/inválida (JSON quebrado, schema inválido, tipo desconhecido). Permanente → DLQ. */
export class MalformedMessageError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

/** Conflitos que se resolvem relendo o estado (o vencedor da corrida já commitou). */
export const isRetryableConflict = (e: unknown): e is TransientInfrastructureError =>
  e instanceof TransientInfrastructureError &&
  ['LOCK_TIMEOUT', 'DEADLOCK', 'SERIALIZATION', 'UNIQUE_CONFLICT', 'VERSION_CONFLICT'].includes(e.kind);
