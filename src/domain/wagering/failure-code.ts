/**
 * Taxonomia estável de `failureCode`. Cada código diz ao provedor o que fazer:
 *  - FINAL                : resultado definitivo; não reenviar.
 *  - NEW_ID_IF_CHANGED    : só vale reenviar com NOVO externalTransactionId se a condição mudar
 *                           (ex.: jogador depositou; a referência finalmente chegou).
 *  - FIX_PAYLOAD_NEW_ID   : payload inconsistente; corrigir e enviar com NOVO externalTransactionId.
 * Reenviar o MESMO externalTransactionId/Idempotency-Key sempre devolve o resultado original (replay).
 */
export enum FailureCode {
  /** BET maior que o saldo. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão (ROLLBACK de WIN/REFUND) deixaria o saldo negativo. Distinto de INSUFFICIENT_FUNDS. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da operação difere da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId não é o dono da wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Referência não apareceu dentro do limite de tentativas/TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas não foi aplicada (REJECTED/FAILED, ou ainda pendente ao esgotar o limite). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência pertence a outro provider/player/wallet/moeda/rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo da referência incompatível (REFUND só referencia BET; ROLLBACK: BET, WIN ou REFUND). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Valor da reversão difere do valor da referência (reversão parcial fora de escopo). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida (REFUND ou ROLLBACK PROCESSED). */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Erro permanente de infraestrutura (status FAILED, auditável). */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export type ProviderAction = 'FINAL' | 'NEW_ID_IF_CHANGED' | 'FIX_PAYLOAD_NEW_ID';

export const FAILURE_CODE_INFO: Readonly<
  Record<FailureCode, { category: 'BUSINESS' | 'INFRASTRUCTURE'; providerAction: ProviderAction; description: string }>
> = {
  [FailureCode.InsufficientFunds]: { category: 'BUSINESS', providerAction: 'NEW_ID_IF_CHANGED', description: 'Saldo insuficiente para a aposta.' },
  [FailureCode.ReversalWouldOverdraw]: { category: 'BUSINESS', providerAction: 'NEW_ID_IF_CHANGED', description: 'A reversão deixaria o saldo negativo.' },
  [FailureCode.CurrencyMismatch]: { category: 'BUSINESS', providerAction: 'FIX_PAYLOAD_NEW_ID', description: 'Moeda diferente da moeda da wallet.' },
  [FailureCode.PlayerWalletMismatch]: { category: 'BUSINESS', providerAction: 'FIX_PAYLOAD_NEW_ID', description: 'playerId não corresponde à wallet.' },
  [FailureCode.ReferenceNotFound]: { category: 'BUSINESS', providerAction: 'NEW_ID_IF_CHANGED', description: 'Transação referenciada não encontrada no prazo.' },
  [FailureCode.ReferenceNotProcessed]: { category: 'BUSINESS', providerAction: 'FINAL', description: 'Transação referenciada não foi aplicada.' },
  [FailureCode.ReferenceMismatch]: { category: 'BUSINESS', providerAction: 'FIX_PAYLOAD_NEW_ID', description: 'Referência de outro provider/player/wallet/moeda/rodada.' },
  [FailureCode.InvalidReferenceKind]: { category: 'BUSINESS', providerAction: 'FIX_PAYLOAD_NEW_ID', description: 'Tipo da transação referenciada incompatível.' },
  [FailureCode.ReferenceAmountMismatch]: { category: 'BUSINESS', providerAction: 'FIX_PAYLOAD_NEW_ID', description: 'Valor difere do valor da referência.' },
  [FailureCode.AlreadyReversed]: { category: 'BUSINESS', providerAction: 'FINAL', description: 'A referência já foi revertida.' },
  [FailureCode.InfrastructureFailure]: { category: 'INFRASTRUCTURE', providerAction: 'NEW_ID_IF_CHANGED', description: 'Falha permanente de infraestrutura; operação não aplicada.' },
};
