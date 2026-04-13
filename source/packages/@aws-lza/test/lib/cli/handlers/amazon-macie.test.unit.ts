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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MacieCommand } from '../../../../lib/cli/handlers/amazon-macie';

vi.mock('../../../../lib/amazon-macie/macie.js', () => ({
  configureMacie: vi.fn(),
}));

vi.mock('../../../../lib/cli/handlers/root.js', () => ({
  getConfig: vi.fn(),
  getSessionDetailsFromArgs: vi.fn(),
  logError: vi.fn(),
  logErrorAndExit: vi.fn(),
}));

const mockConfigureMacie = vi.fn();
const mockGetConfig = vi.fn();
const mockGetSessionDetailsFromArgs = vi.fn();
const mockLogError = vi.fn();
const mockLogErrorAndExit = vi.fn().mockImplementation(() => {
  throw new Error('Process exit called');
});

describe('MacieCommand', () => {
  const mockParam = {
    moduleName: 'macie',
    commandName: 'setup',
    args: {
      _: [] as (string | number)[],
      configuration: '{"enable": true}',
      'dry-run': false,
    },
  };

  const mockSessionDetails = {
    accountId: '123456789012',
    region: 'us-east-1',
    partition: 'aws',
  };

  const validConfig = {
    enable: true,
    accountAccessRoleName: 'TestRole',
    delegatedAdminAccountId: '123456789012',
    policyFindingsPublishingFrequency: 'FIFTEEN_MINUTES',
    publishSensitiveDataFindings: true,
    publishPolicyFindings: true,
    s3Destination: {
      bucketName: 'test-bucket',
      keyPrefix: 'macie/',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test',
    },
    automatedDiscoveryEnabled: false,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSessionDetailsFromArgs.mockResolvedValue(mockSessionDetails);
    mockGetConfig.mockReturnValue(validConfig);
    mockConfigureMacie.mockResolvedValue({ success: true });

    // Make logErrorAndExit throw immediately when called
    mockLogErrorAndExit.mockImplementation(() => {
      throw new Error('Process exit called');
    });

    // Set up the mocks
    const macieModule = await import('../../../../lib/amazon-macie/macie.js');
    const rootModule = await import('../../../../lib/cli/handlers/root.js');

    vi.mocked(macieModule.configureMacie).mockImplementation(mockConfigureMacie);
    vi.mocked(rootModule.getConfig).mockImplementation(mockGetConfig);
    vi.mocked(rootModule.getSessionDetailsFromArgs).mockImplementation(mockGetSessionDetailsFromArgs);
    vi.mocked(rootModule.logError).mockImplementation(mockLogError);
    vi.mocked(rootModule.logErrorAndExit).mockImplementation(mockLogErrorAndExit as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    test('should call configureMacie with params', async () => {
      const mockResponse = { success: true };
      mockConfigureMacie.mockResolvedValue(mockResponse);

      const result = await MacieCommand.execute(mockParam);

      expect(mockConfigureMacie).toHaveBeenCalledWith(
        expect.objectContaining({
          ...mockSessionDetails,
          moduleName: 'macie',
          operation: 'setup',
          dryRun: false,
          configuration: expect.objectContaining(validConfig),
        }),
      );
      expect(result).toBe(mockResponse);
    });
  });

  describe('getParams', () => {
    test('should return valid params', async () => {
      const result = await MacieCommand.getParams(mockParam);

      expect(result).toEqual({
        ...mockSessionDetails,
        moduleName: 'macie',
        operation: 'setup',
        dryRun: false,
        configuration: validConfig,
      });
    });

    test('should exit if configuration is not string', async () => {
      const invalidParam = {
        ...mockParam,
        args: {
          _: [] as (string | number)[],
          configuration: 123 as unknown as string,
        },
      };

      // The function should call logErrorAndExit which throws an error
      await expect(MacieCommand.getParams(invalidParam)).rejects.toThrow('Process exit called');

      expect(mockLogErrorAndExit).toHaveBeenCalledWith(
        'An error occurred (MissingRequiredParameters): The configuration parameter is a required string',
      );
    });

    test('should exit if config validation fails', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      mockGetConfig.mockReturnValue({ invalid: 'config' });

      await MacieCommand.getParams(mockParam);

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    test('should include optional fields when present', async () => {
      const configWithOptionals = {
        ...validConfig,
        regionFilters: { ignoredRegions: ['us-west-1'] },
        boundary: { regions: ['us-east-1'] },
        dataSources: { organizations: { tableName: 'test' } },
        batchOperationSettings: { maxConcurrentEnvironments: 10, operationTimeoutMs: 300000 },
      };
      mockGetConfig.mockReturnValue(configWithOptionals);

      const result = await MacieCommand.getParams(mockParam);

      expect(result.configuration).toEqual(configWithOptionals);
    });

    test('should include automatedDiscoveryEnabled when present', async () => {
      const configWithField = { ...validConfig, automatedDiscoveryEnabled: true };
      mockGetConfig.mockReturnValue(configWithField);

      const result = await MacieCommand.getParams(mockParam);

      expect(result.configuration.automatedDiscoveryEnabled).toBe(true);
    });

    test('should default automatedDiscoveryEnabled to false when absent', async () => {
      mockGetConfig.mockReturnValue(validConfig);

      const result = await MacieCommand.getParams(mockParam);

      expect(result.configuration.automatedDiscoveryEnabled).toBe(false);
    });
  });

  describe('validConfig', () => {
    test('should return true for valid config', () => {
      expect(MacieCommand.validConfig(validConfig)).toBe(true);
    });

    test('should return false for invalid enable', () => {
      expect(MacieCommand.validConfig({ ...validConfig, enable: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.enable: Expected boolean, received string');
    });

    test('should return false for invalid accountAccessRoleName', () => {
      expect(MacieCommand.validConfig({ ...validConfig, accountAccessRoleName: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.accountAccessRoleName: Expected string, received number',
      );
    });

    test('should return false for invalid delegatedAdminAccountId', () => {
      expect(MacieCommand.validConfig({ ...validConfig, delegatedAdminAccountId: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.delegatedAdminAccountId: Expected string, received number',
      );
    });

    test('should return false for invalid policyFindingsPublishingFrequency', () => {
      expect(MacieCommand.validConfig({ ...validConfig, policyFindingsPublishingFrequency: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.policyFindingsPublishingFrequency: Expected string, received number',
      );
    });

    test('should return false for invalid publishSensitiveDataFindings', () => {
      expect(MacieCommand.validConfig({ ...validConfig, publishSensitiveDataFindings: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.publishSensitiveDataFindings: Expected boolean, received string',
      );
    });

    test('should return false for invalid publishPolicyFindings', () => {
      expect(MacieCommand.validConfig({ ...validConfig, publishPolicyFindings: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.publishPolicyFindings: Expected boolean, received string',
      );
    });

    test('should return false for invalid s3Destination', () => {
      expect(MacieCommand.validConfig({ ...validConfig, s3Destination: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.s3Destination: Expected object, received string',
      );
    });

    test('should return false for invalid s3Destination.bucketName', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, bucketName: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.s3Destination.bucketName: Expected string, received number',
      );
    });

    test('should return false for invalid s3Destination.keyPrefix', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, keyPrefix: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.s3Destination.keyPrefix: Expected string, received number',
      );
    });

    test('should return false for invalid s3Destination.kmsKeyArn', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, kmsKeyArn: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.s3Destination.kmsKeyArn: Expected string, received number',
      );
    });

    test('should return false for invalid automatedDiscoveryEnabled', () => {
      expect(MacieCommand.validConfig({ ...validConfig, automatedDiscoveryEnabled: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.automatedDiscoveryEnabled: Expected boolean, received string',
      );
    });

    test('should return true when automatedDiscoveryEnabled is valid boolean', () => {
      expect(MacieCommand.validConfig({ ...validConfig, automatedDiscoveryEnabled: true })).toBe(true);
    });
  });

  describe('boundary validation', () => {
    test('should return true when boundary is undefined', () => {
      expect(MacieCommand.validConfig({ ...validConfig })).toBe(true);
    });

    test('should return false for invalid boundary type', () => {
      expect(MacieCommand.validConfig({ ...validConfig, boundary: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.boundary: Expected object, received string',
      );
    });

    test('should return false for invalid boundary.regions', () => {
      expect(MacieCommand.validConfig({ ...validConfig, boundary: { regions: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.boundary.regions: Expected array, received string',
      );
    });

    test('should return true for valid boundary', () => {
      expect(MacieCommand.validConfig({ ...validConfig, boundary: { regions: ['us-east-1'] } })).toBe(true);
    });
  });

  describe('dataSources validation', () => {
    test('should return true when dataSources is undefined', () => {
      expect(MacieCommand.validConfig({ ...validConfig })).toBe(true);
    });

    test('should return false for invalid dataSources type', () => {
      expect(MacieCommand.validConfig({ ...validConfig, dataSources: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources: Expected object, received string',
      );
    });

    test('should return false for invalid organizations type', () => {
      expect(MacieCommand.validConfig({ ...validConfig, dataSources: { organizations: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations: Expected object, received string',
      );
    });

    test('should return false for invalid tableName', () => {
      expect(MacieCommand.validConfig({ ...validConfig, dataSources: { organizations: { tableName: 123 } } })).toBe(
        false,
      );
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations.tableName: Expected string, received number',
      );
    });

    test('should return false for invalid filters', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          dataSources: { organizations: { tableName: 'test', filters: 'invalid' } },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations.filters: Expected array, received string',
      );
    });

    test('should return false for invalid filterOperator', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          dataSources: { organizations: { tableName: 'test', filterOperator: 123 } },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        "(ConfigValidation): config.dataSources.organizations.filterOperator: Expected 'AND' | 'OR', received number",
      );
    });

    test('should return true for valid dataSources', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          dataSources: { organizations: { tableName: 'test', filters: [], filterOperator: 'AND' } },
        }),
      ).toBe(true);
    });
  });

  describe('regionFilters validation', () => {
    test('should return true when regionFilters is undefined', () => {
      expect(MacieCommand.validConfig({ ...validConfig })).toBe(true);
    });

    test('should return false for invalid regionFilters type', () => {
      expect(MacieCommand.validConfig({ ...validConfig, regionFilters: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.regionFilters: Expected object, received string',
      );
    });

    test('should return false for invalid ignoredRegions', () => {
      expect(MacieCommand.validConfig({ ...validConfig, regionFilters: { ignoredRegions: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.regionFilters.ignoredRegions: Expected array, received string',
      );
    });

    test('should return false for invalid disabledRegions', () => {
      expect(MacieCommand.validConfig({ ...validConfig, regionFilters: { disabledRegions: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.regionFilters.disabledRegions: Expected array, received string',
      );
    });

    test('should return true for valid regionFilters', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, regionFilters: { ignoredRegions: [], disabledRegions: [] } }),
      ).toBe(true);
    });
  });

  describe('batchOperationSettings validation', () => {
    test('should return true when batchOperationSettings is undefined', () => {
      expect(MacieCommand.validConfig({ ...validConfig })).toBe(true);
    });

    test('should return false for invalid batchOperationSettings type', () => {
      expect(MacieCommand.validConfig({ ...validConfig, batchOperationSettings: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings: Expected object, received string',
      );
    });

    test('should return false for invalid maxConcurrentEnvironments type', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { maxConcurrentEnvironments: 'invalid' },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments: Expected number, received string',
      );
    });

    test('should return false for maxConcurrentEnvironments <= 0', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { maxConcurrentEnvironments: 0 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments: Number must be greater than 0',
      );
    });

    test('should return false for negative maxConcurrentEnvironments', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { maxConcurrentEnvironments: -1 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments: Number must be greater than 0',
      );
    });

    test('should return false for invalid operationTimeoutMs type', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { operationTimeoutMs: 'invalid' },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs: Expected number, received string',
      );
    });

    test('should return false for operationTimeoutMs <= 0', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { operationTimeoutMs: 0 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs: Number must be greater than 0',
      );
    });

    test('should return false for negative operationTimeoutMs', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { operationTimeoutMs: -1 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs: Number must be greater than 0',
      );
    });

    test('should return true for valid maxConcurrentEnvironments only', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { maxConcurrentEnvironments: 10 },
        }),
      ).toBe(true);
    });

    test('should return true for valid operationTimeoutMs only', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { operationTimeoutMs: 300000 },
        }),
      ).toBe(true);
    });

    test('should return true for valid batchOperationSettings config', () => {
      expect(
        MacieCommand.validConfig({
          ...validConfig,
          batchOperationSettings: { maxConcurrentEnvironments: 10, operationTimeoutMs: 300000 },
        }),
      ).toBe(true);
    });

    test('should return true for empty batchOperationSettings object', () => {
      expect(MacieCommand.validConfig({ ...validConfig, batchOperationSettings: {} })).toBe(true);
    });
  });
});
