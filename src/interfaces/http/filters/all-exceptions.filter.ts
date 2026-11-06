import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermanentInfrastructureError, TransientInfrastructureError } from '@/application/errors';
import { currentContext } from '@/application/execution-context';
import { AppLogger } from '@/application/ports/observability';
import {
  CurrencyMismatchError, DomainError, DomainValidationError, IdempotencyConflictError, InvalidMoneyError,
  TransactionNotFoundError, WalletAlreadyExistsError, WalletNotFoundError,
} from '@/domain/shared/errors';

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; correlationId?: string; details?: unknown };
}

/**
 * Contrato ÚNICO de erro para todos os endpoints. Status HTTP distintos para situações distintas:
 *   400 payload inválido            → corrigir e reenviar (não reenviar igual)
 *   409 conflito (idempotência / wallet duplicada)
 *   422 rejeição por regra de negócio (corpo = transação REJECTED com failureCode) — emitido pelo controller
 *   202 aceito com processamento pendente (PENDING_REFERENCE)              — emitido pelo controller
 *   404 não encontrado
 *   503 falha TRANSITÓRIA de infraestrutura (+ Retry-After) → reenviar o MESMO pedido é seguro (idempotente)
 *   500 erro interno/permanente
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const mapped = this.map(exception);
    const correlationId = currentContext().correlationId ?? (res.getHeader('X-Correlation-Id') as string | undefined);

    if (mapped.status >= 500) {
      this.logger.error('request failed', { method: req.method, path: req.route?.path, status: mapped.status, code: mapped.code, error: exception });
    } else {
      this.logger.warn('request rejected', { method: req.method, path: req.route?.path, status: mapped.status, code: mapped.code });
    }
    if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
    const body: ErrorBody = {
      error: {
        code: mapped.code, message: mapped.message, retryable: mapped.retryable,
        ...(correlationId ? { correlationId } : {}), ...(mapped.details ? { details: mapped.details } : {}),
      },
    };
    res.status(mapped.status).json(body);
  }

  private map(e: unknown): { status: number; code: string; message: string; retryable: boolean; details?: unknown; retryAfter?: number } {
    if (e instanceof DomainValidationError || e instanceof InvalidMoneyError) {
      return { status: 400, code: 'VALIDATION_ERROR', message: e.message, retryable: false, details: e.details };
    }
    if (e instanceof IdempotencyConflictError) return { status: 409, code: e.code, message: e.message, retryable: false, details: e.details };
    if (e instanceof WalletAlreadyExistsError) return { status: 409, code: e.code, message: e.message, retryable: false, details: e.details };
    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) return { status: 404, code: e.code, message: e.message, retryable: false };
    if (e instanceof CurrencyMismatchError) return { status: 422, code: e.code, message: e.message, retryable: false, details: e.details };
    if (e instanceof TransientInfrastructureError) {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'temporary infrastructure failure; retrying the same request is safe', retryable: true, retryAfter: 1, details: { reason: e.kind } };
    }
    if (e instanceof PermanentInfrastructureError) return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false };
    if (e instanceof DomainError) return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false };

    // HttpException do Nest e erros de middleware (body-parser: JSON quebrado, corpo grande...)
    const status = e instanceof HttpException ? e.getStatus() : this.statusOf(e);
    if (status && status < 500) {
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : status === 405 ? 'METHOD_NOT_ALLOWED' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'HTTP_ERROR';
      const message = status === 400 ? 'malformed request' : status === 404 ? 'resource not found' : e instanceof Error ? e.message : 'request error';
      return { status, code, message, retryable: false };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false };
  }

  private statusOf(e: unknown): number | undefined {
    const status = (e as { status?: unknown; statusCode?: unknown } | undefined)?.status ?? (e as { statusCode?: unknown } | undefined)?.statusCode;
    return typeof status === 'number' && status >= 400 && status < 600 ? status : undefined;
  }
}
