# Network Associations Stack

## Overview

The Network Associations stack creates cross-VPC and cross-account network associations: TGW route table associations/propagations, TGW static routes, TGW peering, Direct Connect gateway associations, VPC peering, Route 53 resolver rule associations, DNS firewall associations, hosted zone associations, cross-account NACLs, Managed Active Directory, and load balancers.

## Deployment Scope

- **Stage:** `network-associations`
- **Deployed to:** Accounts with network associations defined, enabled regions
- **Config files consumed:** `network-config.yaml`

## What It Deploys

### Transit Gateway Associations
- **Route table associations** — Associates TGW attachments with route tables
- **Route table propagations** — Propagates routes from attachments to route tables
- **Static routes** — Creates static routes in TGW route tables (to attachments, blackhole, or prefix list references)
- **TGW peering** — Looks up peering attachment IDs for cross-region/cross-account TGW peering
- **TGW Connect** — Creates TGW Connect attachments

### Direct Connect
- DX gateway → TGW associations
- DX TGW route table associations and propagations

### VPC Peering
- Creates VPC peering connections
- Creates routes in both requester and accepter VPCs
- Supports cross-account peering

### Route 53 Associations
- **Resolver rule associations** — Associates resolver rules with VPCs
- **Query log config associations** — Associates query logging configs with VPCs
- **DNS firewall associations** — Associates DNS firewall rule groups with VPCs
- **Hosted zone associations** — Associates private hosted zones with VPCs (for central endpoint VPCs)

### Cross-Account NACLs
- Creates NACL rules that reference IPAM-allocated subnets in other accounts

### Managed Active Directory
- Creates and configures Managed AD instances
- Shares AD with other accounts via RAM
- Updates resolver group rules for AD DNS

### Subnet Tag Sharing
- Propagates tags to shared subnets in consuming accounts

### Load Balancers
- Creates ALB and NLB listeners
- Creates target groups (IP and instance types)

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/network-stacks/network-associations-stack/network-associations-stack.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `network-config.yaml → transitGateways[].routeTables` | TGW RT associations + propagations |
| `network-config.yaml → transitGatewayStaticRoutes` | TGW static routes |
| `network-config.yaml → transitGatewayPeering` | TGW peering attachments |
| `network-config.yaml → directConnectGateways[].transitGatewayAssociations` | DX-TGW associations |
| `network-config.yaml → vpcPeering` | VPC peering connections + routes |
| `network-config.yaml → vpcs[].resolverRules` | Resolver rule associations |
| `network-config.yaml → vpcs[].queryLogs` | Query log associations |
| `network-config.yaml → vpcs[].networkFirewall.dnsFirewallRuleGroups` | DNS firewall associations |

## Cross-Stack Dependencies

### Reads
- TGW IDs, route table IDs, attachment IDs from Network Prep and Network VPC
- VPC IDs, subnet IDs, route table IDs from Network VPC
- Resolver rule IDs, DNS firewall rule group IDs from Network Prep
- Prefix list IDs from Network Prep

### Writes
- VPC peering connection IDs
- Managed AD configuration parameters
