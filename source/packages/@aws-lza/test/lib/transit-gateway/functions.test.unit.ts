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

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation((config: Record<string, unknown>) => ({ config })),
}));

vi.mock('../../../lib/common/utility', () => ({
  setRetryStrategy: vi.fn().mockReturnValue('mock-retry-strategy'),
}));

vi.mock('../../../lib/common/sts-functions', () => ({
  getCredentials: vi.fn(),
}));

vi.mock('../../../lib/common/logger', () => {
  const mockLogger = {
    info: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    mockLogger,
  };
});

import { findAttachmentName, getEc2Client } from '../../../lib/transit-gateway/functions';
import { IDesiredAttachment, ITgwModuleRequest } from '../../../lib/transit-gateway/interfaces';

function makeProps(overrides: Partial<ITgwModuleRequest> = {}): ITgwModuleRequest {
  return {
    invokingAccountId: '111111111111',
    region: 'us-east-1',
    partition: 'aws',
    globalRegion: 'us-east-1',
    operation: 'setup',
    moduleName: 'transit-gateway',
    solutionId: 'AwsSolution/SO0199',
    dryRun: false,
    sessionPolicy: '{"mock":"policy"}',
    credentials: { accessKeyId: 'original', secretAccessKey: 'original', sessionToken: 'original' },
    configuration: {
      enable: true,
      accountAccessRoleName: 'AWSControlTowerExecution',
      transitGateways: [],
      attachments: [],
    },
    ...overrides,
  };
}

describe('transit-gateway functions', () => {
  let mockGetCredentials: ReturnType<typeof vi.fn>;
  let mockLogger: { info: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const sts = await import('../../../lib/common/sts-functions');
    const logger = await import('../../../lib/common/logger');
    mockGetCredentials = vi.mocked(sts.getCredentials);
    mockLogger = (logger as unknown as { mockLogger: typeof mockLogger }).mockLogger;
  });

  describe('getEc2Client', () => {
    test('should return EC2 client with original credentials for same account and region', async () => {
      const props = makeProps();
      const client = await getEc2Client(props, '111111111111', 'us-east-1', 'test');

      expect(mockGetCredentials).not.toHaveBeenCalled();
      expect(client).toBeDefined();
    });

    test('should assume role for different account', async () => {
      const assumedCreds = { accessKeyId: 'assumed', secretAccessKey: 'assumed', sessionToken: 'assumed' };
      mockGetCredentials.mockResolvedValue(assumedCreds);

      const props = makeProps();
      await getEc2Client(props, '222222222222', 'us-east-1', 'test');

      expect(mockGetCredentials).toHaveBeenCalledWith({
        partition: 'aws',
        accountId: '222222222222',
        region: 'us-east-1',
        logPrefix: 'test',
        solutionId: 'AwsSolution/SO0199',
        assumeRoleName: 'AWSControlTowerExecution',
        credentials: props.credentials,
        sessionPolicy: '{"mock":"policy"}',
        requireSessionPolicy: true,
      });
      expect(mockLogger.info).toHaveBeenCalledWith('Assuming role in account 222222222222 region us-east-1', 'test');
    });

    test('should assume role for different region', async () => {
      const assumedCreds = { accessKeyId: 'assumed', secretAccessKey: 'assumed', sessionToken: 'assumed' };
      mockGetCredentials.mockResolvedValue(assumedCreds);

      const props = makeProps();
      await getEc2Client(props, '111111111111', 'eu-west-1', 'test');

      expect(mockGetCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: '111111111111',
          region: 'eu-west-1',
        }),
      );
    });

    test('should use original credentials when getCredentials returns undefined', async () => {
      mockGetCredentials.mockResolvedValue(undefined);

      const props = makeProps();
      const client = await getEc2Client(props, '222222222222', 'us-east-1', 'test');

      expect(mockGetCredentials).toHaveBeenCalled();
      expect(client).toBeDefined();
    });
  });

  describe('findAttachmentName', () => {
    const desired: IDesiredAttachment[] = [
      { attachmentId: 'tgw-attach-a', attachmentName: 'vpc-a', attachmentType: 'vpc' },
      { attachmentId: 'tgw-attach-b', attachmentName: 'vpn-b', attachmentType: 'vpn' },
    ];

    test('should return attachment name when found', () => {
      expect(findAttachmentName('tgw-attach-a', desired)).toBe('vpc-a');
      expect(findAttachmentName('tgw-attach-b', desired)).toBe('vpn-b');
    });

    test('should return attachment ID when not found', () => {
      expect(findAttachmentName('tgw-attach-unknown', desired)).toBe('tgw-attach-unknown');
    });

    test('should return attachment ID for empty desired array', () => {
      expect(findAttachmentName('tgw-attach-a', [])).toBe('tgw-attach-a');
    });
  });
});
