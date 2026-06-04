/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import { SecurityGroup } from '../../lib/aws-ec2/vpc';
import { VpcEndpoint, VpcEndpointType } from '../../lib/aws-ec2/vpc-endpoint';
import { snapShotTest } from '../snapshot-test';
import { describe, it, expect } from 'vitest';

const testNamePrefix = 'Construct(VpcEndpoint): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

const securityGroup = new SecurityGroup(stack, 'TestSecurityGroup`', {
  securityGroupName: 'TestSecurityGroup',
  description: `AWS Private Endpoint Zone`,
  vpcId: 'Test',
});

/**
 * VpcEndpoint construct test
 */
describe('VpcEndpoint', () => {
  it('vpc gateway end point type test', () => {
    const initialStack = new VpcEndpoint(stack, 'VpcEndpoint', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GATEWAY,
      service: 'service',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
    expect(typeof initialStack.createEndpointRoute('id', 'routeTableId', '10.100.0.0/16')).toBe('undefined');
  });
  it('vpc interface end point type test with sagemaker', () => {
    new VpcEndpoint(stack, 'VpcEndpointInterfaceSagemaker', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 'notebook',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
  });
  it('vpc interface end point type test with s3 global access', () => {
    new VpcEndpoint(stack, 'VpcEndpointInterfaceS3', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 's3-global.accesspoint',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
  });
  it('vpc interface end point type test with serviceName', () => {
    new VpcEndpoint(stack, 'VpcEndpointInterfaceEc2', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      serviceName: 'ec2',
      service: 'ec2',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
  });
  it('vpc interface end point type test with gwlb', () => {
    new VpcEndpoint(stack, 'VpcEndpointInterfaceGwlb', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GWLB,
      serviceName: 'ec2',
      service: 'ec2',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
  });

  it('vpc gateway end point for s3', () => {
    VpcEndpoint.fromAttributes(stack, 'ImportedVpcEndpointS3', {
      service: 's3',
      vpcEndpointId: 'importedEndpointId',
      vpcId: 'Test',
    });
  });
  it('serviceName override for gatewayEndpoint', () => {
    const checkVpcEndpointGatewayEndpointServiceNameStack = new cdk.Stack();
    new VpcEndpoint(checkVpcEndpointGatewayEndpointServiceNameStack, 'VpcEndpointGatewayEndpointServiceName', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GATEWAY,
      service: 'service',
      serviceName: 'testGatewayEndpointServiceName',
      subnets: ['Test1', 'Test2'],
      securityGroups: [securityGroup],
      privateDnsEnabled: true,
      policyDocument: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            sid: 'AccessToTrustedPrincipalsAndResources',
            actions: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW,
            resources: ['*'],
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': ['organizationId'],
              },
            },
          }),
        ],
      }),
      routeTables: ['Test1', 'Test2'],
    });
    const checkVpcEndpointGatewayEndpointServiceNameTemplate = cdk.assertions.Template.fromStack(
      checkVpcEndpointGatewayEndpointServiceNameStack,
    );
    checkVpcEndpointGatewayEndpointServiceNameTemplate.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: cdk.assertions.Match.exact('testGatewayEndpointServiceName'),
    });
  });

  snapShotTest(testNamePrefix, stack);

  it('vpc interface endpoint uses partition-aware service prefix for aws-eusc', () => {
    const euscStack = new cdk.Stack(undefined, 'EuscStack', {
      env: { account: '123456789012', region: 'eusc-de-east-1' },
    });
    const euscSg = new SecurityGroup(euscStack, 'EuscSg', {
      securityGroupName: 'EuscSg',
      description: 'Test SG',
      vpcId: 'Test',
    });
    new VpcEndpoint(euscStack, 'VpcEndpointEusc', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 'ecr.dkr',
      subnets: ['Test1', 'Test2'],
      securityGroups: [euscSg],
      privateDnsEnabled: true,
      partition: 'aws-eusc',
    });
    const template = cdk.assertions.Template.fromStack(euscStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: cdk.assertions.Match.exact('eu.amazonaws.eusc-de-east-1.ecr.dkr'),
    });
  });

  it('vpc interface endpoint uses partition-aware service prefix for aws-cn', () => {
    const cnStack = new cdk.Stack(undefined, 'CnStack', {
      env: { account: '123456789012', region: 'cn-north-1' },
    });
    const cnSg = new SecurityGroup(cnStack, 'CnSg', {
      securityGroupName: 'CnSg',
      description: 'Test SG',
      vpcId: 'Test',
    });
    new VpcEndpoint(cnStack, 'VpcEndpointCn', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 'ecr.dkr',
      subnets: ['Test1', 'Test2'],
      securityGroups: [cnSg],
      privateDnsEnabled: true,
      partition: 'aws-cn',
    });
    const template = cdk.assertions.Template.fromStack(cnStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: cdk.assertions.Match.exact('cn.com.amazonaws.cn-north-1.ecr.dkr'),
    });
  });

  it('vpc interface endpoint defaults to com.amazonaws for standard partition', () => {
    const awsStack = new cdk.Stack(undefined, 'AwsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const awsSg = new SecurityGroup(awsStack, 'AwsSg', {
      securityGroupName: 'AwsSg',
      description: 'Test SG',
      vpcId: 'Test',
    });
    new VpcEndpoint(awsStack, 'VpcEndpointAws', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 'ecr.dkr',
      subnets: ['Test1', 'Test2'],
      securityGroups: [awsSg],
      privateDnsEnabled: true,
      partition: 'aws',
    });
    const template = cdk.assertions.Template.fromStack(awsStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: cdk.assertions.Match.exact('com.amazonaws.us-east-1.ecr.dkr'),
    });
  });

  it('vpc gwlb endpoint uses partition-aware service prefix for aws-eusc', () => {
    const euscGwlbStack = new cdk.Stack(undefined, 'EuscGwlbStack', {
      env: { account: '123456789012', region: 'eusc-de-east-1' },
    });
    new VpcEndpoint(euscGwlbStack, 'VpcEndpointGwlbEusc', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GWLB,
      service: 'vpce-svc-12345',
      subnets: ['Test1', 'Test2'],
      partition: 'aws-eusc',
    });
    const template = cdk.assertions.Template.fromStack(euscGwlbStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: cdk.assertions.Match.exact('eu.amazonaws.vpce.eusc-de-east-1.vpce-svc-12345'),
    });
  });

  it('interface endpoint includes Name tag when name is provided', () => {
    const tagStack = new cdk.Stack(undefined, 'TagInterfaceStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const sg = new SecurityGroup(tagStack, 'TagSg', {
      securityGroupName: 'TagSg',
      description: 'Test SG',
      vpcId: 'Test',
    });
    new VpcEndpoint(tagStack, 'VpcEndpointWithName', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.INTERFACE,
      service: 'ec2',
      subnets: ['Test1'],
      securityGroups: [sg],
      privateDnsEnabled: true,
      name: 'my-vpc-ec2',
    });
    const template = cdk.assertions.Template.fromStack(tagStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      Tags: [{ Key: 'Name', Value: 'my-vpc-ec2' }],
    });
  });

  it('gateway endpoint includes Name tag when name is provided', () => {
    const tagStack = new cdk.Stack(undefined, 'TagGatewayStack');
    new VpcEndpoint(tagStack, 'VpcEndpointGwWithName', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GATEWAY,
      service: 's3',
      routeTables: ['rt-1'],
      name: 'my-vpc-s3',
    });
    const template = cdk.assertions.Template.fromStack(tagStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      Tags: [{ Key: 'Name', Value: 'my-vpc-s3' }],
    });
  });

  it('gwlb endpoint includes Name tag when name is provided', () => {
    const tagStack = new cdk.Stack(undefined, 'TagGwlbStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new VpcEndpoint(tagStack, 'VpcEndpointGwlbWithName', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GWLB,
      service: 'vpce-svc-12345',
      subnets: ['Test1'],
      name: 'my-vpc-gwlb',
    });
    const template = cdk.assertions.Template.fromStack(tagStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      Tags: [{ Key: 'Name', Value: 'my-vpc-gwlb' }],
    });
  });

  it('endpoint does not include tags when name is not provided', () => {
    const tagStack = new cdk.Stack(undefined, 'NoTagStack');
    new VpcEndpoint(tagStack, 'VpcEndpointNoName', {
      vpcId: 'Test',
      vpcEndpointType: VpcEndpointType.GATEWAY,
      service: 's3',
      routeTables: ['rt-1'],
    });
    const template = cdk.assertions.Template.fromStack(tagStack);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      Tags: cdk.assertions.Match.absent(),
    });
  });
});
