import { Injectable, LoggerService } from '@nestjs/common';
import { currentContext } from '@/application/execution-context';
import { AppLogger } from '@/application/ports/observability';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Chaves que NUNCA vão para o log (dados financeiros e segredos). Ids e códigos de erro continuam. */
const NEST_NOISE = new Set(['RouterExplorer', 'RoutesResolver', 'InstanceLoader', 'NestFactory', 'NestApplication']);
const REDACTED_KEYS = new Set(['money', 'amount', 'balance', 'balancebefore', 'balanceafter', 'payload', 'body', 'data', 'authorization', 'password', 'token', 'secret', 'cookie']);

export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message) };
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : sanitize(v, depth + 1);
  return out;
}

/**
 * Logs estruturados (uma linha JSON por evento) com os campos do contexto corrente
 * (correlationId, messageId, transactionId, walletId, providerId) via AsyncLocalStorage.
 */
@Injectable()
export class JsonLogger extends AppLogger implements LoggerService {
  constructor(
    private readonly minLevel: Level = 'info',
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    super();
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.emit('debug', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.emit('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.emit('warn', message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.emit('error', message, fields); }

  // LoggerService (logs internos do Nest)
  log(message: unknown, ...rest: unknown[]): void {
    const context = rest.find((r) => typeof r === 'string') as string | undefined;
    // ruído de bootstrap do Nest (mapeamento de rotas/módulos) fica em debug
    this.emit(context && NEST_NOISE.has(context) ? 'debug' : 'info', String(message), { context });
  }
  verbose(message: unknown): void { this.emit('debug', String(message)); }
  fatal(message: unknown): void { this.emit('error', String(message)); }

  private emit(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const line = { timestamp: new Date().toISOString(), level, message, ...currentContext(), ...(sanitize(fields) as object | undefined) };
    this.write(JSON.stringify(line));
  }
}
