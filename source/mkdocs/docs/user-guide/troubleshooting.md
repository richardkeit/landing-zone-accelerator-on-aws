# Troubleshooting

For the full troubleshooting guide including the diagnostics pack, see the [Troubleshooting](https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/troubleshooting.html) section of the Implementation Guide.

## Common Pipeline Errors

### Environment Validation Failures

These errors occur during the Prepare stage when the `validate-environment` Lambda detects configuration issues.

| Error Message | Cause | Resolution |
|--------------|-------|------------|
| SCP count exceeds limit | Adding SCPs would exceed the 5-per-target limit | Consolidate or remove SCPs |
| Account not found in organization | Config references an account email not in the org | Verify account emails in `accounts-config.yaml` |
| OU not found in organization | Config references a non-existent OU | Create the OU or fix `organization-config.yaml` |
| CIDR order validation failed | VPC CIDRs were reordered in config | Maintain original CIDR order; append new CIDRs |
| Stack in ROLLBACK state | A previous deployment left a stack in a failed state | Delete the rolled-back stack and retry |

### CloudFormation Stack Failures

| Error Pattern | Likely Stage | Resolution |
|--------------|-------------|------------|
| `TerminationProtection is enabled` | Any (during cleanup) | Disable termination protection, then delete |
| `Resource limit exceeded` | Network VPC | Enable V2 stacks (`useV2Stacks: true`) |
| `NoAvailableConfigurationRecorder` | Security Resources | Ensure AWS Config is enabled; for Control Tower, update accounts first |
| `Export with name already exists` | Any | Check for stack name collisions from previous deployments |

### Control Tower Specific

| Issue | Resolution |
|-------|------------|
| Accounts show "Update Available" after adding a region | Manually update accounts in Control Tower (5 at a time) before retrying the pipeline |
| Landing Zone update fails | Ensure Control Tower is managed by LZA via `controlTower/landingZone` in `global-config.yaml` |

## Diagnostics Pack

LZA includes a diagnostics pack that collects pipeline status, stack status, and configuration information. See the [Implementation Guide](https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/diagnostics-pack.html) for instructions on generating a diagnostics report.

## Getting Help

File support tickets via the [AWS Support console](https://support.console.aws.amazon.com/support/home) using **Service: Control Tower → Category: Landing Zone Accelerator**.
