# Stack Walkthroughs

This section provides detailed code-level walkthroughs of each CloudFormation stack deployed by the Landing Zone Accelerator pipeline. Each page explains what the stack deploys, which configuration files drive it, and how it interacts with other stacks.

## Pipeline Stage Order

The LZA core pipeline deploys stacks in the following order. Each stage synthesizes and deploys one CloudFormation stack per account/region pair in scope:

| Order | Stage | Stack Class | Deployed To |
|-------|-------|-------------|-------------|
| 1 | `prepare` | `PrepareStack` | Management account, home region |
| 2 | `accounts` | `AccountsStack` | Management account, global region |
| 3 | `bootstrap` | `BootstrapStack` | All accounts, all enabled regions |
| 4 | `key` | `KeyStack` | Audit account, all enabled regions |
| 5 | `logging` | `LoggingStack` | All accounts, all enabled regions |
| 6 | `organizations` | `OrganizationsStack` | Management account, global region |
| 7 | `security` | `SecurityStack` | All accounts, all enabled regions |
| 8 | `security-resources` | `SecurityResourcesStack` | All accounts, all enabled regions |
| 9 | `security-audit` | `SecurityAuditStack` | Audit account, home region |
| 10 | `operations` | `OperationsStack` | All accounts, all enabled regions |
| 11 | `identity-center` | `IdentityCenterStack` | Management account, home region |
| 12 | `network-prep` | `NetworkPrepStack` | Accounts with network resources, enabled regions |
| 13 | `network-vpc` | `NetworkVpcStack` / V2 stacks | Accounts with VPCs, enabled regions |
| 14 | `network-vpc-endpoints` | `NetworkVpcEndpointsStack` | Accounts with VPC endpoints, enabled regions |
| 15 | `network-vpc-dns` | `NetworkVpcDnsStack` | Accounts with DNS config, enabled regions |
| 16 | `network-associations` | `NetworkAssociationsStack` | Accounts with network associations, enabled regions |
| 17 | `network-associations-gwlb` | `NetworkAssociationsGwlbStack` | Accounts with GWLB/firewall config, enabled regions |
| 18 | `customizations` | `CustomizationsStack` / `ApplicationsStack` | Per deployment targets |
| 19 | `finalize` | `FinalizeStack` | Management account, global region |

!!! note
    Stages 1–2 and 19 run only in the management account. Stage 4 runs only in the audit account. All other stages deploy across multiple accounts based on configuration.

## How Stages Execute

Each pipeline stage triggers an AWS CodeBuild job that runs the CDK toolkit:

```bash
# Synthesize stacks for a stage
yarn run ts-node --transpile-only cdk.ts synth --stage <stage> --config-dir /path/to/config/ --partition aws

# Deploy stacks for a stage
yarn run ts-node --transpile-only cdk.ts deploy --stage <stage> --config-dir /path/to/config/ --partition aws
```

The entrypoint `cdk.ts` invokes `lib/accelerator.ts`, which uses `lib/toolkit.ts` to run parallel CDK synth/deploy operations — one per unique account+region combination.

Stack names follow the pattern:
```
AWSAccelerator-<Stage>Stack-<AccountId>-<Region>
```

## Subpages

- [Pipeline and Execution Flow](./pipeline.md)
- [Prepare](./prepare.md)
- [Accounts](./accounts.md)
- [Bootstrap](./bootstrap.md)
- [Key](./key.md)
- [Logging](./logging.md)
- [Organizations](./organizations.md)
- [Security](./security.md)
- [Security Resources](./security-resources.md)
- [Security Audit](./security-audit.md)
- [Operations](./operations.md)
- [Identity Center](./identity-center.md)
- [Network Prep](./network-prep.md)
- [Network VPC](./network-vpc.md)
- [Network VPC Endpoints](./network-vpc-endpoints.md)
- [Network Associations](./network-associations.md)
- [Network Associations GWLB](./network-associations-gwlb.md)
- [Customizations and Applications](./customizations.md)
- [Finalize](./finalize.md)
- [ASEA Import](./asea-import.md)
