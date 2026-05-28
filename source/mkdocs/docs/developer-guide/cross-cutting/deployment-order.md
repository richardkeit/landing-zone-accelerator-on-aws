# Stack Deployment Order

## Overview

The LZA pipeline deploys stacks in a strict order to satisfy resource dependencies. This page documents the full deployment sequence, what each stage depends on, and which accounts/regions are targeted.

## Deployment Sequence Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AWSAccelerator-Pipeline                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐       │
│  │ PREPARE  │──▶│ ACCOUNTS │──▶│ BOOTSTRAP │──▶│   KEY    │       │
│  │ Mgmt/Home│   │ Mgmt/Glb │   │ All/All   │   │Audit/All │       │
│  └──────────┘   └──────────┘   └───────────┘   └──────────┘       │
│       │                                              │               │
│       ▼                                              ▼               │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────┐       │
│  │ LOGGING  │──▶│ORGANIZATIONS │──▶│      SECURITY        │       │
│  │ All/All  │   │  Mgmt/Glb    │   │      All/All         │       │
│  └──────────┘   └──────────────┘   └──────────────────────┘       │
│       │                                              │               │
│       ▼                                              ▼               │
│  ┌──────────────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │SECURITY RESOURCES│──▶│SECURITY AUDIT│──▶│  OPERATIONS  │       │
│  │     All/All      │   │  Audit/Home  │   │   All/All    │       │
│  └──────────────────┘   └──────────────┘   └──────────────┘       │
│       │                                              │               │
│       ▼                                              ▼               │
│  ┌───────────────┐   ┌─────────────┐   ┌─────────────────┐        │
│  │IDENTITY CENTER│──▶│ NETWORK PREP│──▶│  NETWORK VPC    │        │
│  │  Mgmt/Home    │   │  Targeted   │   │   Targeted      │        │
│  └───────────────┘   └─────────────┘   └─────────────────┘        │
│       │                                              │               │
│       ▼                                              ▼               │
│  ┌───────────────────┐   ┌───────────────────────┐                  │
│  │NETWORK VPC        │──▶│NETWORK VPC DNS        │                  │
│  │ENDPOINTS Targeted │   │       Targeted        │                  │
│  └───────────────────┘   └───────────────────────┘                  │
│       │                                                              │
│       ▼                                                              │
│  ┌───────────────────┐   ┌───────────────────────┐                  │
│  │NETWORK            │──▶│NETWORK ASSOCIATIONS   │                  │
│  │ASSOCIATIONS       │   │GWLB    Targeted       │                  │
│  │    Targeted       │   └───────────────────────┘                  │
│  └───────────────────┘              │                                │
│       │                             ▼                                │
│       ▼                  ┌──────────────────┐                        │
│  ┌──────────────┐        │    FINALIZE      │                        │
│  │CUSTOMIZATIONS│───────▶│    Mgmt/Glb      │                        │
│  │  Targeted    │        └──────────────────┘                        │
│  └──────────────┘                                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Legend:** `Mgmt` = Management account, `Glb` = Global region, `Home` = Home region, `All` = All accounts/regions, `Targeted` = Per deployment targets in config

## Dependency Chain

| Stage | Depends On | Why |
|-------|-----------|-----|
| Prepare | — | First stage; validates environment |
| Accounts | Prepare | Needs config table and validated accounts |
| Bootstrap | Accounts | Needs accounts to exist for CDK bootstrap |
| Key | Bootstrap | Needs CDK infrastructure to deploy |
| Logging | Key | Needs accelerator CMK for bucket encryption |
| Organizations | Logging | Needs central logs bucket for CloudTrail |
| Security | Organizations | Needs delegated admin enabled |
| Security Resources | Security | Needs security services enabled |
| Security Audit | Security Resources | Needs Config recorder running |
| Operations | Security Audit | Needs security baseline complete |
| Identity Center | Operations | Needs IAM infrastructure |
| Network Prep | Identity Center | Needs IAM roles for cross-account networking |
| Network VPC | Network Prep | Needs TGWs, IPAM pools, prefix lists |
| Network VPC Endpoints | Network VPC | Needs VPCs, subnets, route tables |
| Network VPC DNS | Network VPC Endpoints | Needs resolver endpoints, interface endpoint DNS |
| Network Associations | Network VPC DNS | Needs all VPC resources for associations |
| Network Associations GWLB | Network Associations | Needs TGW associations for firewall routing |
| Customizations | Network Associations GWLB | Needs full network topology |
| Finalize | Customizations | Re-evaluates SCPs with all resource IDs |

## Account Targeting

| Target | Stages |
|--------|--------|
| Management account only | Prepare, Accounts, Organizations, Identity Center, Finalize |
| Audit account only | Key, Security Audit |
| All accounts | Bootstrap, Logging, Security, Security Resources, Operations |
| Per config targets | Network Prep, Network VPC, Network VPC Endpoints, Network VPC DNS, Network Associations, Network Associations GWLB, Customizations |
