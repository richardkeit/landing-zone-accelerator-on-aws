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

import { ClassificationScopeUpdateOperation, FindingPublishingFrequency, Macie2Client } from '@aws-sdk/client-macie2';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { IMacieS3Destination } from '../../../lib/amazon-macie/interfaces';
import { MacieSession } from '../../../lib/amazon-macie/macie-session';
import { IAcceleratorEnvironment } from '../../../lib/common/interfaces';

vi.mock('@aws-sdk/client-macie2', () => ({
  Macie2Client: vi.fn(),
  UpdateMacieSessionCommand: vi.fn(),
  PutFindingsPublicationConfigurationCommand: vi.fn(),
  PutClassificationExportConfigurationCommand: vi.fn(),
  UpdateAutomatedDiscoveryConfigurationCommand: vi.fn(),
  ListClassificationScopesCommand: vi.fn(),
  UpdateClassificationScopeCommand: vi.fn(),
  FindingPublishingFrequency: { FIFTEEN_MINUTES: 'FIFTEEN_MINUTES', ONE_HOUR: 'ONE_HOUR', SIX_HOURS: 'SIX_HOURS' },
  MacieStatus: { ENABLED: 'ENABLED', PAUSED: 'PAUSED' },
  AutomatedDiscoveryStatus: { ENABLED: 'ENABLED', DISABLED: 'DISABLED' },
  ClassificationScopeUpdateOperation: { ADD: 'ADD', REMOVE: 'REMOVE', REPLACE: 'REPLACE' },
}));

vi.mock('../../../lib/common/utility', () => ({
  executeApi: vi.fn(),
  delay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/common/logger', () => {
  const mockLogger = {
    dryRun: vi.fn(),
    info: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    mockLogger,
  };
});

describe('MacieSession', () => {
  let mockExecuteApi: ReturnType<typeof vi.fn>;
  let mockLogger: {
    dryRun: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  const mockClient = new Macie2Client({});
  const logPrefix = 'test';

  const mockEnv: IAcceleratorEnvironment = {
    accountId: '123456789012',
    region: 'us-east-1',
  };

  const mockS3Destination: IMacieS3Destination = {
    bucketName: 'test-bucket',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
    keyPrefix: 'custom-prefix',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const utility = await import('../../../lib/common/utility.js');
    const logger = await import('../../../lib/common/logger.js');
    mockExecuteApi = vi.mocked(utility.executeApi);
    mockLogger = (logger as unknown as { mockLogger: typeof mockLogger }).mockLogger;

    mockClient.send = vi.fn().mockResolvedValue({});
  });

  describe('configure', () => {
    test('should configure Macie session with all settings in non-dry-run mode', async () => {
      mockExecuteApi.mockResolvedValue({});

      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: mockS3Destination,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
        publishSensitiveDataFindings: true,
        publishPolicyFindings: true,
        skipClassificationExport: false,
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(3);

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateMacieSessionCommand',
        { findingPublishingFrequency: FindingPublishingFrequency.ONE_HOUR },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'PutFindingsPublicationConfigurationCommand',
        { publishSensitiveDataFindings: true, publishPolicyFindings: true },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'PutClassificationExportConfigurationCommand',
        {
          configuration: {
            destination: {
              bucketName: 'test-bucket',
              kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
              keyPrefix: 'custom-prefix',
            },
          },
        },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should handle dry run mode', async () => {
      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: mockS3Destination,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.FIFTEEN_MINUTES,
        publishSensitiveDataFindings: false,
        publishPolicyFindings: false,
        skipClassificationExport: false,
        dryRun: true,
        logPrefix,
      });

      expect(mockExecuteApi).not.toHaveBeenCalled();
      expect(mockLogger.dryRun).toHaveBeenCalledTimes(3);

      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'UpdateMacieSessionCommand',
        { findingPublishingFrequency: FindingPublishingFrequency.FIFTEEN_MINUTES },
        logPrefix,
      );

      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'PutFindingsPublicationConfigurationCommand',
        { publishSensitiveDataFindings: false, publishPolicyFindings: false },
        logPrefix,
      );

      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'PutClassificationExportConfigurationCommand',
        {
          configuration: {
            destination: {
              bucketName: 'test-bucket',
              kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
              keyPrefix: 'custom-prefix',
            },
          },
        },
        logPrefix,
      );
    });

    test('should use default keyPrefix when not provided', async () => {
      const s3DestinationWithoutPrefix: IMacieS3Destination = {
        bucketName: 'test-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
      };

      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: s3DestinationWithoutPrefix,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.SIX_HOURS,
        publishSensitiveDataFindings: true,
        publishPolicyFindings: false,
        skipClassificationExport: false,
        dryRun: true,
        logPrefix,
      });

      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'PutClassificationExportConfigurationCommand',
        {
          configuration: {
            destination: {
              bucketName: 'test-bucket',
              kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
              keyPrefix: 'macie/123456789012',
            },
          },
        },
        logPrefix,
      );
    });

    test('should execute actual AWS commands in non-dry-run mode', async () => {
      mockExecuteApi.mockImplementation(async (_commandName, _params, fn) => {
        await fn();
        return {};
      });

      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: mockS3Destination,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
        publishSensitiveDataFindings: true,
        publishPolicyFindings: true,
        skipClassificationExport: false,
        dryRun: false,
        logPrefix,
      });

      expect(mockClient.send).toHaveBeenCalledTimes(3);
    });

    test('should skip classification export when skipClassificationExport is true', async () => {
      mockExecuteApi.mockResolvedValue({});

      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: mockS3Destination,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
        publishSensitiveDataFindings: true,
        publishPolicyFindings: true,
        skipClassificationExport: true,
        dryRun: false,
        logPrefix,
      });

      // Should only call UpdateMacieSession and PutFindingsPublication (not PutClassificationExport)
      expect(mockExecuteApi).toHaveBeenCalledTimes(2);
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateMacieSessionCommand',
        expect.any(Object),
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'PutFindingsPublicationConfigurationCommand',
        expect.any(Object),
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
      expect(mockExecuteApi).not.toHaveBeenCalledWith(
        'PutClassificationExportConfigurationCommand',
        expect.any(Object),
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should skip classification export dry run logs when skipClassificationExport is true', async () => {
      await MacieSession.configure({
        env: mockEnv,
        client: mockClient,
        s3Destination: mockS3Destination,
        policyFindingsPublishingFrequency: FindingPublishingFrequency.FIFTEEN_MINUTES,
        publishSensitiveDataFindings: true,
        publishPolicyFindings: true,
        skipClassificationExport: true,
        dryRun: true,
        logPrefix,
      });

      // Should only log 2 dry run calls (not PutClassificationExport)
      expect(mockLogger.dryRun).toHaveBeenCalledTimes(2);
      expect(mockLogger.dryRun).toHaveBeenCalledWith('UpdateMacieSessionCommand', expect.any(Object), logPrefix);
      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'PutFindingsPublicationConfigurationCommand',
        expect.any(Object),
        logPrefix,
      );
    });
  });

  describe('configureAutomatedDiscovery', () => {
    test('should enable automated discovery with ALL auto-enable mode', async () => {
      mockExecuteApi.mockResolvedValue({});

      await MacieSession.configureAutomatedDiscovery({
        client: mockClient,
        enabled: true,
        autoEnableOrganizationMembers: 'ALL',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(1);
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateAutomatedDiscoveryConfigurationCommand',
        { status: 'ENABLED', autoEnableOrganizationMembers: 'ALL' },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should disable automated discovery with NONE auto-enable mode', async () => {
      mockExecuteApi.mockResolvedValue({});

      await MacieSession.configureAutomatedDiscovery({
        client: mockClient,
        enabled: false,
        autoEnableOrganizationMembers: 'NONE',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(1);
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateAutomatedDiscoveryConfigurationCommand',
        { status: 'DISABLED', autoEnableOrganizationMembers: 'NONE' },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should log dry run for automated discovery', async () => {
      await MacieSession.configureAutomatedDiscovery({
        client: mockClient,
        enabled: true,
        autoEnableOrganizationMembers: 'ALL',
        dryRun: true,
        logPrefix,
      });

      expect(mockExecuteApi).not.toHaveBeenCalled();
      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'UpdateAutomatedDiscoveryConfigurationCommand',
        { status: 'ENABLED', autoEnableOrganizationMembers: 'ALL' },
        logPrefix,
      );
    });
  });

  describe('updateClassificationScope', () => {
    test('should list scopes then update with REPLACE operation for matching region buckets', async () => {
      mockExecuteApi.mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-123' }] }).mockResolvedValueOnce({});

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [
          { name: 'my-logging-bucket', region: 'us-east-1' },
          { name: 'my-cloudtrail-bucket', region: 'us-east-1' },
          { name: 'my-other-region-bucket', region: 'us-west-2' },
        ],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(2);
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'ListClassificationScopesCommand',
        {},
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateClassificationScopeCommand',
        {
          id: 'scope-123',
          s3: {
            excludes: {
              bucketNames: ['my-logging-bucket', 'my-cloudtrail-bucket'],
              operation: ClassificationScopeUpdateOperation.REPLACE,
            },
          },
        },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should skip update when no buckets match the target region', async () => {
      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [
          { name: 'my-bucket-west', region: 'us-west-2' },
          { name: 'my-bucket-eu', region: 'eu-west-1' },
        ],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'No buckets to exclude in region us-east-1 — skipping classification scope update',
        logPrefix,
      );
    });

    test('should skip update when no classification scope found', async () => {
      mockExecuteApi.mockResolvedValueOnce({ classificationScopes: [] });

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('No classification scope found — skipping update', logPrefix);
    });

    test('should skip update when classificationScopes is undefined', async () => {
      mockExecuteApi.mockResolvedValueOnce({});

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('No classification scope found — skipping update', logPrefix);
    });

    test('should log dry run for update classification scope', async () => {
      mockExecuteApi.mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-456' }] });

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: true,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledTimes(1);
      expect(mockLogger.dryRun).toHaveBeenCalledWith(
        'UpdateClassificationScopeCommand',
        {
          id: 'scope-456',
          s3: {
            excludes: {
              bucketNames: ['my-bucket'],
              operation: ClassificationScopeUpdateOperation.REPLACE,
            },
          },
        },
        logPrefix,
      );
    });

    test('should retry on ValidationException and succeed', async () => {
      const validationError = new Error('bucket does not exist');
      validationError.name = 'ValidationException';

      mockExecuteApi
        .mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-123' }] }) // ListClassificationScopes
        .mockRejectedValueOnce(validationError) // 1st attempt fails
        .mockResolvedValueOnce({}); // 2nd attempt succeeds

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-1',
        dryRun: false,
        logPrefix,
      });

      // ListClassificationScopes + 2 UpdateClassificationScope attempts
      expect(mockExecuteApi).toHaveBeenCalledTimes(3);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('attempt 1/6 failed (ValidationException)'),
        logPrefix,
      );
    });

    test('should throw after max retries exhausted on ValidationException', async () => {
      const validationError = new Error('bucket does not exist');
      validationError.name = 'ValidationException';

      mockExecuteApi
        .mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-123' }] }) // ListClassificationScopes
        .mockRejectedValueOnce(validationError) // attempt 1
        .mockRejectedValueOnce(validationError) // attempt 2
        .mockRejectedValueOnce(validationError) // attempt 3
        .mockRejectedValueOnce(validationError) // attempt 4
        .mockRejectedValueOnce(validationError) // attempt 5
        .mockRejectedValueOnce(validationError); // attempt 6

      await expect(
        MacieSession.updateClassificationScope({
          client: mockClient,
          buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
          operation: ClassificationScopeUpdateOperation.REPLACE,
          targetRegion: 'us-east-1',
          dryRun: false,
          logPrefix,
        }),
      ).rejects.toThrow('Macie S3 bucket inventory may not have finished indexing');
    });

    test('should throw immediately on non-ValidationException errors', async () => {
      const accessDenied = new Error('access denied');
      accessDenied.name = 'AccessDeniedException';

      mockExecuteApi
        .mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-123' }] }) // ListClassificationScopes
        .mockRejectedValueOnce(accessDenied); // 1st attempt fails with non-retryable error

      await expect(
        MacieSession.updateClassificationScope({
          client: mockClient,
          buckets: [{ name: 'my-bucket', region: 'us-east-1' }],
          operation: ClassificationScopeUpdateOperation.REPLACE,
          targetRegion: 'us-east-1',
          dryRun: false,
          logPrefix,
        }),
      ).rejects.toThrow('access denied');

      // ListClassificationScopes + 1 UpdateClassificationScope attempt (no retry)
      expect(mockExecuteApi).toHaveBeenCalledTimes(2);
    });

    test('should only include buckets for the target region when multiple regions present', async () => {
      mockExecuteApi.mockResolvedValueOnce({ classificationScopes: [{ id: 'scope-123' }] }).mockResolvedValueOnce({});

      await MacieSession.updateClassificationScope({
        client: mockClient,
        buckets: [
          { name: 'bucket-east-1', region: 'us-east-1' },
          { name: 'bucket-east-2', region: 'us-east-2' },
          { name: 'bucket-west-2', region: 'us-west-2' },
          { name: 'another-east-2', region: 'us-east-2' },
        ],
        operation: ClassificationScopeUpdateOperation.REPLACE,
        targetRegion: 'us-east-2',
        dryRun: false,
        logPrefix,
      });

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'UpdateClassificationScopeCommand',
        {
          id: 'scope-123',
          s3: {
            excludes: {
              bucketNames: ['bucket-east-2', 'another-east-2'],
              operation: ClassificationScopeUpdateOperation.REPLACE,
            },
          },
        },
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });
  });
});
