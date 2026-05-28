# Operations Stack

## Overview

The Operations stack deploys IAM resources (roles, groups, users, policies, SAML/OIDC providers), backup vaults, budget reports, SSM inventory, Session Manager policies, StackSet roles, and firewall configuration infrastructure.

## Deployment Scope

- **Stage:** `operations`
- **Deployed to:** All accounts, all enabled regions
- **Config files consumed:** `iam-config.yaml`, `security-config.yaml`, `global-config.yaml`

## What It Deploys

### IAM Resources
- **Roles** — Custom IAM roles from `iam-config.yaml → roleSets`, with managed policies, trust policies, and optional Managed AD secret access
- **Groups** — IAM groups from `iam-config.yaml → groupSets`
- **Users** — IAM users from `iam-config.yaml → userSets`, with auto-generated Secrets Manager secrets for credentials
- **Managed Policies** — Custom managed policies from `iam-config.yaml → policySets`
- **SAML/OIDC Providers** — Identity providers from `iam-config.yaml → providers`

### StackSet Roles
- **StackSet Admin Role** — For CloudFormation StackSet administration
- **StackSet Execution Role** — For StackSet operations in target accounts
- **Service Catalog Propagation Role** — For cross-account Service Catalog sharing

### Backup Vaults
- AWS Backup vaults from `global-config.yaml → backup.vaults`
- Vault access policies for cross-account backup operations

### Budget Reports
- AWS Budgets from `global-config.yaml → reports.budgets`

### SSM Inventory
- Enables SSM Inventory collection on managed instances

### Session Manager Policy
- IAM policy for SSM Session Manager access

### Firewall Configuration
- S3 bucket for firewall configuration files
- IAM role for firewall config custom resource Lambda
- Asset access role for reading from the assets bucket

### Account Warming
- Optional "warm account" custom resource to initialize new accounts

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/operations-stack.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `iam-config.yaml → roleSets` | IAM roles |
| `iam-config.yaml → groupSets` | IAM groups |
| `iam-config.yaml → userSets` | IAM users + Secrets Manager secrets |
| `iam-config.yaml → policySets` | IAM managed policies |
| `iam-config.yaml → providers` | SAML/OIDC identity providers |
| `global-config.yaml → backup.vaults` | AWS Backup vaults |
| `global-config.yaml → reports.budgets` | AWS Budgets |
