# TGW Associations & Propagations Module

## Architecture

This module follows the two-layer pattern established by the Macie module:

1. **LZA Action** (`accelerator/lib/actions/network/tgw-associations-and-propagations.ts`)
   - Reads `ModuleParams` (LZA config, session context)
   - Extracts config for DynamoDB state comparison
   - Builds `ITgwModuleRequest` with resolved account IDs
   - Calls `configureTgw()` from `aws-lza`
   - Saves execution state

2. **Module** (`aws-lza/lib/transit-gateway/`)
   - Receives self-contained `ITgwModuleRequest`
   - Phase 1: Resolves TGW/RT/attachment IDs (SSM or Describe APIs)
   - Phase 2: Creates/deletes associations and propagations (TODO)
   - Phase 3: DX Gateway associations (TODO)
   - Returns `ITgwModuleResponse`

The Module is decoupled from LZA config and can be invoked from:
- LZA pipeline (via the Action)
- CLI (`aws-lza setup transit-gateway -c config.json`)
- Tests (directly with mock `ITgwModuleRequest`)

## Standalone Local Testing

When running this module locally via `npx ts-node lib/runner.ts`, several workarounds are needed because the full LZA pipeline infrastructure is not present.

### Prerequisites

```bash
# From source/ directory — wire up workspace symlinks
yarn install

# Rebuild aws-lza dist (may be stale)
cd source/packages/@aws-lza && npx tsc --build
```

### Workaround 1: DynamoDB Module State Table

The module requires a DynamoDB state table that is normally deployed by the LZA Installer pipeline. Deploy it manually:

```bash
aws cloudformation deploy \
  --stack-name AWSAccelerator-ModuleInfrastructureStack-<ACCOUNT_ID>-<REGION> \
  --template-file source/packages/@aws-accelerator/installer/lib/cloudformation/module-infrastructure.yaml \
  --parameter-overrides AcceleratorPrefix=AWSAccelerator \
  --region <REGION> \
  --no-fail-on-empty-changeset
```

### Workaround 2: Organization Account Loading

```bash
export ACCELERATOR_SKIP_DYNAMODB_LOOKUP=true
```

### Full Local Test Command

```bash
cd source/packages/@aws-accelerator/accelerator

AWS_ACCESS_KEY_ID=<KEY> \
AWS_SECRET_ACCESS_KEY=<SECRET> \
AWS_SESSION_TOKEN=<TOKEN> \
ACCELERATOR_SKIP_DYNAMODB_LOOKUP=true \
LOG_LEVEL=info \
npx ts-node lib/runner.ts \
  --config-dir <PATH_TO_CONFIG> \
  --stage network-associations \
  --region us-east-1 \
  --dry-run \
  --verbose
```

### Cleanup Checklist (Before Merge)

- [ ] Delete the manually-created CloudFormation stacks from test accounts if no longer needed
- [ ] Convert this README to permanent documentation
