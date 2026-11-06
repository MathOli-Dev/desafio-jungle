# Wager Ledger Service

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de múltiplos provedores, com foco em **correção financeira, concorrência entre instâncias, idempotência persistente e consistência entre saldo e ledger**.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · MikroORM 6 · AWS SQS (LocalStack/MiniStack) · Docker Compose.

> As decisões técnicas, trade-offs, interpretações das regras e limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Garantias (resumo)

| Garantia | Como |
|---|---|
| Dinheiro exato | `Money` imutável em centavos (`bigint`); `numeric(19,2)` no banco; `string` nos contratos. Nenhum `number`/float. |
| Sem lost update / saldo negativo por race | Lock pessimista **por wallet** (`SELECT … FOR UPDATE`) + `UPDATE … WHERE version = ?` + `CHECK (balance >= 0)`. |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`; hash canônico do payload; replay devolve o resultado (e saldo) originais. |
| Saldo == ledger | Triggers *deferred* verificam no `COMMIT` que o saldo materializado é o último lançamento; ledger é append-only (triggers) e encadeado. |
| Inbox + saldo + ledger + outbox atômicos | Uma única transação SQL. |
| Nenhum evento antes do commit | Publisher lê só a outbox já commitada (claim com lease + `SKIP LOCKED`). |
| Correto com N instâncias | Tudo é garantido no banco; testes rodam **3+ processos reais** com `kill -9`. |

## Início rápido

Pré-requisitos: [Bun](https://bun.sh) ≥ 1.1 e Docker.

```bash
bun install
docker compose up --build -d      # postgres + localstack + migrations + 3 réplicas (portas 3001, 3002, 3003)
curl -s localhost:3001/health/ready
```

Fluxo de exemplo:

```bash
# 1) criar wallet
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2) apostar (use o id da wallet) — Idempotency-Key é obrigatório
curl -s -i -X POST localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# repetir o MESMO comando ⇒ mesma resposta com "idempotentReplay": true (header Idempotent-Replayed: true)

# 3) conferir
curl -s localhost:3003/wallets/<WALLET_ID>
curl -s "localhost:3003/wallets/<WALLET_ID>/ledger?limit=50"
curl -s -X POST localhost:3003/wallets/<WALLET_ID>/reconciliation
```

Sem Docker (apenas Postgres/SQS locais): copie `.env.example` para `.env`, ajuste `DATABASE_URL`/`SQS_ENDPOINT`, rode `bun run migration:up` e `bun start`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun start` / `bun run dev` | Sobe o serviço (API + consumidor SQS + publisher da outbox + worker de pendências). |
| `bun run migration:up` · `migration:down` · `migration:status` | Migrations versionadas e **reversíveis** (`migration:down -- --all` reverte tudo). |
| `bun run typecheck` | `tsc --noEmit` (strict). |
| `bun run infra:up` / `infra:down` | Sobe/derruba `postgres` + `localstack` (para os testes). |
| `bun run test` | Unitários (puros, sem infra). |
| `bun run test:integration` | PostgreSQL e SQS reais: schema/constraints, casos de uso, consumidor, outbox, HTTP. |
| `bun run test:concurrency` | **Processos reais** em paralelo, `kill -9`, queda total e reinício. |
| `bun run test:all` | Tudo. |
| `bun run test:load` | Teste de carga (gera `docs/load-test-report.md`). |

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` na mesma transação). Duplicada (`playerId`+moeda) ⇒ 409. |
| `GET /wallets/:walletId` | Saldo e `version`. |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado (cursor opaco e estável; `limit` 1–200). |
| `POST /wallets/:walletId/reconciliation` | Saldo armazenado × reconstruído pelo ledger. Divergência é logada, vira métrica e é sinalizada — **nunca corrigida em silêncio**. |
| `POST /wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório). |
| `GET /wagering/transactions/:transactionId` · `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta. |
| `GET /health/live` · `GET /health/ready` | Liveness / readiness (PostgreSQL + SQS). Sem autenticação. |
| `GET /metrics` | Prometheus. |

**Status HTTP** (consistentes em todos os endpoints; erro sempre como `{ "error": { code, message, retryable, correlationId, details? } }`):

| Situação | Status |
|---|---|
| Processada | `201` (replay idêntico também `201`, com `idempotentReplay: true`) |
| Aceita, processamento pendente (`PENDING_REFERENCE`) | `202` |
| Rejeitada por regra de negócio / `FAILED` (corpo com `failureCode` e `failureAction`) | `422` |
| Payload inválido | `400` |
| Conflito (idempotência com payload diferente; wallet duplicada) | `409` |
| Não encontrado | `404` |
| Falha **transitória** de infraestrutura (`Retry-After`; reenviar o mesmo pedido é seguro) | `503` |

Taxonomia de `failureCode` e o que o provedor deve fazer: ver [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-taxonomia-de-failurecode).

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use `MessageGroupId = walletId` para ordenação por wallet (otimização — a correção não depende disso). `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`.

## Testes

Os testes de integração e concorrência usam **PostgreSQL e SQS reais** (nada de mocks no lugar deles). Por padrão conectam em `postgres://postgres:postgres@127.0.0.1:5432` e `http://127.0.0.1:4566` (o que o `docker-compose.yml` expõe); sobrescreva com `TEST_DATABASE_ADMIN_URL` e `TEST_SQS_ENDPOINT`. Cada arquivo cria um banco isolado e filas únicas e, ao final, verifica a invariante **`wallet.balance == saldo reconstruído pelo ledger`** para todas as wallets.

```bash
bun run infra:up        # postgres + localstack
bun run test:all
```

Última execução completa: **232 testes, 0 falhas** (125 unitários · 97 de integração · 10 de concorrência multiprocesso).

| Suíte | Cobre |
|---|---|
| `test/unit` | `Money` (escala, entradas inválidas, moeda), `Wallet`, `WagerTransaction` (máquina de estados, hash), regras de BET/WIN/LOSS/REFUND/ROLLBACK, eventos, inbox/outbox. |
| `test/integration/schema` | Migrations up/down/up; cada constraint e trigger. |
| `test/integration/use-cases` | Cenário obrigatório (2×80 sobre 100), 50× a mesma aposta em paralelo, wallet quente, atomicidade, inbox, reversões, pendências, reconciliação. |
| `test/integration/sqs-consumer` | Ack após commit, redelivery, DLQ por motivo, retry/backoff, ordenação por grupo, falha pós-commit, shutdown gracioso. |
| `test/integration/outbox-and-workers` | Publishers concorrentes, lease, publisher morto, duplicata segura, nada antes do commit. |
| `test/integration/http` | Status HTTP, envelope de erro, 503 sob falha real, health, métricas, concorrência via HTTP. |
| `test/concurrency` | **3 processos** (`bun src/main.ts`): HTTP e SQS concorrentes, `kill -9` depois do commit/antes do ack, `kill -9` do publisher depois de publicar, queda total sob carga e reinício. |

> O workflow `.github/workflows/ci.yml` roda typecheck e as três suítes com PostgreSQL e LocalStack como *services* (escrito, mas ainda **não executado** no GitHub Actions).

> **Nota de validação:** esta suíte foi executada de ponta a ponta contra PostgreSQL 16 real e o emulador SQS `moto` (mesmo protocolo do SQS). O `docker compose` (LocalStack) foi escrito e revisado, mas **não pôde ser executado** no ambiente onde o projeto foi construído (sem Docker).

## Estrutura

```
src/
  domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction, settlement (regras puras), eventos, inbox/outbox
  application/       casos de uso (submit, reprocess, create wallet, queries), ports (UnitOfWork, Clock, Metrics...), erros
  infrastructure/    persistence (MikroORM, migrations, repositórios), messaging (SQS), workers, observability
  interfaces/http/   controllers, filtro de exceções, guard (no-op), middleware
test/                unit · integration · concurrency · support
scripts/             migrate.ts · load-test.ts
docker/localstack/   init das filas
```

## Troubleshooting

- **`SyntaxError: Export named 'X' not found`** ao subir sob Bun: com `emitDecoratorMetadata`, tipos (interfaces/aliases) usados em parâmetros de construtores/métodos decorados precisam de `import type`.
- **LocalStack exige token** em imagens recentes: o compose fixa `localstack/localstack:3.8.1`. Qualquer emulador SQS serve — aponte `SQS_ENDPOINT` (ex.: `LOCALSTACK_IMAGE=...`).
- **Autenticação não está implementada** (decisão documentada, com pontos de extensão): ARCHITECTURE.md §15.
