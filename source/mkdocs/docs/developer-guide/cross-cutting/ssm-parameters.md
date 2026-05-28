# SSM Parameter Conventions

## Overview

LZA uses AWS Systems Manager Parameter Store as the primary mechanism for sharing resource identifiers between stacks. Since stacks deploy independently across accounts and regions, SSM parameters provide a consistent lookup mechanism.

## Naming Convention

All LZA SSM parameters follow the pattern:

```
/<prefix>/<resource-type>/<resource-name>/<attribute>
```

Where `<prefix>` defaults to `/accelerator` (configurable via installer stack).

## How Stacks Write Parameters

Every stack calls `this.createSsmParameters()` at the end of its constructor. Parameters are queued during stack execution via `this.ssmParameters.push()`:

```typescript
this.ssmParameters.push({
  logicalId: 'MyVpcIdParameter',
  parameterName: `${props.prefixes.ssmParamName}/network/vpc/my-vpc/id`,
  stringValue: vpc.vpcId,
});
```

## How Stacks Read Parameters

Downstream stacks read parameters using `cdk.aws_ssm.StringParameter.valueForStringParameter()`:

```typescript
const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
  this,
  `${props.prefixes.ssmParamName}/network/vpc/my-vpc/id`,
);
```

## Cross-Account Parameter Access

For cross-account lookups, LZA creates dedicated IAM roles:

- `<prefix>-CrossAccount-SsmParameter-Role` — General cross-account SSM parameter access
- `<prefix>-<region>-CentralBucket-KeyArnParam-Role` — Central log bucket CMK ARN access
- `<prefix>-CrossAccount-SecretsKms-Role` — Secrets Manager CMK access

## Common Parameter Paths

| Parameter Path | Written By | Read By |
|---------------|------------|---------|
| `/<prefix>/kms/key` | Key Stack | All stacks |
| `/<prefix>/logging/central-bucket/name` | Logging Stack | Security, Organizations |
| `/<prefix>/logging/central-bucket/kms/arn` | Logging Stack | Security, Organizations |
| `/<prefix>/network/vpc/<name>/id` | Network VPC | Network Endpoints, Associations |
| `/<prefix>/network/vpc/<name>/subnet/<name>/id` | Network VPC | Network Endpoints, Associations |
| `/<prefix>/network/transitGateway/<name>/id` | Network Prep | Network VPC, Associations |
| `/<prefix>/network/transitGateway/<name>/routeTable/<name>/id` | Network Prep | Network Associations |
| `/<prefix>/organizations/scp/<name>/id` | Accounts Stack | Finalize Stack |
| `/<prefix>/configuration/configCommitId` | Finalize Stack | Pipeline (next run) |

## SsmResourceType Enum

The `SsmResourceType` enum in `accelerator-stack.ts` defines standardized path segments for parameter names. The `getSsmPath()` method constructs full parameter paths from this enum.

## Best Practices for Contributors

1. Always use `this.ssmParameters.push()` rather than creating SSM parameters directly
2. Follow the existing naming convention for new parameter paths
3. Document new parameters in the stack walkthrough page
4. Use `SsmResourceType` enum values when constructing paths
