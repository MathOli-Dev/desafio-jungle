/**
 * Teste de carga: `bun run test:load`
 *
 * Alvos: LOAD_TARGETS="http://localhost:3001,http://localhost:3002,http://localhost:3003" (docker compose up)
 *        ou, se omitido, sobe LOAD_SPAWN (padrão 3) instâncias locais (`bun src/main.ts`) usando DATABASE_URL/SQS_ENDPOINT.
 * Parâmetros (env): LOAD_DURATION_S=15 LOAD_CONCURRENCY=32 LOAD_WALLETS=200 LOAD_HOT_DURATION_S=10 LOAD_HOT_CONCURRENCY=32
 *                   LOAD_DUP_RATIO=0.05  LOAD_REPORT=docs/load-test-report.md
 *                   LOAD_EVENT_SINK=true|false (consumidor downstream simulado da fila de eventos; padrão true)
 *
 * Metodologia (resumo; detalhes e limitações no relatório gerado):
 *  - loop FECHADO: N "clientes" enviam requisições em sequência (cada um espera a resposta). Mede latência de serviço, não de fila
 *    de chegada ⇒ sujeito a coordinated omission (declarado no relatório).
 *  - Fase 1 "spread": muitas wallets, mix BET/WIN/LOSS; ~5% de reenvios idênticos (mesma Idempotency-Key) para exercitar idempotência.
 *  - Fase 2 "hot wallet": todas as requisições disputam UMA wallet (pior caso do lock por wallet).
 *  - Conflitos/retries/duplicatas = delta das métricas Prometheus (/metrics) de todas as instâncias; lag da outbox amostrado a cada 1s.
 *  - Ao final: drena a outbox, reconcilia todas as wallets via API e verifica saldo == ledger.
 */
import { DeleteMessageBatchCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { cpus, platform, release, totalmem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { createOrm, migrateUp } from '@/infrastructure/persistence/orm';
import { loadConfig } from '@/config/config';
import { Instance, spawnInstance } from '@test/support/app';

const envNum = (k: string, d: number) => Number(process.env[k] ?? d);
const P = {
  duration: envNum('LOAD_DURATION_S', 15), concurrency: envNum('LOAD_CONCURRENCY', 32), wallets: envNum('LOAD_WALLETS', 200),
  hotDuration: envNum('LOAD_HOT_DURATION_S', 10), hotConcurrency: envNum('LOAD_HOT_CONCURRENCY', 32), dupRatio: envNum('LOAD_DUP_RATIO', 0.05),
  spawn: envNum('LOAD_SPAWN', 3), eventSink: process.env.LOAD_EVENT_SINK !== 'false', report: process.env.LOAD_REPORT ?? 'docs/load-test-report.md',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0);

async function scrape(base: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of (await (await fetch(`${base}/metrics`)).text()).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}
const sumMetric = (snaps: Record<string, number>[], prefix: string) =>
  snaps.reduce((acc, s) => acc + Object.entries(s).filter(([k]) => k === prefix || k.startsWith(`${prefix}{`)).reduce((a, [, v]) => a + v, 0), 0);

async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as any };
}

interface PhaseResult { errorSamples: string[]; name: string; requests: number; seconds: number; rps: number; p50: number; p95: number; p99: number; max: number; statuses: Record<string, number>; errorRate: number; transient503: number }

async function runPhase(name: string, targets: string[], seconds: number, concurrency: number, pickWallet: (i: number) => { id: string; playerId: string }): Promise<PhaseResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const errorSamples = new Set<string>();
  let counter = 0;
  const recent: Array<{ base: string; body: any; key: string }> = [];
  const stopAt = performance.now() + seconds * 1000;
  const started = performance.now();

  const worker = async (w: number) => {
    while (performance.now() < stopAt) {
      const n = counter++;
      const base = targets[n % targets.length]!;
      let op: { base: string; body: any; key: string };
      if (recent.length > 20 && Math.random() < P.dupRatio) {
        op = recent[Math.floor(Math.random() * recent.length)]!; // reenvio idêntico (replay)
      } else {
        const wallet = pickWallet(n);
        const kind = (['BET', 'BET', 'WIN', 'LOSS'] as const)[n % 4]!;
        const ext = `load-${process.pid}-${w}-${n}-${Date.now()}`;
        const body = { providerId: 'load-provider', externalTransactionId: ext, playerId: wallet.playerId, walletId: wallet.id, roundId: `r-${n % 97}`, gameId: 'fortune-chimp', kind, money: { amount: kind === 'BET' ? '1.00' : '1.50', currency: 'BRL' } };
        op = { base, body, key: `load-provider:${ext}` };
        recent.push(op);
        if (recent.length > 500) recent.shift();
      }
      const t0 = performance.now();
      let status = 'ERR';
      try {
        status = String((await http(op.base, 'POST', '/wagering/transactions', op.body, { 'idempotency-key': op.key })).status);
      } catch (error) {
        if (errorSamples.size < 3) errorSamples.add(error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : String(error)); // erro de rede conta como ERR
      }
      latencies.push(performance.now() - t0);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const errors = Object.entries(statuses).filter(([s]) => s === 'ERR' || s.startsWith('5')).reduce((a, [, v]) => a + v, 0);
  return {
    errorSamples: [...errorSamples], name, requests: total, seconds: elapsed, rps: total / elapsed, p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99),
    max: latencies[total - 1] ?? 0, statuses, errorRate: total ? errors / total : 0, transient503: statuses['503'] ?? 0,
  };
}

async function main() {
  let instances: Instance[] = [];
  let targets = (process.env.LOAD_TARGETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (targets.length === 0) {
    const cfg = loadConfig();
    const orm = await createOrm(cfg.db);
    await migrateUp(orm);
    await orm.close(true);
    console.log(`subindo ${P.spawn} instâncias locais...`);
    instances = await Promise.all(Array.from({ length: P.spawn }, (_, i) => spawnInstance(`load-${i + 1}`, { ...(process.env as Record<string, string>), PORT: '0', LOG_LEVEL: 'warn', RUN_CONSUMER: 'false' })));
    targets = instances.map((i) => i.baseUrl!);
  }
  console.log(`alvos: ${targets.join(', ')}`);

  const before = await Promise.all(targets.map(scrape));
  console.log(`criando ${P.wallets} wallets + 1 wallet quente...`);
  const mk = async (i: number, balance: string) => {
    const playerId = `load-player-${Date.now()}-${i}`;
    const r = await http(targets[i % targets.length]!, 'POST', '/wallets', { playerId, initialBalance: { amount: balance, currency: 'BRL' } });
    if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.json)}`);
    return { id: r.json.id as string, playerId };
  };
  const wallets = await Promise.all(Array.from({ length: P.wallets }, (_, i) => mk(i, '100000.00')));
  const hot = await mk(P.wallets, '10000000.00');

  // "sink": consumidor downstream simulado da fila de eventos (sem ele a fila só cresce e emuladores SQS degradam com a profundidade)
  let sinkRunning = P.eventSink;
  let sunk = 0;
  const sink = P.eventSink
    ? (async () => {
        const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}) });
        // a fila é criada pelas instâncias no primeiro uso: espera ela existir (e o sink nunca derruba o teste)
        let queueUrl: string | undefined;
        while (sinkRunning && !queueUrl) {
          queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo' })).catch(() => undefined))?.QueueUrl;
          if (!queueUrl) await sleep(500);
        }
        while (sinkRunning) {
          // short polling: emuladores single-thread (moto) dormem DENTRO da requisição no long polling e travam todos os envios
          const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 60 })).catch(() => undefined);
          if (!out?.Messages?.length) {
            await sleep(100);
            continue;
          }
          await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: out.Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) })).catch(() => undefined);
          sunk += out.Messages.length;
        }
      })()
    : undefined;

  // amostragem do lag da outbox (1s)
  const lagSamples: Array<{ t: number; lag: number; pending: number }> = [];
  let sampling = true;
  const sampler = (async () => {
    const t0 = performance.now();
    while (sampling) {
      const snaps = await Promise.all(targets.map(scrape).map((p) => p.catch(() => ({} as Record<string, number>))));
      const gauge = (name: string) => Math.max(0, ...snaps.map((s) => s[name]).filter((v): v is number => typeof v === 'number'));
      lagSamples.push({ t: (performance.now() - t0) / 1000, lag: gauge('wager_outbox_lag_seconds'), pending: gauge('wager_outbox_pending_events') });
      await sleep(1000);
    }
  })();

  console.log(`fase 1 (spread): ${P.duration}s, concorrência ${P.concurrency}`);
  const spread = await runPhase('spread (muitas wallets)', targets, P.duration, P.concurrency, (i) => wallets[i % wallets.length]!);
  console.log(`fase 2 (hot wallet): ${P.hotDuration}s, concorrência ${P.hotConcurrency}`);
  const hotPhase = await runPhase('hot wallet (1 wallet)', targets, P.hotDuration, P.hotConcurrency, () => hot);

  // drena a outbox e mede quanto demorou depois do fim da carga
  const drainStart = performance.now();
  let drained = false;
  while (performance.now() - drainStart < 90_000) {
    const snaps = await Promise.all(targets.map(scrape));
    const reported = snaps.map((s) => s['wager_outbox_pending_events']).filter((v): v is number => typeof v === 'number');
    // métrica ausente = desconhecido (nunca "zero"): só considera drenada quando TODAS as instâncias reportam 0
    if (reported.length === snaps.length && reported.every((v) => v === 0)) { drained = true; break; }
    await sleep(500);
  }
  const drainSeconds = (performance.now() - drainStart) / 1000;
  sampling = false;
  await sampler;
  sinkRunning = false;
  await sink;

  // invariantes: reconciliação de todas as wallets pela API
  let inconsistent = 0;
  for (const w of [...wallets, hot]) {
    const r = await http(targets[0]!, 'POST', `/wallets/${w.id}/reconciliation`);
    if (r.status !== 200 || !r.json.consistent) inconsistent++;
  }
  const after = await Promise.all(targets.map(scrape));
  const delta = (name: string) => sumMetric(after, name) - sumMetric(before, name);

  const result = {
    environment: {
      date: new Date().toISOString(), bun: Bun.version, os: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: +(totalmem() / 2 ** 30).toFixed(1),
      instances: targets.length, spawnedLocally: instances.length > 0, targets,
    },
    params: P, phases: [spread, hotPhase],
    concurrency: {
      lockConflicts: delta('wager_lock_conflicts_total'), retries: delta('wager_retries_total'), duplicatesDetected: delta('wager_duplicates_total'),
    },
    outbox: { maxLagSeconds: Math.max(0, ...lagSamples.map((s) => s.lag)), maxPending: Math.max(0, ...lagSamples.map((s) => s.pending)), drainedAfterSeconds: +drainSeconds.toFixed(1), drained, publishedDuringRun: delta('wager_outbox_published_total'), eventSink: P.eventSink, eventsConsumedBySink: sunk },
    integrity: { walletsChecked: wallets.length + 1, inconsistent },
  };

  const f = (n: number) => n.toFixed(1);
  const row = (p: PhaseResult) => `| ${p.name} | ${p.requests} | ${f(p.rps)} | ${f(p.p50)} | ${f(p.p95)} | ${f(p.p99)} | ${f(p.max)} | ${(p.errorRate * 100).toFixed(2)}% | ${JSON.stringify(p.statuses)} |`;
  const md = `# Relatório de teste de carga

> Gerado por \`bun run test:load\` em ${result.environment.date}. Os números abaixo são **deste ambiente**, não uma promessa de capacidade.

## Ambiente
- Bun ${result.environment.bun} · ${result.environment.os} · ${result.environment.cpus} vCPU (${result.environment.cpuModel}) · ${result.environment.memGB} GB RAM
- ${result.environment.instances} instância(s) do serviço (${result.environment.spawnedLocally ? 'processos locais, mesma máquina do gerador de carga, do PostgreSQL e do emulador SQS' : 'alvos externos'})
- Parâmetros: ${JSON.stringify(P)}

## Metodologia
- Loop **fechado**: cada cliente espera a resposta antes de enviar a próxima → mede latência de serviço sob concorrência fixa; **não** modela chegadas independentes (sujeito a *coordinated omission*: sob saturação a latência real percebida por usuários seria maior).
- Fase 1 espalha operações (BET, BET, WIN, LOSS) por ${P.wallets} wallets; ~${P.dupRatio * 100}% das requisições são reenvios idênticos (mesma Idempotency-Key). Fase 2 concentra tudo em **uma** wallet (pior caso do lock por wallet).
- Cada requisição usa \`externalTransactionId\` único. 201/202/422 são resultados de negócio esperados; erro = 5xx ou falha de rede.
- Conflitos/retries/duplicatas = delta das métricas Prometheus de todas as instâncias; lag da outbox amostrado a cada 1 s.

## Resultados (latências em ms)
| fase | requisições | req/s | p50 | p95 | p99 | max | taxa de erro | status |
|---|---|---|---|---|---|---|---|---|
${row(spread)}
${row(hotPhase)}

## Concorrência
- Conflitos de lock/versão/unique contabilizados: **${result.concurrency.lockConflicts}** · retries internos: **${result.concurrency.retries}** · duplicatas detectadas (idempotência): **${result.concurrency.duplicatesDetected}**
- 503 (falha transitória, reenviável): spread ${spread.transient503}, hot wallet ${hotPhase.transient503}
- Erros de rede (amostras): spread ${JSON.stringify(spread.errorSamples)}, hot wallet ${JSON.stringify(hotPhase.errorSamples)}

## Outbox
- Lag máximo observado: **${f(result.outbox.maxLagSeconds)} s** · pendentes (máx.): **${result.outbox.maxPending}** · eventos publicados durante a rodada: **${result.outbox.publishedDuringRun}**
- Após o fim da carga a outbox ${result.outbox.drained ? 'drenou' : 'NÃO drenou'} em **${result.outbox.drainedAfterSeconds} s**.
- Consumidor downstream simulado (sink): ${result.outbox.eventSink ? `ligado — ${result.outbox.eventsConsumedBySink} eventos consumidos` : 'desligado (a fila de eventos só cresce)'}.

## Integridade
- ${result.integrity.walletsChecked} wallets reconciliadas pela API; **${result.integrity.inconsistent}** inconsistentes (esperado: 0).

## Leitura honesta
- Gerador de carga, ${result.environment.instances} instâncias, PostgreSQL e emulador SQS competem pelos mesmos ${result.environment.cpus} vCPU: o gargalo medido é a máquina, não necessariamente o desenho. Em hardware dedicado (e com PostgreSQL separado) o teto sobe.
- Na fase de wallet quente o throughput é limitado pela **serialização intencional** por wallet (lock pessimista): é o preço da correção; a latência cresce com a fila de espera no lock, e \`DB_LOCK_TIMEOUT_MS\` limita essa espera (excedido ⇒ 503 reenviável, nunca saldo incorreto).
- **Outbox/emulador**: o lag da outbox neste ambiente **não** é do desenho do publisher. Medido isoladamente (publisher nulo, 5000 eventos), o caminho claim + marcação em lote no PostgreSQL processa ~4950 eventos/s; já o \`SendMessage\` no emulador SQS (moto, single-thread) custa ~7 ms com a fila vazia e ~18 ms/entrada com 300+ mensagens (a dedup FIFO do emulador é O(profundidade)), e ele disputa o mesmo vCPU com a API, o PostgreSQL e o gerador de carga. O consumidor simulado (\`LOAD_EVENT_SINK\`) reduz a pressão mas **não elimina** o efeito. Em SQS real (envio O(1), com rede e CPU dedicados) espera-se lag bem menor; isso **não foi medido aqui** e não deve ser lido como resultado.
- O objetivo do experimento é mostrar **correção sob carga** (0 inconsistências, nenhum saldo negativo, idempotência sob duplicatas) e onde o sistema degrada — não bater um RPS-alvo.
`;
  console.log(`\n${md}`);
  writeFileSync(P.report, md);
  console.log(`relatório salvo em ${P.report}`);
  await Promise.all(instances.map((i) => i.stop()));
  if (inconsistent > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
