#!/bin/bash
set -euo pipefail

# Deploy integration test prerequisites.
#
# Orchestrates all infrastructure setup for module integration tests:
#   Step 1: Common infra (DynamoDB tables, CloudWatch) — management account
#   Step 2: Central logs bucket (KMS + S3) — log archive account
#   Step 3: Module-specific prereqs — discovered from modules/*/infrastructure/*-prereqs.sh
#
# Usage:
#   deploy-integ-prereqs.sh <prefix> <region> <mgmt-account-id> <logarchive-account-id> <partition> <cross-account-role-name>
#
# The script assumes it is already running with management account credentials
# (via AWS_CREDS_TARGET_ROLE in GitLab CI).

acceleratorPrefix=$1
region=$2
mgmtAccountId=$3
logArchiveAccountId=$4
partition=$5
crossAccountRoleName=$6

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTENV_FILE="${SCRIPT_DIR}/integ-prereqs.env"
> "${DOTENV_FILE}"  # Clear dotenv file
export DOTENV_FILE

echo "============================================"
echo "Integration Test Prerequisites Deployment"
echo "============================================"
echo "Prefix:              ${acceleratorPrefix}"
echo "Region:              ${region}"
echo "Management Account:  ${mgmtAccountId}"
echo "Log Archive Account: ${logArchiveAccountId}"
echo "Partition:           ${partition}"
echo "Cross-Account Role:  ${crossAccountRoleName}"
echo "============================================"

# ------------------------------------------------------------------
# Step 1: Common infrastructure (management account)
# ------------------------------------------------------------------
echo ""
echo "[Step 1/3] Setting up common infrastructure..."
bash "${SCRIPT_DIR}/module-common-infra.sh" \
  "${acceleratorPrefix}" "${region}" "${mgmtAccountId}"
echo "[Step 1/3] Common infrastructure complete."

# ------------------------------------------------------------------
# Step 2: Central logs bucket (log archive account)
# ------------------------------------------------------------------
echo ""
echo "[Step 2/3] Setting up central logs bucket..."
bash "${SCRIPT_DIR}/central-logs-bucket.sh" \
  "${acceleratorPrefix}" "${region}" "${mgmtAccountId}" "${logArchiveAccountId}" "${partition}" "${crossAccountRoleName}"
echo "[Step 2/3] Central logs bucket complete."

# ------------------------------------------------------------------
# Step 3: Module-specific prerequisite scripts
# ------------------------------------------------------------------
# Each module can provide its own prereqs script under:
#   test/integration/modules/<module>/infrastructure/*-prereqs.sh
# Scripts receive the same arguments as this orchestrator and should
# append their env vars to DOTENV_FILE.
# Note: Log Archive credentials from Step 2 are still in scope.
echo ""
echo "[Step 3/3] Running module-specific prerequisite scripts..."

MODULES_DIR="$(cd "${SCRIPT_DIR}/../modules" 2>/dev/null && pwd)" || true

if [ -d "${MODULES_DIR}" ]; then
  for prereq_script in "${MODULES_DIR}"/*/infrastructure/*-prereqs.sh; do
    [ -f "${prereq_script}" ] || continue
    echo ""
    echo "  Running: ${prereq_script}"
    bash "${prereq_script}" "${acceleratorPrefix}" "${region}" "${mgmtAccountId}" "${logArchiveAccountId}" "${partition}" "${crossAccountRoleName}"
  done
  echo "[Step 3/3] Module-specific prerequisites complete."
else
  echo "[Step 3/3] No modules directory found — skipping."
fi

echo ""
echo "============================================"
echo "All prerequisites deployed successfully."
echo "Outputs written to: ${DOTENV_FILE}"
cat "${DOTENV_FILE}" | sed 's/^/  /'
echo "============================================"
