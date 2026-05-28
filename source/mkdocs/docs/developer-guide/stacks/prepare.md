# Prepare Stack

## Overview

The Prepare stack is the first stage of the pipeline. It runs exclusively in the management account's home region and is responsible for validating the environment, creating foundational KMS keys, uploading configuration assets, and provisioning new AWS accounts.

## Deployment Scope

- **Stage:** `prepare`
- **Deployed to:** Management account, home region only
- **Config files consumed:** `accounts-config.yaml`, `organization-config.yaml`, `global-config.yaml`, `replacements-config.yaml`

## What It Deploys

### KMS Keys
- **Management Account Key** — CMK used to encrypt the DynamoDB config table and other management account resources
- **CloudWatch Logs Key** — CMK for encrypting CloudWatch log groups in the management account
- **Lambda Key** — CMK for encrypting Lambda environment variables

### DynamoDB Configuration Table
- `AcceleratorConfigTable` — Stores parsed configuration data with a `dataType` partition key and `acceleratorKey` sort key
- Encrypted with the management account CMK
- Includes a local secondary index (`awsResourceKeys`) for AWS resource lookups

### Configuration Assets
- Uploads the entire config directory as a CDK asset (supports `!include` tags)
- Individual assets for `accounts-config.yaml`, `organization-config.yaml`, and `replacements-config.yaml`

### Environment Validation Lambda
- Custom resource backed by `validate-environment/index.ts`
- Validates:
    - All AWS accounts in config exist in the organization
    - All OUs in config exist in the organization
    - Accounts are in the correct OUs
    - SCP count does not exceed limits
    - CIDR ordering is preserved for existing VPCs
    - V2 stacks flag consistency
    - Transit Gateway multicast support consistency

### Account Creation
- `CreateOrganizationAccounts` custom resource — provisions new AWS accounts defined in `accounts-config.yaml`
- Handles account creation through AWS Organizations

### SSM Parameters
- Writes a validation marker parameter: `/<prefix>/prepare-stack/validate`
- Stores config table name and ARN for downstream stacks

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/prepare-stack.ts` |
| Validation lambda | `accelerator/lib/lambdas/validate-environment/index.ts` |
| Config types | `config/lib/accounts-config.ts`, `config/lib/organization-config.ts` |

## Cross-Stack Dependencies

### Writes (SSM Parameters)
- Config table name and ARN
- Management account CMK ARN

### Read By
- All downstream stacks read the config table to resolve account IDs, OU structures, and other configuration data

## Common Issues

| Error | Cause | Resolution |
|-------|-------|------------|
| SCP count validation failure | Adding SCPs would exceed the AWS Organizations limit (5 per target) | Reduce SCPs or consolidate policies |
| Account not found in organization | `accounts-config.yaml` references an account email not in the org | Verify account emails match |
| OU not found | `organization-config.yaml` references an OU that doesn't exist | Create the OU in AWS Organizations or fix the config |
| CIDR order validation | Reordering VPC CIDRs in config would cause subnet disruption | Maintain CIDR ordering; append new CIDRs at the end |
