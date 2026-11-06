import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos que acompanham toda linha de log produzida dentro do contexto (HTTP request ou mensagem SQS). */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => storage.run({ ...ctx }, fn);
export const currentContext = (): LogContext => storage.getStore() ?? {};
/** Enriquece o contexto corrente (ex.: depois de descobrir o transactionId). */
export const bindContext = (fields: LogContext): void => {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
};
