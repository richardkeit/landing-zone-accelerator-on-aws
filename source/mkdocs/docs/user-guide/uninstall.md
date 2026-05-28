# Uninstalling the Solution

For complete uninstall instructions, please refer to the [Uninstall the solution](https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/uninstall-the-solution.html) section of the Implementation Guide.

## Uninstall Process Summary

### Step 1: Delete the Installer and Core Pipelines

Delete the `AWSAccelerator-InstallerStack` and `AWSAccelerator-PipelineStack` CloudFormation stacks. Both have termination protection enabled — you must disable it before deletion.

### Step 2: Delete S3 Buckets

Empty and delete all `aws-accelerator-*` S3 buckets in each managed account. These are retained by default to prevent accidental data loss.

### Step 3: Delete Additional CloudFormation Stacks

Delete the remaining `AWSAccelerator-*` stacks in each account and region. Delete in reverse deployment order to avoid dependency issues. See the [Stack Deployment Order](../developer-guide/cross-cutting/deployment-order.md) for the correct ordering.

!!! danger
    Uninstalling the solution removes all accelerator-managed infrastructure. Ensure you have backups of any data you need to retain.
