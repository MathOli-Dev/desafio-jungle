import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { currentContext } from '@/application/execution-context';
import { ProviderIdentityPort } from '@/application/ports/provider-identity';
import { idempotencyKeySchema, parseWith, transactionFieldsSchema } from '@/application/schemas';
import { TransactionQueries } from '@/application/use-cases/queries';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { DomainValidationError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { httpStatusFor, presentSubmission } from './presenters';
import { parseUuid } from './wallets.controller';

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(TransactionQueries) private readonly queries: TransactionQueries,
    @Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) throw new DomainValidationError('Idempotency-Key header is required', { field: 'Idempotency-Key' });
    const key = parseWith(idempotencyKeySchema, idempotencyKey);
    const fields = parseWith(transactionFieldsSchema, body);
    this.identity.assertCanActFor(undefined, fields.providerId);

    const result = await this.submit.execute(
      { idempotencyKey: key, ...fields },
      { source: 'http', correlationId: currentContext().correlationId ?? uuidv7() },
    );
    res.status(httpStatusFor(result.status));
    if (result.idempotentReplay) res.setHeader('Idempotent-Replayed', 'true');
    return presentSubmission(result);
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.queries.getById(parseUuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
