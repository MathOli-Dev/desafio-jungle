import { OutboxMessage } from '@/domain/messaging/outbox-message';

export interface PublishOutcome {
  id: string;
  /** published: o broker aceitou · failed: erro (vai para backoff) · skipped: não tentada (devolver sem contar tentativa). */
  status: 'published' | 'failed' | 'skipped';
  error?: string;
}

/** Porta de saída do publisher da outbox (adaptador: SQS). */
export abstract class EventPublisher {
  /** Publica UMA mensagem. Deve lançar em caso de falha. */
  abstract publish(message: OutboxMessage): Promise<void>;

  /**
   * Publica um lote (≤ 10) SEM lançar: devolve o resultado por mensagem. A implementação padrão publica uma a uma, em ordem,
   * e depois da primeira falha de um aggregate NÃO tenta as seguintes do mesmo aggregate (preserva a ordem do aggregate).
   * Adaptadores com API de lote (SQS SendMessageBatch) sobrescrevem para reduzir round-trips.
   */
  async publishBatch(messages: OutboxMessage[]): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    const blocked = new Set<string>();
    for (const m of messages) {
      if (blocked.has(m.aggregateId)) {
        outcomes.push({ id: m.id, status: 'skipped' });
        continue;
      }
      try {
        await this.publish(m);
        outcomes.push({ id: m.id, status: 'published' });
      } catch (error) {
        blocked.add(m.aggregateId);
        outcomes.push({ id: m.id, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }
}
