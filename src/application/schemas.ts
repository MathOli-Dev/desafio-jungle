import { z } from 'zod';
import { DomainValidationError } from '@/domain/shared/errors';
import { isUuid } from '@/domain/shared/uuid';

const text = (max: number) => z.string().min(1).max(max);

export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

/** Campos de negócio de uma transação — compartilhado por HTTP (corpo) e SQS (data). OPENING não é aceito. */
export const transactionFieldsSchema = z.object({
  providerId: text(64),
  externalTransactionId: text(128),
  playerId: text(128),
  walletId: z.string().refine(isUuid, 'must be a UUID'),
  roundId: text(128),
  gameId: text(128),
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: text(128).nullish().transform((v) => v ?? undefined),
});

export const createWalletSchema = z.object({ playerId: text(128), initialBalance: moneySchema });

export const idempotencyKeySchema = text(256);

export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainValidationError('invalid payload', {
      issues: result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
