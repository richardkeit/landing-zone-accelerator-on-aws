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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDynamoDBClient,
  getItem,
  getModuleResourcePrefix,
  putItem,
} from '../../../../lib/actions/utils/dynamodb';

// Mock @aws-sdk/client-dynamodb
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(function () {
    return {
      send: vi.fn(),
    };
  }),
}));

// Mock node:path
vi.mock('node:path', () => ({
  default: {
    parse: vi.fn(function () {
      return { name: 'dynamodb' };
    }),
    basename: vi.fn(() => 'dynamodb.ts'),
  },
}));

// Mock aws-lza module
vi.mock('aws-lza', () => ({
  createLogger: vi.fn(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
  setRetryStrategy: vi.fn(() => ({})),
  queryDynamoDBTable: vi.fn(),
  putItemsBatch: vi.fn(),
}));

describe('dynamodb utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDynamoDBClient', () => {
    it('should create a DynamoDB client with correct configuration', () => {
      const region = 'us-east-1';
      const solutionId = 'AwsSolution/SO0199/v1.0.0';

      const client = createDynamoDBClient(region, solutionId);

      expect(client).toBeDefined();
    });

    it('should create a DynamoDB client with credentials', () => {
      const region = 'us-west-2';
      const solutionId = 'AwsSolution/SO0199/v1.0.0';
      const credentials = {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        sessionToken: 'test-token',
      };

      const client = createDynamoDBClient(region, solutionId, credentials);

      expect(client).toBeDefined();
    });
  });

  describe('getItem', () => {
    it('should retrieve an item successfully', async () => {
      const { queryDynamoDBTable } = await import('aws-lza');
      const mockItem = {
        PK: 'MODULE#macie',
        SK: 'EXECUTION#latest',
        configHash: 'abc123',
      };

      (queryDynamoDBTable as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [mockItem],
        lastEvaluatedKey: undefined,
        pageCount: 1,
        totalItems: 1,
      });

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const result = await getItem(client, 'test-table', { PK: 'MODULE#macie', SK: 'EXECUTION#latest' }, 'test-prefix');

      expect(result).toEqual(mockItem);
      expect(queryDynamoDBTable).toHaveBeenCalledWith({
        client,
        tableName: 'test-table',
        partitionKey: { name: 'PK', value: 'MODULE#macie' },
        sortKey: { name: 'SK', value: 'EXECUTION#latest' },
        limit: 1,
        pagination: { enabled: true },
        logPrefix: 'test-prefix',
      });
    });

    it('should return null when item not found', async () => {
      const { queryDynamoDBTable } = await import('aws-lza');

      (queryDynamoDBTable as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [],
        lastEvaluatedKey: undefined,
        pageCount: 1,
        totalItems: 0,
      });

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const result = await getItem(client, 'test-table', { PK: 'MODULE#macie', SK: 'EXECUTION#latest' }, 'test-prefix');

      expect(result).toBeNull();
    });

    it('should query with only PK when SK is not provided', async () => {
      const { queryDynamoDBTable } = await import('aws-lza');
      const mockItem = {
        PK: 'MODULE#macie',
        configHash: 'abc123',
      };

      (queryDynamoDBTable as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [mockItem],
        lastEvaluatedKey: undefined,
        pageCount: 1,
        totalItems: 1,
      });

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const result = await getItem(client, 'test-table', { PK: 'MODULE#macie' }, 'test-prefix');

      expect(result).toEqual(mockItem);
      expect(queryDynamoDBTable).toHaveBeenCalledWith({
        client,
        tableName: 'test-table',
        partitionKey: { name: 'PK', value: 'MODULE#macie' },
        sortKey: undefined,
        limit: 1,
        pagination: { enabled: true },
        logPrefix: 'test-prefix',
      });
    });

    it('should throw error when query fails', async () => {
      const { queryDynamoDBTable } = await import('aws-lza');
      const testError = new Error('DynamoDB query failed');

      (queryDynamoDBTable as ReturnType<typeof vi.fn>).mockRejectedValue(testError);

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      await expect(
        getItem(client, 'test-table', { PK: 'MODULE#macie', SK: 'EXECUTION#latest' }, 'test-prefix'),
      ).rejects.toThrow('DynamoDB query failed');
    });
  });

  describe('putItem', () => {
    it('should put an item successfully', async () => {
      const { putItemsBatch } = await import('aws-lza');

      (putItemsBatch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const item = {
        PK: 'MODULE#macie',
        SK: 'EXECUTION#latest',
        configHash: 'abc123',
        lastExecutionTime: '2024-01-15T10:30:00.000Z',
      };

      await putItem(client, 'test-table', item, 'test-prefix', false);

      expect(putItemsBatch).toHaveBeenCalledWith({
        client,
        tableName: 'test-table',
        items: [item],
        dryRun: false,
        logPrefix: 'test-prefix',
      });
    });

    it('should put an item in dry run mode', async () => {
      const { putItemsBatch } = await import('aws-lza');

      (putItemsBatch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const item = {
        PK: 'MODULE#macie',
        SK: 'EXECUTION#latest',
        configHash: 'abc123',
      };

      await putItem(client, 'test-table', item, 'test-prefix', true);

      expect(putItemsBatch).toHaveBeenCalledWith({
        client,
        tableName: 'test-table',
        items: [item],
        dryRun: true,
        logPrefix: 'test-prefix',
      });
    });

    it('should throw error when put fails', async () => {
      const { putItemsBatch } = await import('aws-lza');
      const testError = new Error('DynamoDB put failed');

      (putItemsBatch as ReturnType<typeof vi.fn>).mockRejectedValue(testError);

      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({});

      const item = {
        PK: 'MODULE#macie',
        SK: 'EXECUTION#latest',
        configHash: 'abc123',
      };

      await expect(putItem(client, 'test-table', item, 'test-prefix', false)).rejects.toThrow('DynamoDB put failed');
    });
  });

  describe('getModuleResourcePrefix', () => {
    const originalEnv = process.env['MODULE_RESOURCE_PREFIX'];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env['MODULE_RESOURCE_PREFIX'];
      } else {
        process.env['MODULE_RESOURCE_PREFIX'] = originalEnv;
      }
    });

    it('should return the MODULE_RESOURCE_PREFIX env var value', () => {
      process.env['MODULE_RESOURCE_PREFIX'] = 'AWSAccelerator';
      expect(getModuleResourcePrefix()).toBe('AWSAccelerator');
    });

    it('should return qualifier value for external deployments', () => {
      process.env['MODULE_RESOURCE_PREFIX'] = 'my-custom-qualifier';
      expect(getModuleResourcePrefix()).toBe('my-custom-qualifier');
    });

    it('should throw when MODULE_RESOURCE_PREFIX is not set', () => {
      delete process.env['MODULE_RESOURCE_PREFIX'];
      expect(() => getModuleResourcePrefix()).toThrow(
        'MODULE_RESOURCE_PREFIX environment variable is required for module infrastructure table resolution',
      );
    });
  });
});
