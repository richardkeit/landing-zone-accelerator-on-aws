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
import { ConfigurationObjectType } from '../../../../lib/cli/handlers/root';

// Helper function to access private methods for testing
const callPrivateMethod = (methodName: string, config: ConfigurationObjectType): boolean => {
  return (MacieCommand as unknown as Record<string, (config: ConfigurationObjectType) => boolean>)[methodName](config);
};

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
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.enable must be a boolean');
    });

    test('should return false for invalid accountAccessRoleName', () => {
      expect(MacieCommand.validConfig({ ...validConfig, accountAccessRoleName: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.accountAccessRoleName must be a string');
    });

    test('should return false for invalid delegatedAdminAccountId', () => {
      expect(MacieCommand.validConfig({ ...validConfig, delegatedAdminAccountId: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.delegatedAdminAccountId must be a string');
    });

    test('should return false for invalid policyFindingsPublishingFrequency', () => {
      expect(MacieCommand.validConfig({ ...validConfig, policyFindingsPublishingFrequency: 123 })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.policyFindingsPublishingFrequency must be a string',
      );
    });

    test('should return false for invalid publishSensitiveDataFindings', () => {
      expect(MacieCommand.validConfig({ ...validConfig, publishSensitiveDataFindings: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.publishSensitiveDataFindings must be a boolean',
      );
    });

    test('should return false for invalid publishPolicyFindings', () => {
      expect(MacieCommand.validConfig({ ...validConfig, publishPolicyFindings: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.publishPolicyFindings must be a boolean');
    });

    test('should return false for invalid s3Destination', () => {
      expect(MacieCommand.validConfig({ ...validConfig, s3Destination: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.s3Destination must be an object');
    });

    test('should return false for invalid s3Destination.bucketName', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, bucketName: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.s3Destination.bucketName must be a string');
    });

    test('should return false for invalid s3Destination.keyPrefix', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, keyPrefix: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.s3Destination.keyPrefix must be a string');
    });

    test('should return false for invalid s3Destination.kmsKeyArn', () => {
      expect(
        MacieCommand.validConfig({ ...validConfig, s3Destination: { ...validConfig.s3Destination, kmsKeyArn: 123 } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.s3Destination.kmsKeyArn must be a string');
    });

    test('should return false for invalid automatedDiscoveryEnabled', () => {
      expect(MacieCommand.validConfig({ ...validConfig, automatedDiscoveryEnabled: 'true' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.automatedDiscoveryEnabled must be a boolean',
      );
    });

    test('should return true when automatedDiscoveryEnabled is valid boolean', () => {
      expect(MacieCommand.validConfig({ ...validConfig, automatedDiscoveryEnabled: true })).toBe(true);
    });
  });

  describe('validateBoundaryConfig', () => {
    test('should return true when boundary is undefined', () => {
      expect(callPrivateMethod('validateBoundaryConfig', {})).toBe(true);
    });

    test('should return false for invalid boundary type', () => {
      expect(callPrivateMethod('validateBoundaryConfig', { boundary: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.boundary must be an object');
    });

    test('should return false for invalid boundary.regions', () => {
      expect(callPrivateMethod('validateBoundaryConfig', { boundary: { regions: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.boundary.regions must be an array');
    });

    test('should return true for valid boundary', () => {
      expect(callPrivateMethod('validateBoundaryConfig', { boundary: { regions: ['us-east-1'] } })).toBe(true);
    });
  });

  describe('validateDataSourcesConfig', () => {
    test('should return true when dataSources is undefined', () => {
      expect(callPrivateMethod('validateDataSourcesConfig', {})).toBe(true);
    });

    test('should return false for invalid dataSources type', () => {
      expect(callPrivateMethod('validateDataSourcesConfig', { dataSources: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.dataSources must be an object');
    });

    test('should return false for invalid organizations type', () => {
      expect(callPrivateMethod('validateDataSourcesConfig', { dataSources: { organizations: 'invalid' } })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations must be an object',
      );
    });

    test('should return false for invalid tableName', () => {
      expect(
        callPrivateMethod('validateDataSourcesConfig', { dataSources: { organizations: { tableName: 123 } } }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations.tableName must be a string',
      );
    });

    test('should return false for invalid filters', () => {
      expect(
        callPrivateMethod('validateDataSourcesConfig', {
          dataSources: { organizations: { tableName: 'test', filters: 'invalid' } },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations.filters must be an array',
      );
    });

    test('should return false for invalid filterOperator', () => {
      expect(
        callPrivateMethod('validateDataSourcesConfig', {
          dataSources: { organizations: { tableName: 'test', filterOperator: 123 } },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.dataSources.organizations.filterOperator must be a string',
      );
    });

    test('should return true for valid dataSources', () => {
      expect(
        callPrivateMethod('validateDataSourcesConfig', {
          dataSources: { organizations: { tableName: 'test', filters: [], filterOperator: 'AND' } },
        }),
      ).toBe(true);
    });
  });

  describe('validateRegionFilterConfig', () => {
    test('should return true when regionFilters is undefined', () => {
      expect(callPrivateMethod('validateRegionFilterConfig', {})).toBe(true);
    });

    test('should return false for invalid regionFilters type', () => {
      expect(callPrivateMethod('validateRegionFilterConfig', { regionFilters: 'invalid' })).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.regionFilters must be an object');
    });

    test('should call validateRegionFilterConfig and return false', () => {
      const spy = vi
        .spyOn(
          MacieCommand as unknown as Record<string, (config: ConfigurationObjectType) => boolean>,
          'validateRegionFilterConfig',
        )
        .mockReturnValue(false);
      expect(MacieCommand.validConfig({ ...validConfig, regionFilters: {} })).toBe(false);
      spy.mockRestore();
    });

    test('should call validateBoundaryConfig and return false', () => {
      const spy = vi
        .spyOn(
          MacieCommand as unknown as Record<string, (config: ConfigurationObjectType) => boolean>,
          'validateBoundaryConfig',
        )
        .mockReturnValue(false);
      expect(MacieCommand.validConfig({ ...validConfig, boundary: {} })).toBe(false);
      spy.mockRestore();
    });

    test('should call validateDataSourcesConfig and return false', () => {
      const spy = vi
        .spyOn(
          MacieCommand as unknown as Record<string, (config: ConfigurationObjectType) => boolean>,
          'validateDataSourcesConfig',
        )
        .mockReturnValue(false);
      expect(MacieCommand.validConfig({ ...validConfig, dataSources: {} })).toBe(false);
      spy.mockRestore();
    });

    test('should call validateBatchOperationSettingsConfig and return false', () => {
      const spy = vi
        .spyOn(
          MacieCommand as unknown as Record<string, (config: ConfigurationObjectType) => boolean>,
          'validateBatchOperationSettingsConfig',
        )
        .mockReturnValue(false);
      expect(MacieCommand.validConfig({ ...validConfig, batchOperationSettings: {} })).toBe(false);
      spy.mockRestore();
    });

    test('should return false for invalid ignoredRegions', () => {
      expect(callPrivateMethod('validateRegionFilterConfig', { regionFilters: { ignoredRegions: 'invalid' } })).toBe(
        false,
      );
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.regionFilters.ignoredRegions must be an array',
      );
    });

    test('should return false for invalid disabledRegions', () => {
      expect(callPrivateMethod('validateRegionFilterConfig', { regionFilters: { disabledRegions: 'invalid' } })).toBe(
        false,
      );
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.regionFilters.disabledRegions must be an array',
      );
    });

    test('should return true for valid regionFilters', () => {
      expect(
        callPrivateMethod('validateRegionFilterConfig', { regionFilters: { ignoredRegions: [], disabledRegions: [] } }),
      ).toBe(true);
    });
  });

  describe('validateBatchOperationSettingsConfig', () => {
    test('should return true when batchOperationSettings is undefined', () => {
      expect(callPrivateMethod('validateBatchOperationSettingsConfig', {})).toBe(true);
    });

    test('should return false for invalid batchOperationSettings type', () => {
      expect(callPrivateMethod('validateBatchOperationSettingsConfig', { batchOperationSettings: 'invalid' })).toBe(
        false,
      );
      expect(mockLogError).toHaveBeenCalledWith('(ConfigValidation): config.batchOperationSettings must be an object');
    });

    test('should return false for invalid maxConcurrentEnvironments type', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { maxConcurrentEnvironments: 'invalid' },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments must be a number',
      );
    });

    test('should return false for maxConcurrentEnvironments <= 0', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { maxConcurrentEnvironments: 0 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments must be greater than 0',
      );
    });

    test('should return false for negative maxConcurrentEnvironments', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { maxConcurrentEnvironments: -1 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.maxConcurrentEnvironments must be greater than 0',
      );
    });

    test('should return false for invalid operationTimeoutMs type', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { operationTimeoutMs: 'invalid' },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs must be a number',
      );
    });

    test('should return false for operationTimeoutMs <= 0', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { operationTimeoutMs: 0 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs must be greater than 0',
      );
    });

    test('should return false for negative operationTimeoutMs', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { operationTimeoutMs: -1 },
        }),
      ).toBe(false);
      expect(mockLogError).toHaveBeenCalledWith(
        '(ConfigValidation): config.batchOperationSettings.operationTimeoutMs must be greater than 0',
      );
    });

    test('should return true for valid maxConcurrentEnvironments only', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { maxConcurrentEnvironments: 10 },
        }),
      ).toBe(true);
    });

    test('should return true for valid operationTimeoutMs only', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { operationTimeoutMs: 300000 },
        }),
      ).toBe(true);
    });

    test('should return true for valid batchOperationSettings config', () => {
      expect(
        callPrivateMethod('validateBatchOperationSettingsConfig', {
          batchOperationSettings: { maxConcurrentEnvironments: 10, operationTimeoutMs: 300000 },
        }),
      ).toBe(true);
    });

    test('should return true for empty batchOperationSettings object', () => {
      expect(callPrivateMethod('validateBatchOperationSettingsConfig', { batchOperationSettings: {} })).toBe(true);
    });
  });
});
