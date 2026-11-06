#!/bin/bash
# Executado pelo LocalStack quando o serviço fica "ready" (/etc/localstack/init/ready.d).
# Cria as filas FIFO exigidas pelo desafio: wager-transactions.fifo, wager-transactions-dlq.fifo (+ fila de eventos).
# O serviço também cria as filas de forma idempotente no boot (SQS_AUTO_CREATE=true); este script só antecipa isso.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --region "$REGION" --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"ContentBasedDeduplication\": \"false\",
  \"VisibilityTimeout\": \"60\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":10}\"
}" >/dev/null

awslocal sqs create-queue --region "$REGION" --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

echo "[init-aws] filas criadas: wager-transactions.fifo, wager-transactions-dlq.fifo, wager-events.fifo"
