# Network Associations GWLB Stack

## Overview

The Network Associations GWLB stack deploys Gateway Load Balancer infrastructure, EC2 firewall instances and auto-scaling groups, firewall VPN connections (customer gateways), GWLB endpoints, and network interface routing for third-party firewall appliances.

## Deployment Scope

- **Stage:** `network-associations-gwlb`
- **Deployed to:** Accounts with GWLB or firewall configurations, enabled regions
- **Config files consumed:** `network-config.yaml`, `customizations-config.yaml`

## What It Deploys

### EC2 Firewall Instances
- Creates individual EC2 firewall instances from `network-config.yaml → vpcs[].firewallInstances`
- Processes launch template replacements (AMI IDs, security groups, subnets)

### Firewall Auto Scaling Groups
- Creates ASGs for firewall appliances from `network-config.yaml → vpcs[].firewallAutoScalingGroups`
- Launch template with network interface configuration
- Security group and subnet replacements

### Firewall Target Groups
- Creates target groups for GWLB health checks
- Supports instance and IP target types
- Registers firewall instances as targets

### Gateway Load Balancers
- Creates GWLBs from `network-config.yaml → vpcs[].gatewayLoadBalancers`
- Creates GWLB listeners

### GWLB Endpoints
- Creates GWLB endpoints in specified subnets
- Creates VPC endpoint services

### GWLB Route Table Entries
- Creates routes pointing to GWLB endpoints for traffic inspection

### Firewall VPN Resources
- Creates customer gateways based on firewall instance IPs
- Creates VPN connections (TGW or VGW attached)
- TGW route table associations, propagations, and static routes for VPN attachments

### Network Interface Routes
- Creates routes pointing to firewall ENIs
- Supports cross-account routing via custom resource provider

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/network-stacks/network-associations-gwlb-stack/network-associations-gwlb-stack.ts` |
| Firewall VPN resources | `network-associations-gwlb-stack/firewall-vpn-resources.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `network-config.yaml → vpcs[].gatewayLoadBalancers` | GWLBs + listeners |
| `network-config.yaml → vpcs[].firewallInstances` | EC2 firewall instances |
| `network-config.yaml → vpcs[].firewallAutoScalingGroups` | Firewall ASGs |
| `network-config.yaml → customerGateways` (firewall-linked) | Customer gateways + VPN connections |

## Cross-Stack Dependencies

### Reads
- VPC IDs, subnet IDs, security group IDs from Network VPC
- TGW IDs and route table IDs from Network Prep
- Firewall instance IDs and ENI IDs (from SSM lookups)

### Writes
- GWLB endpoint IDs
- GWLB ARNs
- Customer gateway IDs
- VPN connection IDs
