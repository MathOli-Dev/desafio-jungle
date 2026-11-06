/**
 * Injeção de falhas para testes de caos (kill -9 em pontos exatos do fluxo). Desligada por padrão e NUNCA ativa em
 * produção (a config força `enabled=false` quando NODE_ENV=production).
 * Spec: "nome:acao[,nome:acao]" — ex.: "consumer.after-commit:kill". Ações: kill (SIGKILL, sem cleanup) | throw | throw-once.
 */
export class Failpoints {
  private readonly actions = new Map<string, 'kill' | 'throw' | 'throw-once'>();

  constructor(
    private readonly enabled: boolean = false,
    spec: string = '',
  ) {
    if (!enabled) return;
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [name, action = 'kill'] = part.split(':') as [string, string?];
      this.actions.set(name, action === 'throw' || action === 'throw-once' ? action : 'kill');
    }
  }

  hit(name: string): void {
    const action = this.enabled ? this.actions.get(name) : undefined;
    if (action === 'kill') process.kill(process.pid, 'SIGKILL');
    if (action === 'throw') throw new Error(`failpoint ${name}`);
    if (action === 'throw-once') {
      this.actions.delete(name);
      throw new Error(`failpoint ${name}`);
    }
  }
}
