import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createWalletSchema, parseWith } from '@/application/schemas';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { WalletQueries } from '@/application/use-cases/queries';
import { currentContext } from '@/application/execution-context';
import { DomainValidationError } from '@/domain/shared/errors';
import { isUuid, uuidv7 } from '@/domain/shared/uuid';

export const parseUuid = (value: string, field: string): string => {
  if (!isUuid(value)) throw new DomainValidationError(`${field} must be a UUID`, { field });
  return value;
};

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseWith(createWalletSchema, body);
    const wallet = await this.createWallet.execute(input, { correlationId: currentContext().correlationId ?? uuidv7() });
    res.status(201);
    return wallet;
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(parseUuid(walletId, 'walletId'));
  }

  /** Cursor estável e opaco; ordem crescente de walletVersion (ledger append-only). */
  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.queries.listLedger(parseUuid(walletId, 'walletId'), cursor || undefined, limit === undefined ? 50 : Number(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(parseUuid(walletId, 'walletId'));
  }
}
