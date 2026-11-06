import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '@/config/config';
import { Clock } from '@/application/ports/clock';
import { AppLogger } from '@/application/ports/observability';
import { UnitOfWork } from '@/application/ports/repositories';
import { ReprocessPendingReferenceUseCase } from '@/application/use-cases/reprocess-pending-reference';
import { APP_CONFIG } from '../messaging/sqs';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Worker agendado que reprocessa transações PENDING_REFERENCE devidas (backoff exponencial + limite/TTL no caso de uso). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private stopRequested = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(ReprocessPendingReferenceUseCase) private readonly reprocess: ReprocessPendingReferenceUseCase,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.run.pendingReferenceWorker) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loop = this.run();
    this.logger.info('pending-reference worker started');
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let found = 0;
      try {
        found = await this.tick();
      } catch (error) {
        this.logger.warn('pending-reference tick failed', { error });
      }
      if (found < this.config.pending.batchSize) await sleep(this.config.pending.pollIntervalMs);
    }
  }

  async tick(): Promise<number> {
    const due = await this.uow.read((r) => r.transactions.findDuePending(this.clock.now(), this.config.pending.batchSize));
    // Várias instâncias podem pegar a mesma pendência: o caso de uso relê sob o lock da wallet e ignora a já resolvida.
    for (const item of due) {
      if (this.stopRequested) break; // shutdown: não começa trabalho novo
      await this.reprocess.execute(item.id).catch((error) => this.logger.warn('reprocess pending reference failed', { transactionId: item.id, error }));
    }
    return due.length;
  }
}
