# Relatório de teste de carga

> Gerado por `bun run test:load` em 2026-11-06T01:06:35.008Z. Os números abaixo são **deste ambiente**, não uma promessa de capacidade.

## Ambiente
- Bun 1.4.4 · linux 6.18.44-fc-v242 · 1 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz) · 3.9 GB RAM
- 3 instância(s) do serviço (processos locais, mesma máquina do gerador de carga, do PostgreSQL e do emulador SQS)
- Parâmetros: {"duration":15,"concurrency":32,"wallets":200,"hotDuration":10,"hotConcurrency":32,"dupRatio":0.05,"spawn":3,"eventSink":true,"report":"docs/load-test-report.md"}

## Metodologia
- Loop **fechado**: cada cliente espera a resposta antes de enviar a próxima → mede latência de serviço sob concorrência fixa; **não** modela chegadas independentes (sujeito a *coordinated omission*: sob saturação a latência real percebida por usuários seria maior).
- Fase 1 espalha operações (BET, BET, WIN, LOSS) por 200 wallets; ~5% das requisições são reenvios idênticos (mesma Idempotency-Key). Fase 2 concentra tudo em **uma** wallet (pior caso do lock por wallet).
- Cada requisição usa `externalTransactionId` único. 201/202/422 são resultados de negócio esperados; erro = 5xx ou falha de rede.
- Conflitos/retries/duplicatas = delta das métricas Prometheus de todas as instâncias; lag da outbox amostrado a cada 1 s.

## Resultados (latências em ms)
| fase | requisições | req/s | p50 | p95 | p99 | max | taxa de erro | status |
|---|---|---|---|---|---|---|---|---|
| spread (muitas wallets) | 1025 | 66.7 | 233.7 | 1242.8 | 1466.8 | 1637.1 | 0.00% | {"201":1025} |
| hot wallet (1 wallet) | 701 | 66.9 | 543.7 | 1015.7 | 1232.5 | 1460.4 | 0.00% | {"201":701} |

## Concorrência
- Conflitos de lock/versão/unique contabilizados: **0** · retries internos: **0** · duplicatas detectadas (idempotência): **87**
- 503 (falha transitória, reenviável): spread 0, hot wallet 0
- Erros de rede (amostras): spread [], hot wallet []

## Outbox
- Lag máximo observado: **107.7 s** · pendentes (máx.): **3113** · eventos publicados durante a rodada: **1098**
- Após o fim da carga a outbox NÃO drenou em **90.4 s**.
- Consumidor downstream simulado (sink): ligado — 220 eventos consumidos.

## Integridade
- 201 wallets reconciliadas pela API; **0** inconsistentes (esperado: 0).

## Leitura honesta
- Gerador de carga, 3 instâncias, PostgreSQL e emulador SQS competem pelos mesmos 1 vCPU: o gargalo medido é a máquina, não necessariamente o desenho. Em hardware dedicado (e com PostgreSQL separado) o teto sobe.
- Na fase de wallet quente o throughput é limitado pela **serialização intencional** por wallet (lock pessimista): é o preço da correção; a latência cresce com a fila de espera no lock, e `DB_LOCK_TIMEOUT_MS` limita essa espera (excedido ⇒ 503 reenviável, nunca saldo incorreto).
- **Outbox/emulador**: o lag da outbox neste ambiente **não** é do desenho do publisher. Medido isoladamente (publisher nulo, 5000 eventos), o caminho claim + marcação em lote no PostgreSQL processa ~4950 eventos/s; já o `SendMessage` no emulador SQS (moto, single-thread) custa ~7 ms com a fila vazia e ~18 ms/entrada com 300+ mensagens (a dedup FIFO do emulador é O(profundidade)), e ele disputa o mesmo vCPU com a API, o PostgreSQL e o gerador de carga. O consumidor simulado (`LOAD_EVENT_SINK`) reduz a pressão mas **não elimina** o efeito. Em SQS real (envio O(1), com rede e CPU dedicados) espera-se lag bem menor; isso **não foi medido aqui** e não deve ser lido como resultado.
- O objetivo do experimento é mostrar **correção sob carga** (0 inconsistências, nenhum saldo negativo, idempotência sob duplicatas) e onde o sistema degrada — não bater um RPS-alvo.
