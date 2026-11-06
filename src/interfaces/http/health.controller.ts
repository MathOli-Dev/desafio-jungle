import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Metrics } from '@/application/ports/observability';
import { ORM } from '@/infrastructure/persistence/orm';
import type { Orm } from '@/infrastructure/persistence/orm';
import { SqsQueues } from '@/infrastructure/messaging/sqs';
import { PrometheusMetrics } from '@/infrastructure/observability/prometheus-metrics';
import { Public } from './auth/auth';

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Health: abertos (sem autenticação). live = processo vivo; ready = PostgreSQL e SQS alcançáveis. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: Orm,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [pg, sqs] = await Promise.allSettled([
      withTimeout(this.orm.em.fork().execute('select 1'), 2_000),
      withTimeout(this.queues.ping(), 2_000),
    ]);
    const checks = { postgres: pg.status === 'fulfilled' ? 'up' : 'down', sqs: sqs.status === 'fulfilled' ? 'up' : 'down' };
    const ok = checks.postgres === 'up' && checks.sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}

@Public()
@Controller()
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.type(this.metrics.registry.contentType).send(await this.metrics.render());
  }
}
