# ARCHITECTURE

Decisões técnicas, trade-offs e limitações. Para setup e comandos, veja o [README](./README.md).

## 1. Visão geral

```
 Provedores ──HTTP──▶ ┌──────────────────────────── instância (N réplicas idênticas) ───────────────────────────┐
                      │ Controllers ─┐                                                                          │
 Provedores ─SQS FIFO▶│ Consumer ────┴▶ SubmitWagerTransactionUseCase ─▶ UnitOfWork (1 transação SQL)           │
 (wager-transactions) │                    │  inbox → LOCK wallet → idempotência → settle() → tx+ledger+saldo   │
                      │                    │  + outbox (eventos) ── COMMIT                                      │
                      │ PendingReferenceWorker ─▶ ReprocessPendingReferenceUseCase (mesma disciplina de lock)   │
                      │ OutboxPublisherWorker ◀── claim (lease + SKIP LOCKED) ──▶ SQS FIFO (wager-events)       │
                      └──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                              ▼
                                  PostgreSQL: wallets · wager_transactions · wallet_ledger_entries · inbox · outbox
```

- **Uma só regra de negócio** (`settle`, função pura de domínio) usada por HTTP, SQS e reprocessamento de pendências.
- **O banco é a fonte das garantias**; o processo é descartável (qualquer instância pode morrer a qualquer momento).
- Cada processo pode rodar todos os papéis (API, consumidor, publisher, worker de pendências) ou só alguns (`RUN_*`).

## 2. Stack e justificativas

**Bun + NestJS + TypeScript estrito.** Obrigatórios. Nest dá DI, ciclo de vida (shutdown hooks) e a camada HTTP; o domínio não depende dele.

**ORM: MikroORM 6** (preferencial no enunciado). Por quê:
- `EntityManager.transactional()` com *fork* por unidade de trabalho (Identity Map isolado por transação) e `LockMode.PESSIMISTIC_WRITE` — exatamente o que o lock por wallet precisa (`WalletRepo.lockById`).
- `EntitySchema` (mapeamento **sem decorators**): o domínio não conhece o ORM; os *records* de persistência são classes separadas e os repositórios convertem linha ↔ agregado (`rehydrate`).
- Onde o PostgreSQL exige semântica específica, uso SQL explícito pelo mesmo `EntityManager` (mesma transação): `INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE version = ?`, `FOR UPDATE SKIP LOCKED`, `UPDATE … RETURNING`. O *change tracking* do Unit of Work é **intencionalmente** dispensado nos caminhos quentes (não há objeto "sujo" para sincronizar: toda escrita é condicional/versionada).
- Migrations: `@mikro-orm/migrations` com `up()`/`down()` e lista explícita (`migrationsList`), sem depender de glob de filesystem (funciona igual em Bun, testes e Docker).

**Mapeamento do `Money`.** O domínio guarda **centavos em `bigint`** (exato, sem float, sem biblioteca). Nas bordas é sempre **string decimal de escala 2**. No banco: `numeric(19,2)` + coluna `currency char(3)` separada. O record de persistência usa `string` para o valor — nenhum `number` passa pelo caminho. O parse aceita `^(0|[1-9]\d{0,16})(\.\d{1,2})?$` (rejeita `NaN`, `Infinity`, notação científica, vazio, >2 casas, negativos, zeros à esquerda) e **normaliza** (`"25"` → `"25.00"`); o hash de idempotência usa o valor normalizado. Não há arredondamento: o que não cabe em 2 casas é rejeitado. Moeda: `^[A-Z]{3}$` (formato ISO-4217; não há lista de códigos válidos — ver §17).

**Estratégia transacional.** Uma unidade de trabalho = **uma transação SQL READ COMMITTED**. Tudo que precisa ser atômico (inbox, transação financeira, saldo, ledger, outbox) está dentro dela. Erros do driver são traduzidos para a taxonomia da aplicação (§10).

## 3. Modelo de domínio

Construtores `private` + factories estáticas (`create`, `open`, `opening`, `from`, `rehydrate`); `rehydrate` não revalida. Estado encapsulado, transições explícitas.

- **`Money`** imutável (instância congelada). Moedas diferentes lançam `CurrencyMismatchError`; `equals` entre moedas diferentes é `false`.
- **`Wallet`** (aggregate root): `debit/credit` aplicam a movimentação **e devolvem o lançamento** (saldo e ledger mudam juntos); `version` começa em 1 e só sobe quando o saldo muda. Débito que deixaria saldo negativo lança (defesa do agregado; o fluxo normal rejeita antes).
- **`WalletLedgerEntry`**: instância congelada, sem métodos de transição; `create` valida `before ± money == after`.
- **`WagerTransaction`**: máquina de estados (abaixo), `matchesPayload`, `ledgerDirectionFor(reference?)`, política de espera por referência.
- **`InboxMessage` / `OutboxMessage` / `IntegrationEvent<T>`** (classe abstrata + uma subclasse por evento; `eventType`/`version` no tipo; `data` só com `MoneyProps`).

**Transições de `WagerTransaction`** (também reforçadas por trigger no banco):

```
PENDING            → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED        (reagendar não muda o status)
PROCESSED | REJECTED | FAILED → ∅                          (terminais: tentar transicionar = InvalidTransactionStateError)
```

## 4. Banco de dados

```mermaid
erDiagram
  wallets ||--o{ wager_transactions : "wallet_id"
  wallets ||--o{ wallet_ledger_entries : "wallet_id"
  wager_transactions ||--o{ wallet_ledger_entries : "transaction_id (≤1 por wallet)"
  wager_transactions ||--o| wager_transactions : "reference_transaction_id"
  inbox_messages { text consumer_name PK; text message_id PK }
  outbox_messages { uuid id PK; bigint seq }
```

**Onde cada garantia é imposta (schema, não só código):**

| Garantia | Mecanismo no PostgreSQL |
|---|---|
| ≤ 1 wallet por `playerId`+moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` (+ `CHECK` nos saldos do ledger) |
| `version` só sobe (+1) quando o saldo muda; identidade imutável; sem `DELETE` | trigger `wallets_guard` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| `OPENING` interno; `REFUND`/`ROLLBACK` exigem referência; valor > 0 (exceto `LOSS`) | `CHECK`s em `wager_transactions` |
| Estados terminais imutáveis; sem `DELETE`; colunas de negócio imutáveis | trigger `wager_transactions_guard` |
| Uma reversão aplicada por referência | índice único parcial `(reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Ledger imutável (sem `UPDATE`/`DELETE`/`TRUNCATE`) | triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` |
| Aritmética do lançamento | `CHECK ((CREDIT ∧ after = before + amount) ∨ (DEBIT ∧ after = before − amount))` |
| ≤ 1 lançamento por (transação, wallet); 1 lançamento por versão | `UNIQUE (transaction_id, wallet_id)`, `UNIQUE (wallet_id, wallet_version)` |
| Cadeia contínua (`balance_before` = `balance_after` anterior) | trigger `BEFORE INSERT` no ledger |
| **Saldo materializado == último lançamento**, em toda alteração | *constraint triggers* `DEFERRABLE INITIALLY DEFERRED` em `wallets` e no ledger (checados no `COMMIT`: wallet mudou sem lançamento, ou lançamento sem wallet mudar, aborta a transação) |
| Dedup do consumidor | `PRIMARY KEY (consumer_name, message_id)` |

Índices e quem os usa: `uq_wager_tx_provider_*` (lookup de idempotência/referência), `ix_wager_tx_pending_due` (worker de pendências), `ix_wager_tx_pending_ref` (acordar dependentes), `uq_wager_tx_single_reversal` (checagem de reversão), `uq_ledger_wallet_version` (paginação do ledger por cursor e cadeia), `ix_outbox_pending (seq) WHERE published_at IS NULL` (claim do publisher e lag). Revisão: planos confirmados com `EXPLAIN` (idempotência via `BitmapOr` nos dois índices únicos; reversão via *index-only scan*; ledger paginado e claim por *index scan*); um índice `(wallet_id, created_at)` em `wager_transactions` foi **removido** por não atender a nenhuma consulta (custo de escrita sem benefício).

> **Observação de segurança:** os triggers impedem adulteração por SQL comum, mas um superusuário pode desativá-los (os testes de reconciliação fazem exatamente isso para provar a detecção). Em produção, o usuário da aplicação deve ter privilégio mínimo (sem `TRUNCATE`/`ALTER`, sem `UPDATE`/`DELETE` no ledger); o `docker-compose` usa `postgres` só por conveniência de desenvolvimento.

## 5. Concorrência

A unidade de concorrência é a **`walletId`**. Estratégia: **lock pessimista por wallet** (`SELECT … FOR UPDATE`) + **`UPDATE … WHERE version = ?`** como cinto-e-suspensório (0 linhas ⇒ `ConcurrencyConflictError`, que com o lock não deveria ocorrer) + `CHECK (balance >= 0)` como última defesa.

Alternativas consideradas:
- *Optimistic locking com retry*: sob wallet quente, N−1 tentativas são descartadas a cada commit (trabalho desperdiçado, risco de inanição). O lock pessimista enfileira e garante progresso.
- *Update atômico condicionado (`SET balance = balance - ? WHERE balance >= ?`)*: resolve o saldo, mas não o ledger encadeado, a idempotência nem a verificação de referência/reversão no mesmo passo; teria de ser combinado com lock de qualquer forma.

Disciplina de lock: **wallet primeiro**, sempre (submissão e reprocessamento de pendências); depois só inserts/updates de linhas próprias. A única escrita fora da wallet (`wakeDependents`) não forma ciclo. `lock_timeout` (padrão 5 s) limita a fila de espera: estourou ⇒ erro transitório (retry interno, depois 503/backoff SQS). Wallets distintas não se bloqueiam (sem lock global).

Corrida de idempotência entre wallets distintas: `INSERT … ON CONFLICT DO NOTHING` espera o vencedor commitar; se perder, o fluxo relê e responde replay/conflito (erro `UNIQUE_CONFLICT` transitório com retry).

Teto na wallet quente: as operações da MESMA wallet são serializadas por desenho (preço da correção). Ver `docs/load-test-report.md`.

## 6. Regras de negócio e interpretações adicionais

Implementadas como no enunciado, mais as interpretações abaixo (documentadas por exigência do enunciado):

1. **Uma reversão por referência, de qualquer tipo.** O enunciado proíbe reverter "duas vezes pelo mesmo tipo"; mas `REFUND` + `ROLLBACK` da mesma BET creditariam **duas vezes** (violaria "não duplicar créditos"). Logo: no máximo uma reversão `PROCESSED` (REFUND **ou** ROLLBACK) por referência (`ALREADY_REVERSED`), reforçado por índice único parcial. `ROLLBACK` de um `REFUND` é permitido (reverte o estorno).
2. **`WIN`/`LOSS` com `referenceExternalTransactionId`** (opcional): se informado, deve resolver para uma `BET` PROCESSED da mesma rodada; se a BET ainda não existe, a operação espera como `PENDING_REFERENCE`.
3. **Referência não aplicada** (`REJECTED`/`FAILED`) ⇒ dependente `REJECTED` com `REFERENCE_NOT_PROCESSED`. Referência ainda `PENDING_REFERENCE` ⇒ dependente também espera (cadeias).
4. **`LOSS`** aceita valor `0.00`; `BET`/`WIN`/`REFUND`/`ROLLBACK` exigem valor > 0. `ROLLBACK` de `LOSS` ou de `ROLLBACK` ⇒ `INVALID_REFERENCE_KIND`.
5. **`providerId = "internal"`** é reservado (transações `OPENING`).
6. **Rejeições são persistidas** (auditáveis, com saldo observado) — exceto *wallet inexistente*, que não tem como ser gravada (FK) e vira 404 / DLQ.
7. **`playerId` diferente do dono da wallet** ⇒ `REJECTED/PLAYER_WALLET_MISMATCH`.

## 7. Taxonomia de `failureCode`

Códigos estáveis e legíveis por máquina; `failureAction` orienta o provedor. Reenviar o MESMO `externalTransactionId`/`Idempotency-Key` sempre devolve o resultado original.

| `failureCode` | Quando | `failureAction` |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | `NEW_ID_IF_CHANGED` (novo id se o jogador depositar) |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK (de WIN/REFUND) deixaria saldo negativo — **distinto** de saldo insuficiente | `NEW_ID_IF_CHANGED` |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | `FIX_PAYLOAD_NEW_ID` |
| `PLAYER_WALLET_MISMATCH` | playerId não é dono da wallet | `FIX_PAYLOAD_NEW_ID` |
| `REFERENCE_NOT_FOUND` | referência não apareceu no limite/TTL | `NEW_ID_IF_CHANGED` |
| `REFERENCE_NOT_PROCESSED` | referência existe mas foi rejeitada/falhou (ou segue pendente ao esgotar) | `FINAL` |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | `FIX_PAYLOAD_NEW_ID` |
| `INVALID_REFERENCE_KIND` | tipo da referência incompatível | `FIX_PAYLOAD_NEW_ID` |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial fora de escopo) | `FIX_PAYLOAD_NEW_ID` |
| `ALREADY_REVERSED` | referência já revertida | `FINAL` |
| `INFRASTRUCTURE_FAILURE` | status `FAILED` (erro permanente de infraestrutura) | `NEW_ID_IF_CHANGED` |

Erros de **payload inválido** (400) e **conflito de idempotência** (409) usam `error.code` (`VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`).

## 8. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) / `data.idempotencyKey` (SQS). Escopo: `(provider_id, idempotency_key)`. Padrão recomendado: `{providerId}:{externalTransactionId}`.
- **`payloadHash`** = `sha256( JSON canônico )` em hex (64 chars), onde o JSON canônico (chaves ordenadas em todos os níveis, sem espaços) é de `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money:{amount,currency}, referenceExternalTransactionId|null}`. Header e metadados de transporte **não** entram. Valores monetários entram **normalizados**.
- **Fluxo:** (1) *fast path* sem lock: se já existe registro, responde replay/conflito; (2) na transação: **relê sob o lock da wallet** (um duplicado concorrente pode ter commitado) e só então processa; (3) corrida entre wallets distintas é resolvida pelas `UNIQUE`.
- **Replay** devolve o resultado original — inclusive o **saldo observado naquele momento** (`balance_observed`), com `idempotentReplay: true`. Mesmo `externalTransactionId` com outra key e payload igual também é replay; com payload diferente é **conflito (409)**, nunca replay.
- **Dois níveis:** inbox (dedup de entrega por `(consumerName, messageId)`) e idempotency key (dedup de negócio). Nada em memória participa da garantia.

## 9. API HTTP

Mapeamento único (ver tabela no README): 201 processada · 202 pendente · 422 rejeitada/`FAILED` · 400 payload inválido · 409 conflito · 404 não encontrado · **503 transitória** (`Retry-After: 1`, `retryable: true`) · 500 interno. O filtro de exceções é global, então o contrato é idêntico em todos os endpoints. `X-Correlation-Id` é aceito/gerado e devolvido (inclusive em erros de JSON quebrado).

## 10. Processamento por SQS

O consumidor reutiliza o mesmo caso de uso. Fluxo por mensagem: parse/validação → `submit` (inbox na mesma transação) → **ack (`DeleteMessage`) só depois do commit**.

| Classe de erro | Exemplos | Destino |
|---|---|---|
| **Negócio** | saldo insuficiente, referência inválida | `REJECTED` persistido + **ack** (terminal) |
| **Entrada permanente** | JSON/contrato inválido, `OPENING`, conflito de idempotência, wallet inexistente, messageId com payload diferente | **DLQ** (atributos `FailureReason`, `FailureDetail`, `OriginalMessageId`, `ReceiveCount`) |
| **Transitória** | lock timeout, deadlock, conexão, timeout | retry com **backoff exponencial** (`ChangeMessageVisibility`: `2·2ⁿ⁻¹ s`, teto 300 s); esgotou `CONSUMER_MAX_ATTEMPTS` (5) ⇒ DLQ |
| **Permanente de infra / desconhecida** | violação de invariante; erro inesperado após as tentativas | grava transação **`FAILED`** (auditável) + DLQ |

- **Ordenação:** mensagens do mesmo `MessageGroupId` são processadas em ordem; falhou uma, o resto do grupo no lote é devolvido (visibilidade 0). Grupos distintos em paralelo. É otimização — a correção não depende disso.
- **Rede de segurança do broker:** `RedrivePolicy` (`maxReceiveCount` 10) leva ao DLQ mensagens que a aplicação não conseguiu mover.
- **SIGTERM:** para o polling, conclui mensagens em andamento (commit+ack) e **devolve a visibilidade** das que não começaram (timeout de drenagem configurável).
- **`FAILED` é terminal:** um redrive manual da DLQ devolve o mesmo `FAILED` (replay). Para reprocessar, o provedor envia novo `externalTransactionId`.
- SQS indisponível no boot não derruba o processo: as filas são resolvidas de forma preguiçosa/repetível; `/health/ready` reporta 503 até voltar.

## 11. Transactional Outbox e eventos

Eventos entram na outbox **na mesma transação** da mudança financeira. O `OutboxPublisherWorker`:

1. **Claim com lease**: `WITH due AS (… ORDER BY seq LIMIT n FOR UPDATE SKIP LOCKED) UPDATE … SET locked_by, locked_until` — publishers concorrentes nunca pegam as mesmas linhas.
2. Publica em lotes de 10 (`SendMessageBatch`), em *lanes* por hash do aggregate (ordem preservada por aggregate), e **marca em lote**.
3. Falha ⇒ backoff exponencial por evento (1 s → 5 min, jitter ±20%), **nunca descarta**; o resto do aggregate volta sem contar tentativa.
4. **Morte do publisher:** depois do claim ⇒ o lease expira e outra instância assume; **depois de publicar e antes de marcar** ⇒ outra instância republica (duplicata) — segura, pois o consumidor deduplica por `eventId` (a fila FIFO também deduplica por `MessageDeduplicationId = eventId`, mas isso é só otimização).

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` (e `OPENING`) |
| `WagerTransactionRejected` | rejeição por regra de negócio (inclui `REFERENCE_NOT_FOUND` após o limite) |
| `WalletBalanceChanged` | somente quando o saldo muda (inclui a abertura) |
| `WagerTransactionPendingReference` | referência ausente |

Envelope: `eventId, eventType, aggregateId (= walletId), correlationId, causationId, occurredAt, version, data`. `WalletBalanceChanged.data.walletVersion` permite ao consumidor **ordenar e descartar eventos antigos**: a ordenação de publicação é *best-effort* (publishers concorrentes e falha parcial de lote podem reordenar), por isso o contrato exige dedup por `eventId` + ordenação por `walletVersion`.

## 12. Referências fora de ordem

Referência ausente ⇒ `PENDING_REFERENCE` (HTTP 202) + evento. O worker agendado reprocessa com **backoff exponencial** (1 s, 2 s, 4 s … teto 60 s). **Limite:** 10 tentativas **ou** TTL de 5 min — o primeiro que ocorrer. Justificativa: reordenação por entrega *at-least-once* normalmente se resolve em segundos; 5 min cobre retries lentos do provedor sem deixar a jogada "em aberto" indefinidamente. Esgotado ⇒ `REJECTED/REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`) + `WagerTransactionRejected`. **Otimização:** quando uma transação é resolvida, as pendências que a referenciam ficam imediatamente devidas (`wakeDependents`), então o caso comum não espera o backoff. Todos os parâmetros são configuráveis (`PENDING_*`).

## 13. Observabilidade

- **Logs JSON** (uma linha por evento) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` via `AsyncLocalStorage`. Chaves financeiras/sensíveis (`money`, `amount`, `balance`, `payload`, `body`, `authorization`…) são **redigidas**; só ids e códigos saem.
- **Métricas** (`GET /metrics`): `wager_transactions_total{status,kind,source}`, `wager_duplicates_total{source}`, `wager_retries_total{component}`, `wager_dlq_messages_total{reason}`, `wager_lock_conflicts_total{type}`, `wager_processing_duration_seconds{source,outcome}`, `wager_outbox_lag_seconds`, `wager_outbox_pending_events`, `wager_outbox_published_total`, `wager_outbox_publish_failures_total`, `wager_reconciliation_divergences_total`, `wager_sqs_messages_total{result}`, `http_requests_total`, `http_request_duration_seconds`. Os gauges da outbox usam timer próprio (continuam reportando se o loop de publicação travar).
- **Health:** `/health/live` (processo) e `/health/ready` (PostgreSQL e SQS; 503 se algum cair). Ambos abertos.

## 14. Estratégia de testes (mapa requisito → teste)

| Requisito do enunciado | Onde está coberto |
|---|---|
| Money (escala, entradas inválidas, moeda) | `unit/money` |
| Invariantes da Wallet; regras BET/WIN/LOSS/REFUND/ROLLBACK; conflito de moeda; key com payload divergente | `unit/wallet`, `unit/settlement`, `unit/wager-transaction` |
| Migrations e constraints | `integration/schema` (up/down/up; cada constraint/trigger) |
| Atomicidade wallet+ledger+inbox+outbox | `integration/use-cases` (falha antes do commit ⇒ rollback total) |
| Inbox e redelivery | `integration/use-cases`, `integration/sqs-consumer` |
| Publishers concorrentes; retry; recuperação | `integration/outbox-and-workers`, `concurrency` (3 publishers em processos) |
| Retry e DLQ | `integration/sqs-consumer` |
| Mesma aposta 50× em paralelo; 2×80 sobre 100; wallets distintas; wallet quente | `integration/use-cases`, `integration/http`, `concurrency` (entre processos) |
| ≥ 3 instâncias simultâneas | `concurrency/multi-instance` (3 processos `bun src/main.ts`) |
| Worker morto depois do commit e antes do ack | `concurrency` (`kill -9` via failpoint `consumer.after-commit`) |
| Dois publishers sobre a mesma outbox; publisher morto | `integration/outbox-and-workers`, `concurrency` (`outbox.after-publish`) |
| ROLLBACK/REFUND antes da referência | `integration/use-cases` (inclui cadeia e esgotamento por tentativas/TTL), `concurrency` |
| Reinício com consistência final | `concurrency` (`kill -9` em todas as instâncias sob carga SQS+HTTP; clientes reenviam com a mesma key) |
| Invariante `balance == ledger` | `assertLedgerInvariant` ao final de **todos** os arquivos de integração/concorrência |

Falhas são injetadas por *failpoints* (`ENABLE_FAILPOINTS`, **desligado e ignorado em produção**) que matam o processo (`SIGKILL`, sem cleanup) em pontos exatos do fluxo. Nenhum teste substitui PostgreSQL ou SQS por mock.

## 15. Autenticação

**Não implementada**, por decisão (não vale pontos e não deve competir com correção/concorrência/idempotência). **Desenho que adotaria:** Keycloak (OIDC) como IdP; cada provedor é um *client* (client-credentials). Um `AuthGuard` global validaria o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e anexaria um `Principal`; `ProviderIdentityPort.assertCanActFor(principal, providerId)` mapearia `azp`/roles do token para os `providerId`s permitidos (impedindo um provedor de submeter em nome de outro). Health e `/metrics` permanecem abertos; a fila SQS é canal interno confiável (protegido por IAM/rede), mas `providerId` da mensagem segue sujeito às mesmas validações de domínio. **Pontos de extensão já no código:** `AuthGuard` (no-op, registrado como `APP_GUARD`, com decorator `@Public()`) e `ProviderIdentityPort` (chamado no controller de transações).

## 16. Operação e configuração

Todas as variáveis estão em `.env.example` com comentários. Valores-chave: `DB_LOCK_TIMEOUT_MS=5000`, `CONSUMER_MAX_ATTEMPTS=5`, `OUTBOX_LEASE_MS=30000`, `PENDING_MAX_ATTEMPTS=10`, `PENDING_TTL_MS=300000`. Em produção: `SQS_AUTO_CREATE=false` (filas via IaC), migrations por `bun run migration:up` (não `AUTO_MIGRATE`), `NODE_ENV=production`, `stop_grace_period` ≥ drenagem do consumidor. Escala horizontal: basta adicionar réplicas (o banco serializa o que precisa; consumidores/publishers/workers são concorrentes por desenho).

## 17. Trade-offs, limitações e próximos passos

- **Wallet quente:** throughput da mesma wallet é limitado pela serialização (intencional). Mitigação futura: sub-contas/sharding de wallet.
- **Retenção:** `outbox_messages` publicadas e `inbox_messages` crescem indefinidamente. Falta um job de expurgo/partição por data (a outbox não é ledger, então `DELETE` de publicadas é permitido).
- **Ordenação de eventos** é *best-effort*; consumidores devem usar `eventId` + `walletVersion`.
- **Moeda:** validada só por formato (`[A-Z]{3}`), sem lista ISO-4217; escala fixa de 2 casas para todas as moedas (como no enunciado) — moedas com outro expoente (JPY, BHD) não são suportadas.
- **Privilégios de banco:** o compose usa superusuário por conveniência; ver §4.
- **Relógio:** backoffs/leases usam o relógio da aplicação (assume NTP); desvios grandes só causam republicação (segura) ou espera extra.
- **Validação em emulador:** a suíte rodou contra PostgreSQL 16 real e o emulador SQS `moto`; o `docker-compose` com LocalStack não foi executado onde o projeto foi construído. Diferenças sutis de semântica FIFO entre emuladores e o SQS real são esperadas; a correção não depende delas (inbox + idempotência + banco).
- **Teste de carga:** resultados específicos do ambiente (ver `docs/load-test-report.md`); emuladores single-thread distorcem o lag da outbox.
- **Autenticação:** não implementada (§15).
- **Double-entry bookkeeping** (diferencial opcional) não implementado.

## 18. Falhas eliminatórias — checklist

`number` para dinheiro: **não** (bigint/string/numeric) · saldo negativo por race: **impossível** (lock + `CHECK`; testado) · débito/crédito duplicado: **não** (idempotência + inbox + índice de reversão) · idempotência só em memória: **não** (banco) · correto só com 1 instância: **não** (3 processos testados) · evento antes do commit: **não** (outbox) · sem ledger auditável: **não** (append-only, encadeado, reconciliável) · testes que trocam PostgreSQL/SQS por mocks: **não**.
