# Key Stack

## Overview

The Key stack creates the central accelerator KMS key in the audit (security) account. This key is used by multiple downstream stacks for encrypting CloudWatch logs, SNS topics, SQS queues, and Lambda environment variables.

## Deployment Scope

- **Stage:** `key`
- **Deployed to:** Audit account, all enabled regions
- **Config files consumed:** `security-config.yaml`, `global-config.yaml`

## What It Deploys

### Accelerator KMS Key
- Central CMK with alias `alias/<prefix>/kms/key`
- Key rotation enabled
- Key policy grants:
    - All accelerator roles in the organization (`<prefix>-*`)
    - CloudWatch Logs service principal
    - SNS, Lambda, CloudWatch, SQS service principals
    - Macie service principal (if enabled)

### Cross-Account SSM Parameter Access Role
- IAM role allowing other accounts to read SSM parameters storing the accelerator key ARN
- Grants access to all account IDs in the organization

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/key-stack.ts` |
| Resource naming | `accelerator/lib/accelerator-resource-names.ts` |

## Cross-Stack Dependencies

### Writes (SSM Parameters)
- Accelerator CMK ARN — read by Logging, Security, Operations, and Network stacks

### Read By
- Nearly every downstream stack retrieves this key via `getAcceleratorKey(AcceleratorKeyType.CLOUDWATCH_KEY)` or similar
