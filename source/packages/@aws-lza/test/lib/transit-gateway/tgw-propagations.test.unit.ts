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

const mockSend = vi.fn();

vi.mock('../../../lib/common/logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dryRun: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    mockLogger,
  };
});

vi.mock('../../../lib/common/utility', () => ({
  executeApi: vi.fn((_name: string, _params: unknown, fn: () => Promise<unknown>) => fn()),
  setRetryStrategy: vi.fn(),
}));

vi.mock('../../../common/functions', () => ({
  waitUntil: vi.fn(async (predicate: () => Promise<boolean>) => {
    await predicate();
  }),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn(() => ({ send: mockSend })),
  EnableTransitGatewayRouteTablePropagationCommand: vi.fn(),
  DisableTransitGatewayRouteTablePropagationCommand: vi.fn(),
  GetTransitGatewayRouteTablePropagationsCommand: vi.fn(),
}));

import { TgwPropagations } from '../../../lib/transit-gateway/tgw-propagations';
import { EC2Client } from '@aws-sdk/client-ec2';
import { IDesiredAttachment } from '../../../lib/transit-gateway/interfaces';

const ec2 = new EC2Client({});
const RT_ID = 'tgw-rtb-core';
const RT_NAME = 'core-rt';
const TGW_NAME = 'main-tgw';
const REGION = 'us-east-1';
const LOG_PREFIX = 'test';

function desiredAttachment(overrides: Partial<IDesiredAttachment> = {}): IDesiredAttachment {
  return { attachmentId: 'tgw-attach-a', attachmentName: 'vpc-a', attachmentType: 'vpc', ...overrides };
}

describe('TgwPropagations', () => {
  let mockExecuteApi: ReturnType<typeof vi.fn>;
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    dryRun: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const utility = await import('../../../lib/common/utility');
    const logger = await import('../../../lib/common/logger');
    mockExecuteApi = vi.mocked(utility.executeApi);
    mockExecuteApi.mockImplementation((_name: string, _params: unknown, fn: () => Promise<unknown>) => fn());
    mockLogger = (logger as unknown as { mockLogger: typeof mockLogger }).mockLogger;
    mockSend.mockResolvedValue({ TransitGatewayRouteTablePropagations: [] });
  });

  describe('create', () => {
    test('should enable propagation when none exists', async () => {
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [desiredAttachment()],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({ operation: 'created', attachmentName: 'vpc-a', routeTableName: RT_NAME }),
      );
    });

    test('should handle AlreadyEnabled as exists', async () => {
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'EnableTransitGatewayRouteTablePropagationCommand') {
          const err = new Error('TransitGatewayRouteTablePropagation.AlreadyEnabled');
          err.name = 'TransitGatewayRouteTablePropagation.AlreadyEnabled';
          throw err;
        }
        return fn();
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [desiredAttachment()],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('exists');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('should handle Duplicate as exists', async () => {
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'EnableTransitGatewayRouteTablePropagationCommand') {
          const err = new Error('Propagation tgw-attach-a already exists in Transit Gateway Route Table tgw-rtb-a.');
          err.name = 'TransitGatewayRouteTablePropagation.Duplicate';
          throw err;
        }
        return fn();
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [desiredAttachment()],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('exists');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('should rethrow unknown errors on enable', async () => {
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'EnableTransitGatewayRouteTablePropagationCommand') {
          throw new Error('Throttling');
        }
        return fn();
      });
      await expect(
        TgwPropagations.process(
          ec2,
          RT_ID,
          RT_NAME,
          TGW_NAME,
          REGION,
          [desiredAttachment()],
          new Set(['tgw-attach-a']),
          false,
          LOG_PREFIX,
        ),
      ).rejects.toThrow('Throttling');
    });
  });

  describe('exists', () => {
    test('should report exists when propagation already enabled', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [desiredAttachment()],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result).toHaveLength(1);
      expect(result[0].operation).toBe('exists');
    });
  });

  describe('delete', () => {
    test('should disable managed propagation not in desired config', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result).toHaveLength(1);
      expect(result[0].operation).toBe('deleted');
    });

    test('should never touch external (unmanaged) propagations', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-external', State: 'enabled' }],
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result.filter(r => r.operation === 'deleted')).toHaveLength(0);
    });

    test('should skip propagations not in enabled state', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'disabling' }],
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result.filter(r => r.operation === 'deleted')).toHaveLength(0);
    });

    test('should handle NotFound as already disabled', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisableTransitGatewayRouteTablePropagationCommand') {
          const err = new Error('TransitGatewayRouteTablePropagation.NotFound');
          err.name = 'TransitGatewayRouteTablePropagation.NotFound';
          throw err;
        }
        return fn();
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('deleted');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('should handle Resource.NotFound as already disabled', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisableTransitGatewayRouteTablePropagationCommand') {
          const err = new Error('Resource.NotFound');
          err.name = 'Resource.NotFound';
          throw err;
        }
        return fn();
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('deleted');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('should rethrow unknown errors on disable', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisableTransitGatewayRouteTablePropagationCommand') {
          throw new Error('Throttling');
        }
        return fn();
      });
      await expect(
        TgwPropagations.process(
          ec2,
          RT_ID,
          RT_NAME,
          TGW_NAME,
          REGION,
          [],
          new Set(['tgw-attach-a']),
          false,
          LOG_PREFIX,
        ),
      ).rejects.toThrow('Throttling');
    });
  });

  describe('dry run', () => {
    test('should not call enable API in dry run mode', async () => {
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [desiredAttachment()],
        new Set(['tgw-attach-a']),
        true,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('created');
      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'EnableTransitGatewayRouteTablePropagationCommand',
        expect.objectContaining({ TransitGatewayRouteTableId: RT_ID, TransitGatewayAttachmentId: 'tgw-attach-a' }),
        LOG_PREFIX,
      );
    });

    test('should not call disable API in dry run mode', async () => {
      mockSend.mockResolvedValue({
        TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
      });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a']),
        true,
        LOG_PREFIX,
      );
      expect(result[0].operation).toBe('deleted');
      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'DisableTransitGatewayRouteTablePropagationCommand',
        expect.objectContaining({ TransitGatewayRouteTableId: RT_ID, TransitGatewayAttachmentId: 'tgw-attach-a' }),
        LOG_PREFIX,
      );
    });
  });

  describe('pagination', () => {
    test('should paginate getCurrent via NextToken', async () => {
      mockSend
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
          NextToken: 'page2',
        })
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-b', State: 'enabled' }],
        });
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(['tgw-attach-a', 'tgw-attach-b']),
        false,
        LOG_PREFIX,
      );
      expect(result.filter(r => r.operation === 'deleted')).toHaveLength(2);
    });
  });

  describe('empty state', () => {
    test('should return empty results when no current and no desired', async () => {
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        [],
        new Set(),
        false,
        LOG_PREFIX,
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('transitional state polling', () => {
    test('should poll until enabling state resolves then proceed normally', async () => {
      mockSend
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabling' }],
        })
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
        })
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'enabled' }],
        });

      const desired = [desiredAttachment()];
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        desired,
        new Set(),
        false,
        LOG_PREFIX,
      );
      expect(result.filter(r => r.operation === 'exists')).toHaveLength(1);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    test('should poll until disabling state resolves then create', async () => {
      mockExecuteApi.mockImplementation(async (_name: string, _p: unknown, fn: () => Promise<unknown>) => fn());
      mockSend
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [
            { TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disabling' },
          ],
        })
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disabled' }],
        })
        .mockResolvedValueOnce({
          TransitGatewayRouteTablePropagations: [{ TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disabled' }],
        })
        .mockResolvedValueOnce({});

      const desired = [desiredAttachment()];
      const result = await TgwPropagations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        desired,
        new Set(),
        false,
        LOG_PREFIX,
      );
      expect(result.filter(r => r.operation === 'created')).toHaveLength(1);
      expect(mockSend).toHaveBeenCalledTimes(4);
    });
  });
});
