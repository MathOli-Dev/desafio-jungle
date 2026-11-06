import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Metrics } from '@/application/ports/observability';

/**
 * Métricas Prometheus (GET /metrics). Cobre: transações por status, duplicatas, retries, DLQ, conflitos de lock,
 * outbox lag e latência de processamento. Rótulos de baixa cardinalidade (nada de ids).
 */
@Injectable()
export class PrometheusMetrics extends Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total', help: 'Transações resolvidas, por status final.', labelNames: ['status', 'kind', 'source'], registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total', help: 'Duplicatas detectadas (idempotência/inbox).', labelNames: ['source'], registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total', help: 'Retries por componente.', labelNames: ['component'], registers: [this.registry],
  });
  private readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total', help: 'Mensagens enviadas à DLQ.', labelNames: ['reason'], registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total', help: 'Conflitos de concorrência (lock timeout, deadlock, versão, unique).', labelNames: ['type'], registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds', help: 'Latência do processamento de uma transação.', labelNames: ['source', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wager_reconciliation_divergences_total', help: 'Divergências saldo × ledger detectadas.', registers: [this.registry],
  });
  private readonly published = new Counter({ name: 'wager_outbox_published_total', help: 'Eventos publicados.', registers: [this.registry] });
  private readonly publishFailed = new Counter({ name: 'wager_outbox_publish_failures_total', help: 'Falhas de publicação.', registers: [this.registry] });
  private readonly outboxPending = new Gauge({ name: 'wager_outbox_pending_events', help: 'Eventos aguardando publicação.', registers: [this.registry] });
  private readonly outboxLag = new Gauge({ name: 'wager_outbox_lag_seconds', help: 'Idade do evento pendente mais antigo.', registers: [this.registry] });
  private readonly sqs = new Counter({ name: 'wager_sqs_messages_total', help: 'Mensagens SQS por resultado.', labelNames: ['result'], registers: [this.registry] });
  private readonly httpRequests = new Counter({
    name: 'http_requests_total', help: 'Requisições HTTP.', labelNames: ['method', 'route', 'status'], registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds', help: 'Latência HTTP.', labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [this.registry],
  });

  constructor() {
    super();
    try {
      collectDefaultMetrics({ register: this.registry });
    } catch {
      /* algumas métricas de runtime podem não existir em todos os runtimes; as de negócio não dependem disso */
    }
  }

  transaction(status: string, kind: string, source: string): void { this.transactions.inc({ status, kind, source }); }
  duplicate(source: string): void { this.duplicates.inc({ source }); }
  retry(component: string): void { this.retries.inc({ component }); }
  dlq(reason: string): void { this.dlqMessages.inc({ reason }); }
  lockConflict(type: string): void { this.lockConflicts.inc({ type }); }
  processingDuration(source: string, outcome: string, seconds: number): void { this.duration.observe({ source, outcome }, seconds); }
  reconciliationDivergence(): void { this.divergences.inc(); }
  outboxPublished(): void { this.published.inc(); }
  outboxPublishFailed(): void { this.publishFailed.inc(); }
  outboxState(pending: number, lagSeconds: number): void { this.outboxPending.set(pending); this.outboxLag.set(lagSeconds); }
  sqsMessage(result: string): void { this.sqs.inc({ result }); }
  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
