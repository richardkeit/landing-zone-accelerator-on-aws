# Pipeline and Execution Flow

## Overview

The LZA pipeline is an AWS CodePipeline that orchestrates the synthesis and deployment of all accelerator CloudFormation stacks. It is defined in `AcceleratorPipeline` (`lib/pipeline.ts`) and created by the `PipelineStack`.

## Architecture

```
Installer Stack (CloudFormation)
  └─> Creates CodePipeline (AWSAccelerator-Pipeline)
        ├─ Source Stage: pulls config from CodeCommit or S3
        ├─ Build Stage: validates config, runs cdk synth
        ├─ Review Stage (optional): manual approval
        ├─ Deploy Stages: one per pipeline stage (see below)
        └─ Each Deploy Stage runs CodeBuild → cdk deploy
```

## Key Code Paths

| Component | File |
|-----------|------|
| Pipeline definition | `accelerator/lib/pipeline.ts` |
| Core orchestrator | `accelerator/lib/accelerator.ts` |
| CDK toolkit wrapper | `accelerator/lib/toolkit.ts` |
| Stack factory functions | `accelerator/utils/stack-utils.ts` |
| Stage enum | `accelerator/lib/accelerator-stage.ts` |
| App entrypoint | `accelerator/cdk.ts` |

## Execution Flow

### 1. CodePipeline Triggers

The pipeline triggers on commits to the config repository (CodeCommit) or S3 config bucket changes.

### 2. Build Phase

The Build stage runs `cdk.ts` which calls `accelerator.ts → Accelerator.run()`. This method:

1. Loads configuration from the config repository
2. Determines which stage to execute based on environment variables
3. Calls the appropriate `create*Stack()` factory function from `stack-utils.ts`

### 3. Stack Factory Functions

Each stage has a corresponding factory function in `stack-utils.ts`:

```typescript
// Example: createLoggingStack() iterates over all account+region pairs
// and creates a LoggingStack for each
export function createLoggingStack(/* ... */) {
  for (const account of accounts) {
    for (const region of enabledRegions) {
      if (includeStage(context, { stage, account, region })) {
        new LoggingStack(app, stackName, { env: { account, region }, ...props });
      }
    }
  }
}
```

### 4. CDK Toolkit

`AcceleratorToolkit.execute()` wraps the CDK CLI to perform `synth`, `deploy`, `diff`, or `bootstrap` operations. It handles:

- Stack synthesizer configuration (custom deployment roles, centralized buckets)
- Parallel deployment across accounts/regions
- Diff stage comparison (when enabled)

## Stack Synthesizer

All stacks use a custom `DefaultStackSynthesizer` configured with:

- **Qualifier:** `accel`
- **Deployment role:** `<prefix>-Deployment-Role` (configurable via `cdkOptions.customDeploymentRole`)
- **Centralized buckets:** When enabled, all CDK assets go to the management account's bucket with account-prefixed paths

## Pipeline Stages vs. CDK Stages

The pipeline has two types of stages:

1. **Toolkit stages** — Run `cdk bootstrap` to set up CDK infrastructure in target accounts
2. **Deploy stages** — Run `cdk deploy` for each accelerator stage (prepare, accounts, logging, etc.)

## Config Repository

The pipeline supports two config source types:

- **CodeCommit** — Default. Pipeline watches a branch for changes.
- **S3** — Alternative. Config files stored in an S3 bucket.

The source type is determined by the installer stack parameters.

## Diff Stage

When enabled via the installer template, a diff stage runs before deployment to show planned changes. This uses `AcceleratorToolkit.diffStacks()` which runs `cdk diff` against each stack.
