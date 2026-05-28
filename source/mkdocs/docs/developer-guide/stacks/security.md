# Security Stack

## Overview

The Security stack configures account-level security services: Macie, GuardDuty, Security Hub, EBS default encryption, IAM password policy, and Config aggregation.

## Deployment Scope

- **Stage:** `security`
- **Deployed to:** All accounts, all enabled regions
- **Config files consumed:** `security-config.yaml`, `global-config.yaml`

## What It Deploys

### Amazon Macie
- Enables Macie session in each account/region
- Configures export classification results to the central logs bucket
- Respects `excludeRegions` configuration

### Amazon GuardDuty
- Enables GuardDuty detector in each account/region
- Configures S3 protection, EKS protection, and other feature flags
- Respects `excludeRegions` configuration

### AWS Security Hub
- Enables Security Hub in each account/region
- Enables specified security standards (CIS, AWS Foundational, PCI DSS)
- Respects `excludeRegions` configuration

### EBS Default Volume Encryption
- Enables default EBS encryption with a CMK per account/region
- Key alias: `alias/<prefix>/ebs/default-encryption/key`

### IAM Password Policy
- Updates the account-level IAM password policy per `security-config.yaml → iamPasswordPolicy`

### Accelerator Metadata Rule
- AWS Config custom rule that tracks accelerator metadata (bucket names, key ARNs)

### Config Aggregation
- In the aggregation account: creates a Config aggregator spanning all accounts

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/security-stack.ts` |
| Macie construct | `constructs/lib/aws-macie/` |
| GuardDuty construct | `constructs/lib/aws-guardduty/` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `security-config.yaml → centralSecurityServices.macie` | Macie session + export config |
| `security-config.yaml → centralSecurityServices.guardduty` | GuardDuty detector |
| `security-config.yaml → centralSecurityServices.securityHub` | Security Hub + standards |
| `security-config.yaml → centralSecurityServices.ebsDefaultVolumeEncryption` | EBS default encryption CMK |
| `security-config.yaml → iamPasswordPolicy` | IAM password policy |
| `security-config.yaml → awsConfig.aggregation` | Config aggregator |

## Cross-Stack Dependencies

### Reads
- Central logs bucket name and CMK ARN from Logging stack
- CloudWatch KMS key from Key/Logging stacks

### Writes
- EBS default encryption key ARN to SSM
- Security service enablement markers
