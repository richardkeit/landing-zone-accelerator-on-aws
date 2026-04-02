#!/bin/bash

# Get input parameters
acceleratorPrefix=$1
homeRegion=$2
accountId=$3

# ============================================================================
# Module Infrastructure Bootstrap Section (DynamoDB tables for module state)
# ============================================================================
# Deploy module infrastructure stack in the pipeline account (where yarn run lza executes).
# Uses --no-fail-on-empty-changeset for idempotency — safe to run every time.
# Adding new resources to module-infrastructure.yaml requires no script changes.

aws cloudformation deploy \
    --stack-name ${acceleratorPrefix}-ModuleInfrastructureStack-${accountId}-${homeRegion} \
    --template-file lib/cloudformation/module-infrastructure.yaml \
    --parameter-overrides AcceleratorPrefix=${acceleratorPrefix} \
    --region ${homeRegion} \
    --no-fail-on-empty-changeset
