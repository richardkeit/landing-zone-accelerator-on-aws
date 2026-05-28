# Network Prep Stack

## Overview

The Network Prep stack creates foundational networking resources that must exist before VPCs: Transit Gateways, Direct Connect gateways, site-to-site VPN connections, DHCP option sets, prefix lists, and central network service infrastructure (IPAM, Route 53 resolver, DNS firewall).

## Deployment Scope

- **Stage:** `network-prep`
- **Deployed to:** Accounts with network resources defined, enabled regions
- **Config files consumed:** `network-config.yaml`

## What It Deploys

### Default VPC Deletion
- Deletes the default VPC in every account/region (via `DefaultVpcResources`)

### Transit Gateways
- Creates Transit Gateways from `network-config.yaml → transitGateways`
- Creates TGW route tables
- Creates TGW peering roles for cross-account peering

### Site-to-Site VPN
- Creates VPN connections from `network-config.yaml → customerGateways`
- Supports both TGW and VGW attachments

### Direct Connect
- Creates Direct Connect gateways from `network-config.yaml → directConnectGateways`
- Creates virtual interfaces (private, transit)

### Load Balancer IAM Roles
- Creates IAM roles needed for cross-account load balancer operations

### Central Network Services
When `network-config.yaml → centralNetworkServices` is defined:

- **IPAM** — Creates VPC IPAM pools and scopes
- **Route 53 Resolver** — Creates resolver rules, DNS firewall rule groups
- **Network Firewall** — Creates firewall policies and rule groups
- **Prefix Lists** — Creates managed prefix lists

### FMS Resources
- Configures AWS Firewall Manager notification channels

### Managed Active Directory
- Creates roles for accepting MAD share invitations

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/network-stacks/network-prep-stack/network-prep-stack.ts` |
| TGW resources | `network-prep-stack/tgw-resources.ts` |
| VPN resources | `network-prep-stack/vpn-resources.ts` |
| DX resources | `network-prep-stack/dx-resources.ts` |
| Central network | `network-prep-stack/central-network-resources.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `network-config.yaml → transitGateways` | Transit Gateways + route tables |
| `network-config.yaml → customerGateways` | Customer Gateways + VPN connections |
| `network-config.yaml → directConnectGateways` | DX Gateways + virtual interfaces |
| `network-config.yaml → centralNetworkServices.ipams` | IPAM pools |
| `network-config.yaml → centralNetworkServices.route53Resolver` | Resolver rules + DNS firewall |
| `network-config.yaml → centralNetworkServices.networkFirewall` | NFW policies + rule groups |
| `network-config.yaml → prefixLists` | Managed prefix lists |

## Cross-Stack Dependencies

### Writes (SSM Parameters)
- Transit Gateway IDs and route table IDs
- IPAM pool IDs
- Resolver rule IDs, DNS firewall rule group IDs
- Network Firewall policy ARNs
- Prefix list IDs

### Read By
- Network VPC stack (TGW attachments, IPAM pools, prefix lists)
- Network Associations stack (TGW route table associations/propagations, DX associations)
