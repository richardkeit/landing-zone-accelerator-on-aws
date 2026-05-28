# Network VPC Stack

## Overview

The Network VPC stack is the largest and most complex stack. It creates VPCs, subnets, route tables, NAT gateways, internet gateways, security groups, TGW attachments, VPC flow logs, and related resources. It supports both V1 (single stack) and V2 (split across up to 8 stacks per VPC) deployment modes.

## Deployment Scope

- **Stage:** `network-vpc`
- **Deployed to:** Accounts with VPCs defined, enabled regions
- **Config files consumed:** `network-config.yaml`, `global-config.yaml`

## V1 vs V2 Stacks

### V1 (Default for existing environments)
All VPC resources deploy in a single `NetworkVpcStack` per account/region. Limited to ~500 CloudFormation resources per stack.

### V2 (Default for new environments, or `useV2Stacks: true`)
Resources are split across up to 8 stacks per VPC:

| Stack | Resources |
|-------|-----------|
| `VpcBaseStack` | VPC, IGW, VGW, DHCP options, flow logs, additional CIDRs, VPN connections |
| `VpcRouteTablesStack` | Route tables, gateway associations |
| `VpcSubnetsStack` | Subnets, NAT gateways, TGW attachments, route table associations |
| `VpcSecurityGroupsStack` | Security groups and rules |
| `VpcSubnetsShareStack` | RAM resource shares for subnet sharing |
| `VpcRouteEntriesStack` | Route table entries |
| `VpcLoadBalancersStack` | ALBs, NLBs, GWLBs |
| `VpcNaclsStack` | Network ACLs and entries |

Dependencies between V2 stacks are managed automatically.

## What It Deploys

### VPCs
- Creates VPCs from `network-config.yaml → vpcs` and `vpcTemplates`
- Supports static CIDRs and IPAM-allocated CIDRs
- IPv6 support (Amazon-provided and IPAM)
- Central endpoint VPC tagging

### Subnets
- Creates subnets with static or IPAM CIDRs
- Route table associations
- Outpost subnet support
- Availability zone mapping

### Route Tables
- Creates route tables with entries for IGW, NAT GW, TGW, VPC peering, VPN GW, network interfaces
- Gateway route table associations

### Internet and NAT Gateways
- Internet gateways (with egress-only IGW for IPv6)
- NAT gateways with Elastic IP allocation

### Transit Gateway Attachments
- Creates TGW VPC attachments
- Supports cross-account attachments via RAM

### Security Groups
- Creates security groups with ingress/egress rules
- Supports source types: CIDR, prefix list, security group, subnet
- Cross-account security group references for shared VPCs

### VPC Flow Logs
- CloudWatch Logs or S3 destinations
- Configurable log format

### DHCP Options
- Custom DHCP option sets

### VPN Gateway
- Virtual private gateway with custom ASN

### Cross-Account Route Role
- IAM role for cross-account route table management (VPC peering, firewall ENI routes)

### Subnet Sharing (RAM)
- Shares subnets with other accounts via AWS RAM

### Network ACLs
- Creates NACLs with inbound/outbound rules

## Key Code Paths

| Component | File |
|-----------|------|
| V1 Stack class | `accelerator/lib/stacks/network-stacks/network-vpc-stack/network-vpc-stack.ts` |
| V1 VPC resources | `network-vpc-stack/vpc-resources.ts` |
| V2 Base stack | `accelerator/lib/stacks/v2-network/stacks/vpc-base-stack.ts` |
| V2 Subnets stack | `v2-network/stacks/vpc-subnets-base-stack.ts` |
| V2 Security groups | `v2-network/stacks/vpc-security-groups-base-stack.ts` |
| V2 Factory functions | `v2-network/utils/functions.ts` |
| Network base class | `network-stacks/network-stack.ts` |
| Security group utils | `network-stacks/utils/security-group-utils.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `network-config.yaml → vpcs` | VPCs + all child resources |
| `network-config.yaml → vpcTemplates` | Templated VPCs (deployed per target account) |
| `network-config.yaml → vpcs[].routeTables` | Route tables + entries |
| `network-config.yaml → vpcs[].subnets` | Subnets |
| `network-config.yaml → vpcs[].securityGroups` | Security groups + rules |
| `network-config.yaml → vpcs[].networkAcls` | NACLs + entries |
| `network-config.yaml → vpcs[].transitGatewayAttachments` | TGW VPC attachments |
| `network-config.yaml → vpcs[].vpcFlowLogs` | VPC flow logs |
| `global-config.yaml → useV2Stacks` | Enables V2 stack splitting |

## Cross-Stack Dependencies

### Reads
- TGW IDs and route table IDs from Network Prep
- IPAM pool IDs from Network Prep
- Prefix list IDs from Network Prep
- KMS key ARNs from Logging/Key stacks
- VPC flow logs bucket ARN from Logging stack

### Writes (SSM Parameters)
- VPC IDs, subnet IDs, route table IDs, security group IDs
- TGW attachment IDs
- NAT gateway IDs

### Read By
- Network VPC Endpoints, Network Associations, Network Associations GWLB stacks

## Common Issues

| Error | Cause | Resolution |
|-------|-------|------------|
| 500 resource limit | Too many resources in a single V1 stack | Enable V2 stacks (`useV2Stacks: true`) |
| IPAM allocation failure | IPAM pool exhausted or wrong region | Check IPAM pool capacity and region configuration |
| Cross-account TGW attachment failure | RAM share not accepted | Verify RAM auto-accept or manual acceptance |
| Security group circular reference | SG A references SG B and vice versa | Use placeholder rules and update in a second pass |
