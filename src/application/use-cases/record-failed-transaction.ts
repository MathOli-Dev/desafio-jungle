import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../ports/clock';
import { AppLogger, Metrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';
import { SubmitWagerTransactionCommand } from './submit-wager-transaction';
import { Money } from '@/domain/money/money';
import { uuidv7 } from '@/domain/shared/uuid';
import { FailureCode } from '@/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '@/domain/wagering/wager-transaction';

/**
 * Registra auditoria FAILED (erro permanente de infraestrutura) para uma mensagem que vai para a DLQ.
 * Melhor esforço: se a wallet não existir (FK) ou a operação já estiver registrada, não faz nada.
 */
@Injectable()
export class RecordFailedTransactionUseCase {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand, source: string): Promise<boolean> {
    const tx = WagerTransaction.create({
      id: uuidv7(), providerId: cmd.providerId, externalTransactionId: cmd.externalTransactionId, idempotencyKey: cmd.idempotencyKey,
      walletId: cmd.walletId, playerId: cmd.playerId, roundId: cmd.roundId, gameId: cmd.gameId, kind: cmd.kind as WagerTransactionKind,
      money: Money.from(cmd.money), referenceExternalTransactionId: cmd.referenceExternalTransactionId, createdAt: this.clock.now(),
    });
    tx.fail(FailureCode.InfrastructureFailure);
    const recorded = await this.uow.run(async (repos) => {
      if (!(await repos.wallets.findById(tx.walletId))) return false;
      if (await repos.transactions.findExisting(tx.providerId, tx.idempotencyKey, tx.externalTransactionId)) return false;
      return repos.transactions.insert(tx);
    });
    if (recorded) {
      this.metrics.transaction(tx.status, tx.kind, source);
      this.logger.warn('wager transaction marked FAILED', { transactionId: tx.id, failureCode: tx.failureCode });
    }
    return recorded;
  }
}
