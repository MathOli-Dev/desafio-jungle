import { AppLogger, Metrics } from '@/application/ports/observability';

/** Métricas "gravadoras": permitem asserções sem Prometheus. */
export class RecordingMetrics extends Metrics {
  readonly counters = new Map<string, number>();
  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  get(key: string): number {
    return this.counters.get(key) ?? 0;
  }
  transaction(status: string, kind: string, source: string): void { this.bump(`transaction:${status}:${kind}:${source}`); this.bump(`transaction:${status}`); }
  duplicate(source: string): void { this.bump(`duplicate:${source}`); this.bump('duplicate'); }
  retry(component: string): void { this.bump(`retry:${component}`); }
  dlq(reason: string): void { this.bump(`dlq:${reason}`); this.bump('dlq'); }
  lockConflict(type: string): void { this.bump(`lock_conflict:${type}`); this.bump('lock_conflict'); }
  processingDuration(): void { /* noop */ }
  reconciliationDivergence(): void { this.bump('reconciliation_divergence'); }
  outboxPublished(): void { this.bump('outbox_published'); }
  outboxPublishFailed(): void { this.bump('outbox_publish_failed'); }
  outboxState(): void { /* noop */ }
  sqsMessage(result: string): void { this.bump(`sqs:${result}`); }
}

export class SilentLogger extends AppLogger {
  readonly lines: Array<{ level: string; message: string; fields?: Record<string, unknown> | undefined }> = [];
  debug(message: string, fields?: Record<string, unknown>): void { this.lines.push({ level: 'debug', message, fields }); }
  info(message: string, fields?: Record<string, unknown>): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: Record<string, unknown>): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: Record<string, unknown>): void { this.lines.push({ level: 'error', message, fields }); }
}
