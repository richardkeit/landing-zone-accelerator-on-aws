# Network VPC Endpoints Stack

## Overview

The Network VPC Endpoints stack creates VPC interface and gateway endpoints, AWS Network Firewall instances, and Route 53 Resolver endpoints.

## Deployment Scope

- **Stage:** `network-vpc-endpoints`
- **Deployed to:** Accounts with VPC endpoints or Network Firewall defined, enabled regions
- **Config files consumed:** `network-config.yaml`

## What It Deploys

### Gateway Endpoints
- S3 and DynamoDB gateway endpoints
- Associates with specified route tables

### Interface Endpoints
- Creates VPC interface endpoints for AWS services
- Dedicated security group per endpoint (or shared)
- Deployed in specified subnets
- Custom endpoint policies supported

### AWS Network Firewall
- Creates Network Firewall instances from `network-config.yaml → vpcs[].networkFirewall`
- Associates with firewall policies created in Network Prep
- Configures firewall logging (CloudWatch, S3, Kinesis)
- Creates firewall endpoints in specified subnets

### Route 53 Resolver Endpoints
- **Inbound endpoints** — Allow on-premises DNS to resolve AWS-hosted domains
- **Outbound endpoints** — Allow VPCs to forward DNS queries to on-premises
- Dedicated security groups with configurable port rules
- Deployed in specified subnets in the delegated admin account

### Endpoint Routes
- Creates route table entries pointing to Network Firewall endpoints
- Supports routing traffic through firewall for inspection

## Key Code Paths

| Component | File |
|-----------|------|
| Stack class | `accelerator/lib/stacks/network-stacks/network-vpc-endpoints-stack/network-vpc-endpoints-stack.ts` |

## Config-to-Resource Mapping

| Config Property | Resource Created |
|----------------|-----------------|
| `network-config.yaml → vpcs[].gatewayEndpoints` | S3/DynamoDB gateway endpoints |
| `network-config.yaml → vpcs[].interfaceEndpoints` | Interface VPC endpoints + security groups |
| `network-config.yaml → vpcs[].networkFirewall` | Network Firewall + logging config |
| `network-config.yaml → centralNetworkServices.route53Resolver.endpoints` | Resolver endpoints + security groups |

## Cross-Stack Dependencies

### Reads
- VPC IDs, subnet IDs, route table IDs from Network VPC stack
- Network Firewall policy ARNs from Network Prep stack
- Security group IDs (for shared endpoint SGs)

### Writes (SSM Parameters)
- Network Firewall endpoint IDs (used for routing)
- Resolver endpoint IDs
- Interface endpoint DNS names
