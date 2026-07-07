# TransitGateway Module Integration Tests

## Overview

This suite exercises the Landing Zone Accelerator Transit Gateway associations and propagations module against real AWS resources using the chained, manifest-driven test framework. The system under test is `TgwAssociationsAndPropagations.configure`, the LZA wrapper over `@aws-lza` `configureTgw`. Each test manifest applies an incremental configuration change to a single shared baseline and asserts the resulting AWS state. The baseline AWS resources (TGW, route tables, VPCs, VPN, DX Gateway, RAM share) are provisioned once per environment by `tgw-prereqs.sh` and reused across all 32 manifests.

## Prerequisites

- Accounts required in `ENV_MANIFEST`: `Management`, `Network`, `Shared Services`.
- Cross-account trust: `${MANAGEMENT_ACCOUNT_ACCESS_ROLE}` (default `AWSControlTowerExecution`) must be assumable from `Management` into both `Network` and `Shared Services`.
- `deploy-integ-prereqs.sh` has been run once per target environment; it auto-invokes `tgw-prereqs.sh`.
- The prereq script appends the following env vars to the dotenv consumed by the suite:
  - `TGW_INTEG_SSM_PREFIX`
  - `TGW_INTEG_NETWORK_ACCOUNT_ID`
  - `TGW_INTEG_SHARED_SERVICES_ACCOUNT_ID`
  - `TGW_INTEG_HOME_REGION`

## Running

```
yarn test:integration test/integration/modules/tgw/index.test.integration.ts
```

## Test Environment

| Resource        | Name                           | Account         | Details                                         |
| --------------- | ------------------------------ | --------------- | ----------------------------------------------- |
| Transit Gateway | `main-tgw`                     | Network         | ASN 64513, two route tables                     |
| Route Table     | `core-rt`                      | Network         | Primary association target                      |
| Route Table     | `segregated-rt`                | Network         | Secondary association target                    |
| VPC             | `network-vpc` (10.100.0.0/16)  | Network         | Attachment: `network-vpc-attach`                |
| VPC             | `shared-vpc` (10.101.0.0/16)   | Shared Services | Attachment: `shared-vpc-attach` (cross-account) |
| VPC             | `template-vpc` (10.102.0.0/16) | Network         | Attachment: `template-vpc-attach`               |
| VPC             | `template-vpc` (10.103.0.0/16) | Shared Services | Attachment: `template-vpc-attach`               |
| VPN             | `network-vpn`                  | Network         | CGW: `network-cgw` (203.0.113.12, ASN 65000)    |
| DX Gateway      | `network-dxgw`                 | Network         | ASN 64512 (same-account)                        |
| DX Gateway      | `shared-dxgw`                  | Shared Services | ASN 64512 (cross-account, proposal flow)        |

## Test Cases

| #   | Manifest                                      | Scenario                                           | What's Tested                                                                                           |
| --- | --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
|     | **Same-Account VPC/VPN (01–10)**              |                                                    |                                                                                                         |
| 01  | steady-state-empty                            | Empty associations/propagations                    | Module completes with zero operations                                                                   |
| 02  | create-vpc-assoc-core                         | Add VPC association                                | Association creation (VPC → core-rt)                                                                    |
| 03  | create-vpc-prop-both                          | Add VPC propagations                               | Propagation creation (VPC → core-rt + segregated-rt)                                                    |
| 04  | idempotent-rerun                              | Re-run identical config                            | Idempotent re-run detection (config unchanged → skipped)                                                |
| 05  | switch-vpc-assoc-to-segregated                | Move VPC association                               | Association switch (VPC moves from core-rt → segregated-rt)                                             |
| 06  | remove-stale-prop-core                        | Drop one propagation                               | Propagation deletion (core-rt removed, segregated-rt kept)                                              |
| 07  | add-vpn-assoc-prop                            | Add VPN attachment                                 | VPN association + propagation creation (VPN → core-rt)                                                  |
| 08  | delete-vpn-assoc                              | Remove VPN association                             | VPN association deletion (propagation retained)                                                         |
| 09  | remove-all-assoc-keep-props                   | Remove last VPC association                        | Association deletion with propagations retained                                                         |
| 10  | dry-run-noop                                  | Dry-run with drift config                          | Dry-run plans changes but AWS state unchanged                                                           |
|     | **Same-Account DX Gateway (11–14)**           |                                                    |                                                                                                         |
| 11  | dx-gw-create-assoc                            | Create DX GW association                           | DX Gateway direct association creation (same-account), allowedPrefixes verified                         |
| 12  | dx-gw-idempotent-rerun                        | Re-run DX GW config                                | Idempotent re-run detection (DX config unchanged → skipped)                                             |
| 13  | dx-gw-update-allowed-prefixes                 | Update only allowedPrefixes                        | Partial config change triggers re-execution, prefixes updated via UpdateDirectConnectGatewayAssociation |
| 14  | dx-gw-delete-assoc                            | Delete DX GW association                           | DX Gateway disassociation (empty transitGatewayAssociations)                                            |
|     | **Edge Cases (15–18)**                        |                                                    |                                                                                                         |
| 15  | disable-flag                                  | Empty transitGateways array                        | Module skip (no TGWs configured → skipped)                                                              |
| 16  | error-missing-tgw                             | Reference non-existent TGW                         | Error handling (missing TGW SSM param → module fails)                                                   |
| 17  | error-missing-dx-ssm                          | Reference non-existent DX GW                       | Error handling (missing DX GW SSM param → module fails)                                                 |
| 18  | final-restore-empty                           | Clear all same-account state                       | Full teardown (all associations/propagations removed)                                                   |
|     | **Cross-Account (19–29)**                     |                                                    |                                                                                                         |
| 19  | xacct-steady-state-empty                      | Baseline with cross-account VPC                    | Cross-account empty state verification                                                                  |
| 20  | xacct-create-network-assoc                    | Add Network VPC association                        | Cross-account association creation (Network VPC → core-rt)                                              |
| 21  | xacct-create-network-prop                     | Add Network VPC propagation                        | Cross-account propagation creation (Network VPC → core-rt)                                              |
| 22  | xacct-idempotent-rerun                        | Re-run cross-account config                        | Cross-account idempotent detection (unchanged → skipped)                                                |
| 23  | xacct-add-shared-acct-assoc                   | Add Shared Services VPC assoc                      | Cross-account write (Shared Services VPC → segregated-rt)                                               |
| 24  | xacct-switch-network-assoc                    | Move Network VPC association                       | Cross-account association switch (core-rt → segregated-rt)                                              |
| 25  | xacct-delete-shared-assoc                     | Remove Shared Services assoc                       | Cross-account association deletion (Shared Services VPC)                                                |
| 26  | xacct-dx-gw-proposal                          | Cross-account DX GW                                | DX Gateway proposal flow (different account → proposal created), allowedPrefixes verified               |
| 27  | xacct-dx-gw-update-allowed-prefixes           | Update cross-account DX GW prefixes                | Partial config change creates new proposal with updated allowedPrefixes                                 |
| 28  | xacct-error-denied-assume                     | Reference missing xacct attach                     | Error handling (missing cross-account SSM param → module fails)                                         |
| 29  | xacct-final-restore-empty                     | Clear all cross-account state                      | Full cross-account teardown (all associations/propagations removed)                                     |
|     | **VPC Template Collision Regression (30–32)** |                                                    |                                                                                                         |
| 30  | vpc-template-xacct-collision-assoc-core       | Same vpcTemplate name in Network + Shared Services | Duplicate SSM parameter names resolve by logical key; both attachments associate                        |
| 31  | vpc-template-xacct-idempotent-rerun           | Re-run same vpcTemplate config                     | Account/region-aware state hash remains unchanged → skipped                                             |
| 32  | vpc-template-xacct-final-restore-empty        | Clear vpcTemplate associations                     | Full cleanup for template regression                                                                    |

## Assertion Types

| Assertion                            | Description                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `moduleResponseStatus`               | Expected status: `completed`, `skipped`, or `failed`                                                          |
| `moduleResponseOperationCounts`      | Counts of `created`, `updated`, `deleted`, `exists` per category (associations, propagations, dxAssociations) |
| `moduleResponseSkipped`              | Boolean — module short-circuited with no changes                                                              |
| `moduleResponseUnchanged`            | Boolean — dry-run detected no real mutations                                                                  |
| `moduleResponseFailed`               | Regex match on error message for expected failures                                                            |
| `tgwRouteTableAssociations`          | Snapshot of associations per route table after execution                                                      |
| `tgwRouteTablePropagations`          | Snapshot of propagations per route table after execution                                                      |
| `dxGatewayAssociationState`          | DX Gateway association type (`direct`/`proposal`), state, and `allowedPrefixes` verification                  |
| `stateTableLastConfigVpcAttachments` | Validates saved `lastConfig.vpcAttachments` account/region entries                                            |
| `stateTableEntry`                    | DynamoDB state table entry validation                                                                         |

## Known Caveats

- The module's config-change short-circuit means manifests whose `moduleConfig` shape is identical to the previous apply may land on the `SKIPPED` path; assertions account for this.
- Baseline is deploy-only — there is no teardown script; cleanup is a separate manual step.
- The VPN tunnel remains `pending` indefinitely; this is intentional (no real on-prem peer, no hourly charges).
- The Direct Connect Gateway has no physical DX connection attached; only proposals are exercised, which is free.
- Cross-account DX Gateway prefix updates (manifest 27) create a new proposal that requires manual acceptance in the DX GW owner account before prefixes take effect on the AWS side.
