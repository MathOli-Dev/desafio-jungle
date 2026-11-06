import { SubmissionResult } from '@/application/use-cases/support';
import { FAILURE_CODE_INFO } from '@/domain/wagering/failure-code';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';

/** Mapeamento ÚNICO resultado → HTTP: PROCESSED 201 · PENDING_REFERENCE 202 · REJECTED/FAILED 422 (resultado terminal, não aplicado). */
export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    default:
      return 422;
  }
}

export function presentSubmission(r: SubmissionResult) {
  return {
    transactionId: r.transactionId,
    status: r.status,
    ...(r.balance ? { balance: r.balance } : {}),
    ...(r.failureCode ? { failureCode: r.failureCode, failureAction: FAILURE_CODE_INFO[r.failureCode].providerAction } : {}),
    idempotentReplay: r.idempotentReplay,
  };
}
