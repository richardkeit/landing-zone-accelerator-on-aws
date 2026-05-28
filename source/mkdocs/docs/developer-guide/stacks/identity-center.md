# Identity Center Stack

## Overview

The Identity Center stack configures AWS IAM Identity Center (successor to AWS SSO): permission sets, assignments to users/groups, and Identity Store lookups.

## Deployment Scope

- **Stage:** `identity-center`
- **Deployed to:** Management account, home region only
- **Config files consumed:** `iam-config.yaml`

## What It Deploys

### Permission Sets
- Creates Identity Center permission sets from `iam-config.yaml → identityCenter.identityCenterPermissionSets`
- Supports inline policies, managed policies, customer-managed policies, and permissions boundaries
- Configurable session duration

### Assignments
- Assigns permission sets to users and groups for specific AWS accounts
- Configured via `iam-config.yaml → identityCenter.identityCenterAssignments`
- Resolves Identity Store user/group IDs via custom resource lookups

### Identity Store Lookups
- Custom resource to look up user and group IDs from the Identity Store
- Required because Identity Center assignments need principal IDs, not names

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/identity-center-stack.ts` |
| Identity Center constructs | `constructs/lib/aws-identity-center/` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `iam-config.yaml → identityCenter.identityCenterPermissionSets` | Identity Center permission sets |
| `iam-config.yaml → identityCenter.identityCenterAssignments` | Permission set → account assignments |

## Cross-Stack Dependencies

### Reads
- CloudWatch and Lambda KMS keys
- Identity Center instance ARN and Identity Store ID (from SSM or direct lookup)
