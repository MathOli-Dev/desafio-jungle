import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '@/application/execution-context';
import { AppLogger } from '@/application/ports/observability';
import { uuidv7 } from '@/domain/shared/uuid';
import { PrometheusMetrics } from '@/infrastructure/observability/prometheus-metrics';

const SAFE_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

/**
 * Correlation ID (header X-Correlation-Id ou gerado) propagado por AsyncLocalStorage para todos os logs,
 * mais log estruturado + métricas HTTP por requisição. Nunca loga corpo/headers (sem payload financeiro).
 */
export function httpObservability(logger: AppLogger, metrics: PrometheusMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
    res.setHeader('X-Correlation-Id', correlationId);
    const started = performance.now();
    res.on('finish', () => {
      const seconds = (performance.now() - started) / 1000;
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      metrics.observeHttp(req.method, route, res.statusCode, seconds);
      if (route !== '/health/live' && route !== '/health/ready' && route !== '/metrics') {
        logger.info('http request completed', { correlationId, method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds * 1000) });
      }
    });
    runWithContext({ correlationId }, () => next());
  };
}
