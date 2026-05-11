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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../lib/aws-elasticloadbalancingv2/nlb-ip-lookup/index';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils';

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'mockAccessKeyId',
        SecretAccessKey: 'mockSecretAccessKey',
        SessionToken: 'mockSessionToken',
      },
    }),
  })),
  AssumeRoleCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      NetworkInterfaces: [{ PrivateIpAddress: '10.1.0.50' }, { PrivateIpAddress: '10.1.1.50' }],
    }),
  })),
  DescribeNetworkInterfacesCommand: vi.fn(),
}));

vi.mock('@aws-accelerator/utils/lib/throttle', () => ({
  throttlingBackOff: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

describe('NLB IP Lookup Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SOLUTION_ID'] = 'test-solution';
  });

  it('should set AvailabilityZone to all for static IP targets', async () => {
    const event: CloudFormationCustomResourceEvent = {
      RequestType: 'Create',
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
      ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/test',
      StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
      RequestId: 'unique-id-1234',
      ResourceType: 'Custom::NLBAddresses',
      LogicalResourceId: 'NLBAddresses',
      ResourceProperties: {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
        region: 'us-east-1',
        targets: ['10.0.1.100', '10.0.2.200'],
        assumeRoleName: 'TestRole',
        partition: 'aws',
      },
    };

    const result = await handler(event);
    expect(result).toBeDefined();
    expect(result!.Data!.ipAddresses).toBeDefined();

    const ipAddresses = result!.Data!.ipAddresses as Array<{ Id: string; AvailabilityZone?: string }>;
    expect(ipAddresses).toHaveLength(2);

    for (const addr of ipAddresses) {
      expect(addr.Id).toBeDefined();
      expect(addr.AvailabilityZone).toBe('all');
    }
  });

  it('should set AvailabilityZone to all for mixed NLB and static IP targets', async () => {
    const event: CloudFormationCustomResourceEvent = {
      RequestType: 'Create',
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
      ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/test',
      StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
      RequestId: 'unique-id-1234',
      ResourceType: 'Custom::NLBAddresses',
      LogicalResourceId: 'NLBAddresses',
      ResourceProperties: {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
        region: 'us-east-1',
        targets: [{ account: '111111111111', region: 'us-east-1', nlbName: 'test-nlb' }, '10.0.3.100'],
        assumeRoleName: 'TestRole',
        partition: 'aws',
      },
    };

    const result = await handler(event);
    expect(result).toBeDefined();

    const ipAddresses = result!.Data!.ipAddresses as Array<{ Id: string; AvailabilityZone?: string }>;
    // 2 from NLB ENIs + 1 static IP
    expect(ipAddresses).toHaveLength(3);

    for (const addr of ipAddresses) {
      expect(addr.Id).toBeDefined();
      expect(addr.AvailabilityZone).toBe('all');
    }
  });

  it('should return success with no data on Delete', async () => {
    const event: CloudFormationCustomResourceEvent = {
      RequestType: 'Delete',
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
      ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/test',
      StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
      RequestId: 'unique-id-1234',
      ResourceType: 'Custom::NLBAddresses',
      LogicalResourceId: 'NLBAddresses',
      PhysicalResourceId: 'physical-id-1234',
      ResourceProperties: {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
        region: 'us-east-1',
        targets: ['10.0.1.100'],
        assumeRoleName: 'TestRole',
        partition: 'aws',
      },
    };

    const result = await handler(event);
    expect(result).toEqual({ Status: 'Success', StatusCode: 200 });
  });
});
