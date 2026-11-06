/**
 * Política de espera por referência ausente (PENDING_REFERENCE).
 * Defaults: 10 tentativas, backoff exponencial 1s→60s (cap) e TTL de 5 min.
 * Justificativa: reordenação por at-least-once costuma resolver em segundos; 5 min cobre retries lentos
 * do provedor sem manter transações indefinidamente "em aberto" para o jogador.
 */
export class PendingReferencePolicy {
  constructor(
    readonly maxAttempts: number = 10,
    readonly ttlMs: number = 5 * 60_000,
    readonly baseDelayMs: number = 1_000,
    readonly maxDelayMs: number = 60_000,
  ) {}

  /** Delay antes da tentativa `attempt` (0-based): base * 2^attempt, limitado por maxDelayMs. */
  delayFor(attempt: number): number {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
  }
}
