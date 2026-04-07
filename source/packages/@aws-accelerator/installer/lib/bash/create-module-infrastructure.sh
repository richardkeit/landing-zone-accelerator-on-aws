#!/bin/bash

# Get input parameters
acceleratorPrefix=$1
homeRegion=$2
accountId=$3
enableExternalPipelineAccount=$4
acceleratorQualifier=$5

# For external pipeline account deployments, use qualifier for resource uniqueness
# This allows multiple LZA pipelines in a single external account
if [ "$enableExternalPipelineAccount" = "yes" ] && [ -n "$acceleratorQualifier" ]; then
    resourcePrefix=${acceleratorQualifier}
else
    resourcePrefix=${acceleratorPrefix}
fi

# ============================================================================
# Module Infrastructure Bootstrap Section (DynamoDB tables for module state)
# ============================================================================
# Deploy module infrastructure stack in the pipeline account (where yarn run lza executes).
# Uses --no-fail-on-empty-changeset for idempotency — safe to run every time.
# Adding new resources to module-infrastructure.yaml requires no script changes.

aws cloudformation deploy \
    --stack-name ${resourcePrefix}-ModuleInfrastructureStack-${accountId}-${homeRegion} \
    --template-file lib/cloudformation/module-infrastructure.yaml \
    --parameter-overrides AcceleratorPrefix=${resourcePrefix} \
    --region ${homeRegion} \
    --no-fail-on-empty-changeset
