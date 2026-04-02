#!/bin/bash
set -euo pipefail

# Common module infrastructure setup (management account).
#
# Creates shared resources needed by all module integration tests:
#   - DynamoDB ModuleState table
#   - DynamoDB ResourceRetention table
#   - CloudWatch log group for verbose logs
#
# Idempotent: checks before creating, always applies settings.
#
# Usage (called by deploy-integ-prereqs.sh):
#   module-common-infra.sh <prefix> <region> <mgmt-account-id>

acceleratorPrefix=$1
region=$2
mgmtAccountId=$3

MODULE_STATE_TABLE="${acceleratorPrefix}-Module-State-${mgmtAccountId}-${region}"
RESOURCE_RETENTION_TABLE="${acceleratorPrefix}-Resource-Retention-${mgmtAccountId}-${region}"
VERBOSE_LOG_GROUP="${acceleratorPrefix}-Module-Verbose-Logs"

echo ""
echo "[Common Infra] Setting up management account resources..."

# ModuleState table
if aws dynamodb describe-table --table-name "${MODULE_STATE_TABLE}" --region "${region}" 2>/dev/null | grep -q ACTIVE; then
  echo "[Common Infra]   ModuleState table already exists: ${MODULE_STATE_TABLE}"
else
  echo "[Common Infra]   Creating ModuleState table: ${MODULE_STATE_TABLE}..."
  aws dynamodb create-table \
    --table-name "${MODULE_STATE_TABLE}" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --sse-specification Enabled=true,SSEType=KMS \
    --region "${region}" \
    --tags Key=Accelerator,Value="${acceleratorPrefix}" \
    --output text --query 'TableDescription.TableName' > /dev/null
  aws dynamodb wait table-exists --table-name "${MODULE_STATE_TABLE}" --region "${region}"
  aws dynamodb update-time-to-live --table-name "${MODULE_STATE_TABLE}" --region "${region}" \
    --time-to-live-specification Enabled=true,AttributeName=ttl > /dev/null
  aws dynamodb update-continuous-backups --table-name "${MODULE_STATE_TABLE}" --region "${region}" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true > /dev/null
  echo "[Common Infra]   ModuleState table created."
fi

# ResourceRetention table
if aws dynamodb describe-table --table-name "${RESOURCE_RETENTION_TABLE}" --region "${region}" 2>/dev/null | grep -q ACTIVE; then
  echo "[Common Infra]   ResourceRetention table already exists: ${RESOURCE_RETENTION_TABLE}"
else
  echo "[Common Infra]   Creating ResourceRetention table: ${RESOURCE_RETENTION_TABLE}..."
  aws dynamodb create-table \
    --table-name "${RESOURCE_RETENTION_TABLE}" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --sse-specification Enabled=true,SSEType=KMS \
    --region "${region}" \
    --tags Key=Accelerator,Value="${acceleratorPrefix}" \
    --output text --query 'TableDescription.TableName' > /dev/null
  aws dynamodb wait table-exists --table-name "${RESOURCE_RETENTION_TABLE}" --region "${region}"
  aws dynamodb update-continuous-backups --table-name "${RESOURCE_RETENTION_TABLE}" --region "${region}" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true > /dev/null
  echo "[Common Infra]   ResourceRetention table created."
fi

# CloudWatch log group
if aws logs describe-log-groups --log-group-name-prefix "${VERBOSE_LOG_GROUP}" --region "${region}" \
  --query "logGroups[?logGroupName=='${VERBOSE_LOG_GROUP}'].logGroupName" --output text 2>/dev/null | grep -q "${VERBOSE_LOG_GROUP}"; then
  echo "[Common Infra]   Log group already exists: ${VERBOSE_LOG_GROUP}"
else
  echo "[Common Infra]   Creating log group: ${VERBOSE_LOG_GROUP}..."
  aws logs create-log-group --log-group-name "${VERBOSE_LOG_GROUP}" --region "${region}" \
    --tags Accelerator="${acceleratorPrefix}" 2>/dev/null || true
  aws logs put-retention-policy --log-group-name "${VERBOSE_LOG_GROUP}" --region "${region}" \
    --retention-in-days 30
  echo "[Common Infra]   Log group created."
fi

echo "[Common Infra] Management account resources complete."
