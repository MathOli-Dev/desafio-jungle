import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '@/config/config';
import { Failpoints } from '@/application/failpoints';
import { Clock } from '@/application/ports/clock';
import { EventPublisher } from '@/application/ports/event-publisher';
import { AppLogger, Metrics } from '@/application/ports/observability';
import { UnitOfWork } from '@/application/ports/repositories';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { APP_CONFIG } from '../messaging/sqs';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const LANES = 4;
const BATCH = 10; // limite do SendMessageBatch
const laneOf = (aggregateId: string): number => {
  let h = 0;
  for (let i = 0; i < aggregateId.length; i++) h = (h * 31 + aggregateId.charCodeAt(i)) >>> 0;
  return h % LANES;
};

/**
 * Publisher da Transactional Outbox. Seguro com N instâncias concorrentes:
 *  - claim via FOR UPDATE SKIP LOCKED + lease (locked_by/locked_until): ninguém publica as mesmas linhas ao mesmo tempo;
 *  - se o publisher morrer depois de claimar/publicar, o lease expira e OUTRA instância assume (nada se perde);
 *  - publicação duplicada (morreu entre publicar e marcar) é possível e segura: o consumidor deduplica por eventId.
 * Falha de publicação ⇒ backoff exponencial por evento (nunca descarta). Eventos do mesmo aggregate saem em ordem.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private lastStats = 0;

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(EventPublisher) private readonly publisher: EventPublisher,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Failpoints) private readonly failpoints: Failpoints,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.run.outboxPublisher) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    // Gauges de lag/pendentes em timer PRÓPRIO: se o loop de publicação travar (broker lento/fora), o lag continua sendo
    // reportado — é exatamente quando a métrica mais importa.
    this.statsTimer = setInterval(() => void this.refreshStats().catch(() => undefined), 2_000);
    this.statsTimer.unref?.();
    this.logger.info('outbox publisher started', { instanceId: this.config.instanceId });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.statsTimer) clearInterval(this.statsTimer);
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (error) {
        this.logger.warn('outbox publisher tick failed', { error });
      }
      if (claimed < this.config.outbox.batchSize) await sleep(this.config.outbox.pollIntervalMs);
    }
  }

  /** Um ciclo: claim → publicar em lotes → marcar em lote. Devolve quantas linhas foram claimadas. */
  async tick(): Promise<number> {
    const { batchSize, leaseMs } = this.config.outbox;
    const instanceId = this.config.instanceId;
    const claimed = await this.uow.read((r) => r.outbox.claimDue(batchSize, instanceId, leaseMs, this.clock.now()));
    if (claimed.length === 0) return 0;

    // "Lanes" por hash do aggregate: um aggregate cai SEMPRE na mesma lane (ordem preservada dentro dela, em lotes de 10);
    // lanes diferentes publicam em paralelo.
    const lanes: OutboxMessage[][] = Array.from({ length: LANES }, () => []);
    for (const m of claimed) lanes[laneOf(m.aggregateId)]!.push(m);
    await Promise.all(lanes.filter((l) => l.length > 0).map((lane) => this.publishLane(lane, instanceId)));
    return claimed.length;
  }

  private async publishLane(lane: OutboxMessage[], instanceId: string): Promise<void> {
    const blocked = new Set<string>(); // aggregates com falha neste ciclo: o resto deles volta sem contar tentativa
    for (let i = 0; i < lane.length; i += BATCH) {
      const chunk = lane.slice(i, i + BATCH);
      const active = chunk.filter((m) => !blocked.has(m.aggregateId));
      const release = chunk.filter((m) => blocked.has(m.aggregateId)).map((m) => m.id);
      const published: OutboxMessage[] = [];

      if (active.length > 0) {
        const byId = new Map(active.map((m) => [m.id, m]));
        for (const outcome of await this.publisher.publishBatch(active)) {
          const message = byId.get(outcome.id)!;
          if (outcome.status === 'published') {
            published.push(message);
          } else if (outcome.status === 'failed') {
            blocked.add(message.aggregateId);
            message.scheduleRetry(this.clock.now());
            await this.uow.read((r) => r.outbox.scheduleRetry(message, instanceId, outcome.error ?? 'publish failed')).catch(() => undefined);
            this.metrics.outboxPublishFailed();
            this.metrics.retry('outbox-publisher');
            this.logger.warn('outbox publish failed; backing off', { eventId: message.id, eventType: message.eventType, attempts: message.attempts, error: outcome.error });
          } else {
            release.push(message.id);
          }
        }
      }

      // Ponto de falha: morrer DEPOIS de publicar e ANTES de marcar ⇒ outra instância republica (duplicata segura).
      if (published.length > 0) this.failpoints.hit('outbox.after-publish');

      if (published.length > 0) {
        const at = this.clock.now();
        published.forEach((m) => m.markPublished(at));
        const owned = await this.uow.read((r) => r.outbox.markPublished(published, instanceId));
        if (owned < published.length) this.logger.warn('outbox lease lost for some events after publishing (duplicates are possible and safe)', { lost: published.length - owned });
        for (let n = 0; n < published.length; n++) this.metrics.outboxPublished();
      }
      if (release.length > 0) await this.uow.read((r) => r.outbox.release(release, instanceId)).catch(() => undefined);
    }
  }

  /** Gauges de outbox lag/pending (no máximo a cada ~2s para não pesar no banco). */
  private async refreshStats(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStats < 1_900) return;
    this.lastStats = now;
    const stats = await this.uow.read((r) => r.outbox.stats());
    this.metrics.outboxState(stats.pending, stats.oldestOccurredAt ? Math.max(0, (now - stats.oldestOccurredAt.getTime()) / 1000) : 0);
  }
}
