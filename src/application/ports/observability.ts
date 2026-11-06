export abstract class AppLogger {
  abstract debug(message: string, fields?: Record<string, unknown>): void;
  abstract info(message: string, fields?: Record<string, unknown>): void;
  abstract warn(message: string, fields?: Record<string, unknown>): void;
  abstract error(message: string, fields?: Record<string, unknown>): void;
}

/** Porta de métricas com vocabulário do domínio (a implementação Prometheus fica na infraestrutura). */
export abstract class Metrics {
  /** transações por status (PROCESSED | REJECTED | PENDING_REFERENCE | FAILED). */
  abstract transaction(status: string, kind: string, source: string): void;
  abstract duplicate(source: string): void;
  abstract retry(component: string): void;
  abstract dlq(reason: string): void;
  abstract lockConflict(type: string): void;
  abstract processingDuration(source: string, outcome: string, seconds: number): void;
  abstract reconciliationDivergence(): void;
  abstract outboxPublished(): void;
  abstract outboxPublishFailed(): void;
  abstract outboxState(pending: number, lagSeconds: number): void;
  abstract sqsMessage(result: string): void;
}
