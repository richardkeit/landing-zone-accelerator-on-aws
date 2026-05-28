# AcceleratorStack Base Class

## Overview

`AcceleratorStack` (`accelerator/lib/stacks/accelerator-stack.ts`) is the base class for all LZA stacks. It provides shared utilities for deployment target resolution, KMS key retrieval, SSM parameter management, policy generation, and NAG suppression.

## Key Properties

| Property | Description |
|----------|-------------|
| `props` | `AcceleratorStackProps` — contains all parsed config objects, account mappings, and environment info |
| `ssmParameters` | Queue of SSM parameters to create at end of synthesis |
| `nagSuppressionInputs` | Queue of CDK NAG suppressions |
| `acceleratorResourceNames` | Instance of `AcceleratorResourceNames` for consistent naming |
| `organizationId` | AWS Organizations ID (if org is enabled) |

## Deployment Target Resolution

The most commonly used utility methods determine whether a stack should create resources for a given config item:

### `isIncluded(deploymentTargets)`
Returns `true` if the current account+region matches the deployment targets (accounts, OUs, regions).

### `getAccountIdsFromDeploymentTargets(deploymentTargets)`
Resolves deployment targets to a list of AWS account IDs. Handles:

- Direct account names → account IDs
- OU names → all account IDs in those OUs
- Exclusion lists

### `isAccountExcluded(accounts)` / `isRegionExcluded(regions)`
Checks if the current account or region is in an exclusion list.

### `getVpcAccountIds(vpcItem)`
Returns account IDs where a VPC or VPC template should be deployed.

## KMS Key Retrieval

### `getAcceleratorKey(keyType)`
Retrieves a KMS key by type from SSM parameters. Key types defined in `AcceleratorKeyType`:

- `CLOUDWATCH_KEY`, `LAMBDA_KEY`, `S3_KEY`, `SNS_KEY`, `SQS_KEY`, `SECRETS_MANAGER_KEY`, etc.

### `getCentralLogsBucketKey()`
Retrieves the central logs bucket CMK, handling cross-account lookups.

## Policy Generation

### `generatePolicyReplacements()`
Processes policy documents with dynamic replacement tokens:

- `${ACCEL_LOOKUP::ACCOUNT_ID}` → current account ID
- `${ACCEL_LOOKUP::ORG_ID}` → organization ID
- `${ACCEL_LOOKUP::BUCKET::<name>}` → bucket name lookup
- `${ACCEL_LOOKUP::KMS::<name>}` → KMS key ARN lookup

### `getPolicyNamesForTarget(targetName, targetType)`
Returns policy names applicable to a given OU or account.

## SSM Parameter Management

### `addSsmParameter(props)`
Queues an SSM parameter for creation. All parameters are created in batch at the end of synthesis via `createSsmParameters()`.

### `getSsmPath(resourceType, replacements)`
Constructs a standardized SSM parameter path using `SsmResourceType` enum values.

## Other Utilities

| Method | Purpose |
|--------|---------|
| `getOrgPrincipals()` | Creates IAM principal with org ID condition |
| `getPrincipalOrgIdCondition()` | Returns the `aws:PrincipalOrgID` condition |
| `getS3LifeCycleRules()` | Converts config lifecycle rules to S3 format |
| `isManagedByAsea()` | Checks if a resource is managed by ASEA import |
| `addNagSuppression()` | Adds CDK NAG suppression for a resource |
| `getActiveAccountIds()` | Returns all active (non-suspended) account IDs |

## Key Code Path

| Component | File |
|-----------|------|
| Base class | `accelerator/lib/stacks/accelerator-stack.ts` |
| Resource names | `accelerator/lib/accelerator-resource-names.ts` |
