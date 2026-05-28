# Customizations and Applications Stacks

## Overview

The Customizations stage deploys two types of stacks: the `CustomizationsStack` for CloudFormation StackSets and Service Catalog portfolios, and the `ApplicationsStack` for application workloads (ALBs, NLBs, ASGs, launch templates).

## Deployment Scope

- **Stage:** `customizations`
- **Deployed to:** Per deployment targets in `customizations-config.yaml`
- **Config files consumed:** `customizations-config.yaml`, `network-config.yaml`

## CustomizationsStack

### CloudFormation StackSets
- Deploys custom CloudFormation StackSets from `customizations-config.yaml → customizations.cloudFormationStackSets`
- Self-managed permission model
- Supports deployment target accounts and regions
- StackSet dependency ordering via `dependsOn`
- Configurable operation preferences (failure tolerance, concurrency)

### Service Catalog Portfolios
- Creates Service Catalog portfolios from `customizations-config.yaml → customizations.serviceCatalogPortfolios`
- Creates products within portfolios
- Manages portfolio sharing and associations

### Custom Stacks
- Deploys individual CloudFormation stacks (not StackSets) from `customizations-config.yaml → customizations.cloudFormationStacks`
- Supports run order and dependency management
- Deployed as nested stacks within the customizations stage

## ApplicationsStack

### Launch Templates
- Creates EC2 launch templates with configurable block device mappings, network interfaces, security groups
- KMS key replacement for EBS encryption

### Auto Scaling Groups
- Creates ASGs with launch template references
- Configurable min/max/desired capacity

### Application Load Balancers
- Creates ALBs with listeners, target groups, and routing rules
- Certificate support via ACM

### Network Load Balancers
- Creates NLBs with listeners and target groups

## Key Code Paths

| Component | File |
|-----------|------|
| Customizations stack | `accelerator/lib/stacks/customizations-stack.ts` |
| Applications stack | `accelerator/lib/stacks/applications-stack.ts` |
| Custom stack | `accelerator/lib/stacks/custom-stack.ts` |
| Stack factory | `accelerator/utils/stack-utils.ts → createCustomizationsStacks()` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `customizations-config.yaml → customizations.cloudFormationStackSets` | CloudFormation StackSets |
| `customizations-config.yaml → customizations.cloudFormationStacks` | CloudFormation stacks |
| `customizations-config.yaml → customizations.serviceCatalogPortfolios` | Service Catalog portfolios + products |
| `customizations-config.yaml → applications` | ALBs, NLBs, ASGs, launch templates |
