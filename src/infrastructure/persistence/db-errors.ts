import { DomainError } from '@/domain/shared/errors';
import { PermanentInfrastructureError, TransientInfrastructureError, TransientKind } from '@/application/errors';

const CONNECTION_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const CONNECTION_MESSAGES = ['connection terminated', 'timeout exceeded when trying to connect', 'connection error', 'client has encountered', 'unable to acquire a connection', 'knex: timeout acquiring a connection'];

function transient(kind: TransientKind, err: unknown): TransientInfrastructureError {
  const message = err instanceof Error ? err.message : String(err);
  return new TransientInfrastructureError(`transient database failure (${kind}): ${message}`, kind, err);
}

/**
 * Traduz erros do driver (pg → MikroORM) para a taxonomia da aplicação:
 *  - transitórios (lock timeout, deadlock, serialização, conexão, timeout, unique race) → TransientInfrastructureError;
 *  - violações de integridade do schema (CHECK/FK/triggers) → PermanentInfrastructureError (é bug, não adianta repetir);
 *  - o resto passa intacto.
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof DomainError || err instanceof TransientInfrastructureError || err instanceof PermanentInfrastructureError) return err;
  const e = err as { code?: string; message?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  const message = (e?.message ?? '').toLowerCase();

  if (code === '55P03') return transient('LOCK_TIMEOUT', err);
  if (code === '40P01') return transient('DEADLOCK', err);
  if (code === '40001') return transient('SERIALIZATION', err);
  if (code === '57014') return transient('TIMEOUT', err);
  if (code === '23505') return transient('UNIQUE_CONFLICT', err);
  if (code && (code.startsWith('08') || ['53300', '57P01', '57P02', '57P03', '53000', '53100', '53200'].includes(code))) {
    return transient('CONNECTION', err);
  }
  if (code && CONNECTION_NODE_CODES.has(code)) return transient('CONNECTION', err);
  if (CONNECTION_MESSAGES.some((m) => message.includes(m))) return transient('CONNECTION', err);
  if (code && code.startsWith('23')) {
    return new PermanentInfrastructureError(`database integrity violation (${code}): ${e?.message ?? ''}`, 'INTEGRITY_VIOLATION', err);
  }
  return err;
}
