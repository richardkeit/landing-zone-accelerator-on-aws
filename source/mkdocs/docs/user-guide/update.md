# Updating the Solution

For step-by-step instructions on updating the Landing Zone Accelerator to a newer version, please refer to the [Update the solution](https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/update-the-solution.html) section of the Implementation Guide.

## Before You Update

1. Run the core pipeline manually on your current version
2. Troubleshoot any existing issues so your current version runs cleanly
3. Review the [release notes](https://github.com/awslabs/landing-zone-accelerator-on-aws/releases) for the target version

## Update Process Summary

1. Navigate to the CloudFormation console and select the `AWSAccelerator-InstallerStack`
2. Choose **Update** → **Replace current template**
3. Use the latest template URL from the [solution page](https://aws.amazon.com/solutions/implementations/landing-zone-accelerator-on-aws/)
4. Update the **Branch Name** parameter to the release branch of the target version
5. Review and execute the stack update

The update automatically triggers the core pipeline with the new version.

!!! warning
    Always review the release notes for breaking changes before updating. Some version upgrades may require configuration file changes.
