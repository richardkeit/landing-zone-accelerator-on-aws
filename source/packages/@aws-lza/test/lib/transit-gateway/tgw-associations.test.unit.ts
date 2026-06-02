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
  EC2Client: vi.fn(function () {
    return { send: mockSend };
  }),
  AssociateTransitGatewayRouteTableCommand: vi.fn(),
  DisassociateTransitGatewayRouteTableCommand: vi.fn(),
  GetTransitGatewayRouteTableAssociationsCommand: vi.fn(),
}));

import { TgwAssociations } from '../../../lib/transit-gateway/tgw-associations';
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

describe('TgwAssociations', () => {
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
    mockSend.mockResolvedValue({ Associations: [] });
  });

  describe('create', () => {
    test('should create association when none exists', async () => {
      const desired = [desiredAttachment()];
      const result = await TgwAssociations.process(
        ec2,
        RT_ID,
        RT_NAME,
        TGW_NAME,
        REGION,
        desired,
        new Set(['tgw-attach-a']),
        false,
        LOG_PREFIX,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({ operation: 'created', attachmentName: 'vpc-a', routeTableName: RT_NAME }),
      );
    });

    test('should handle Resource.AlreadyAssociated as exists', async () => {
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'AssociateTransitGatewayRouteTableCommand') {
          const err = new Error('Resource.AlreadyAssociated');
          err.name = 'Resource.AlreadyAssociated';
          throw err;
        }
        return fn();
      });
      const result = await TgwAssociations.process(
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
    });

    test('should rethrow unknown errors on create', async () => {
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'AssociateTransitGatewayRouteTableCommand') {
          throw new Error('Throttling');
        }
        return fn();
      });
      await expect(
        TgwAssociations.process(
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
    test('should report exists when association already present', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      const result = await TgwAssociations.process(
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
    test('should delete managed association not in desired config', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      const result = await TgwAssociations.process(
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

    test('should never touch external (unmanaged) attachments', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-external', State: 'associated' }],
      });
      const result = await TgwAssociations.process(
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

    test('should handle InvalidAssociation.NotFound as deleted', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisassociateTransitGatewayRouteTableCommand') {
          const err = new Error('InvalidAssociation.NotFound');
          err.name = 'InvalidAssociation.NotFound';
          throw err;
        }
        return fn();
      });
      const result = await TgwAssociations.process(
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

    test('should rethrow unknown errors on disassociate', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      const { executeApi } = await import('../../../lib/common/utility');
      const localMockExecuteApi = vi.mocked(executeApi);
      localMockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisassociateTransitGatewayRouteTableCommand') {
          throw new Error('Throttling');
        }
        return fn();
      });
      await expect(
        TgwAssociations.process(
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
      localMockExecuteApi.mockImplementation((_name: string, _p: unknown, fn: () => Promise<unknown>) => fn());
    });

    test('should skip associations not in associated state', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'disassociating' }],
      });
      const result = await TgwAssociations.process(
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

    test('should handle Resource.NotFound as already disassociated', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisassociateTransitGatewayRouteTableCommand') {
          const err = new Error('Resource.NotFound');
          err.name = 'Resource.NotFound';
          throw err;
        }
        return fn();
      });
      const result = await TgwAssociations.process(
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

    test('should handle InvalidAssociation.NotFound as already disassociated', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisassociateTransitGatewayRouteTableCommand') {
          const err = new Error('InvalidAssociation.NotFound');
          err.name = 'InvalidAssociation.NotFound';
          throw err;
        }
        return fn();
      });
      const result = await TgwAssociations.process(
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

    test('should rethrow unknown errors on disassociate', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      mockExecuteApi.mockImplementation(async (name: string, _p: unknown, fn: () => Promise<unknown>) => {
        if (name === 'DisassociateTransitGatewayRouteTableCommand') {
          throw new Error('Throttling');
        }
        return fn();
      });
      await expect(
        TgwAssociations.process(
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
    test('should not call create API in dry run mode', async () => {
      const result = await TgwAssociations.process(
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
        'AssociateTransitGatewayRouteTableCommand',
        expect.objectContaining({ TransitGatewayRouteTableId: RT_ID, TransitGatewayAttachmentId: 'tgw-attach-a' }),
        LOG_PREFIX,
      );
    });

    test('should not call delete API in dry run mode', async () => {
      mockSend.mockResolvedValue({
        Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
      });
      const result = await TgwAssociations.process(
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
        'DisassociateTransitGatewayRouteTableCommand',
        expect.objectContaining({ TransitGatewayRouteTableId: RT_ID, TransitGatewayAttachmentId: 'tgw-attach-a' }),
        LOG_PREFIX,
      );
    });
  });

  describe('pagination', () => {
    test('should paginate getCurrent via NextToken', async () => {
      mockSend
        .mockResolvedValueOnce({
          Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }],
          NextToken: 'page2',
        })
        .mockResolvedValueOnce({
          Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-b', State: 'associated' }],
        });
      // Both are managed and in current but not desired → both deleted
      const result = await TgwAssociations.process(
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
      const result = await TgwAssociations.process(
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
    test('should poll until associating state resolves then proceed normally', async () => {
      mockSend
        .mockResolvedValueOnce({ Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associating' }] })
        .mockResolvedValueOnce({ Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }] })
        .mockResolvedValueOnce({ Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-a', State: 'associated' }] });

      const desired = [desiredAttachment()];
      const result = await TgwAssociations.process(
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

    test('should poll until disassociating state resolves then create', async () => {
      mockSend
        .mockResolvedValueOnce({
          Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disassociating' }],
        })
        .mockResolvedValueOnce({
          Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disassociated' }],
        })
        .mockResolvedValueOnce({
          Associations: [{ TransitGatewayAttachmentId: 'tgw-attach-stale', State: 'disassociated' }],
        })
        .mockResolvedValueOnce({});

      const desired = [desiredAttachment()];
      const result = await TgwAssociations.process(
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
