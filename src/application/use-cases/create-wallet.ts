import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../ports/clock';
import { AppLogger } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';
import { persistProcessed } from './support';
import { Money, MoneyProps } from '@/domain/money/money';
import { WalletAlreadyExistsError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { bindContext } from '../execution-context';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (w: Wallet): WalletView => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version });

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * Cria a wallet e, quando o saldo inicial é > 0, a transação interna OPENING + lançamento CREDIT + eventos
   * na MESMA transação SQL. (playerId, currency) duplicado ⇒ WalletAlreadyExistsError (409).
   */
  async execute(cmd: { playerId: string; initialBalance: MoneyProps }, ctx: { correlationId: string }): Promise<WalletView> {
    const now = this.clock.now();
    const wallet = Wallet.open({ id: uuidv7(), playerId: cmd.playerId, initialBalance: Money.from(cmd.initialBalance), now });
    bindContext({ walletId: wallet.id });

    await this.uow.run(async (repos) => {
      if (!(await repos.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError('a wallet already exists for this player and currency', { playerId: cmd.playerId, currency: wallet.currency });
      }
      const opening = wallet.openingEntry({ entryId: uuidv7(), transactionId: uuidv7(), at: now });
      if (!opening) return;
      const tx = WagerTransaction.opening({ id: opening.transactionId, walletId: wallet.id, playerId: wallet.playerId, money: wallet.balance, createdAt: now });
      tx.markProcessed(now, wallet.balance);
      await persistProcessed(repos, {
        tx, wallet, expectedVersion: wallet.version, entry: opening, isNew: true, persistWallet: false,
        eventCtx: { correlationId: ctx.correlationId, causationId: wallet.id, occurredAt: now },
      });
    });
    this.logger.info('wallet created', { walletId: wallet.id, currency: wallet.currency });
    return toWalletView(wallet);
  }
}
