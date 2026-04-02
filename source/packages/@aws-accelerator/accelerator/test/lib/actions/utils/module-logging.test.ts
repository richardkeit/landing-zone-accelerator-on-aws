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
import type { IconLogger, IModuleResponse } from 'aws-lza';
import { MODULE_STATE_CODE } from 'aws-lza';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logModuleExecutionResult } from '../../../../lib/actions/utils/module-logging.js';

// Mock node:path
vi.mock('node:path', () => ({
  default: {
    parse: vi.fn(() => ({ name: 'module-logging' })),
    basename: vi.fn(() => 'module-logging.ts'),
  },
}));

describe('module-logging utils', () => {
  let mockLogger: IconLogger;
  let mockStatusLogger: IconLogger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      processStart: vi.fn(),
      processEnd: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    };

    mockStatusLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      processStart: vi.fn(),
      processEnd: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    };
  });

  describe('logModuleExecutionResult', () => {
    const moduleName = 'macie';
    const logPrefix = '123456789012:us-east-1';
    const timestamp = '2024-01-15T10:30:00.000Z';

    it('should log successful module execution', () => {
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'Successfully configured Macie',
        timestamp,
        moduleName,
        dryRun: false,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(`Status Summary: ${status.summary}`);
      expect(mockLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName} with status ${status.status}`);
      expect(mockLogger.info).toHaveBeenCalledWith(`Complete Status: ${JSON.stringify(status)}`, logPrefix);
      expect(mockStatusLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName}`, logPrefix);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should log skipped module execution', () => {
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.SKIPPED,
        summary: 'Macie is not enabled in configuration',
        timestamp,
        moduleName,
        dryRun: false,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(`Status Summary: ${status.summary}`);
      expect(mockLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName} with status ${status.status}`);
      expect(mockLogger.info).toHaveBeenCalledWith(`Complete Status: ${JSON.stringify(status)}`, logPrefix);
      expect(mockStatusLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName}`, logPrefix);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should log failed module execution with error', () => {
      const error = new Error('Configuration failed');
      error.name = 'ConfigurationError';

      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
      expect(mockLogger.error).toHaveBeenCalledWith(`Failed module ${moduleName} with status ${status.status}`);
      expect(mockLogger.error).toHaveBeenCalledWith(`Summary: ${status.summary}`);
      expect(mockLogger.info).toHaveBeenCalledWith(`Complete Status: ${JSON.stringify(status)}`, logPrefix);
      expect(mockStatusLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName}`, logPrefix);
    });

    it('should log failed environments when present in response', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ failedEnvironments: string[] }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie in some environments',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          failedEnvironments: ['123456789012:us-east-1', '123456789012:us-west-2'],
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed Environments: 123456789012:us-east-1, 123456789012:us-west-2',
      );
    });

    it('should log environment errors when present in response', () => {
      const error = new Error('Configuration failed');
      const environmentErrors = [
        { environment: '123456789012:us-east-1', error: 'Access denied' },
        { environment: '123456789012:us-west-2', error: 'Service unavailable' },
      ];

      const status: IModuleResponse<{ environmentErrors: typeof environmentErrors }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie with regional errors',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          environmentErrors,
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(`Regional Errors: ${JSON.stringify(environmentErrors, null, 2)}`);
    });

    it('should log both failed environments and environment errors', () => {
      const error = new Error('Configuration failed');
      const environmentErrors = [{ environment: '123456789012:us-east-1', error: 'Access denied' }];

      const status: IModuleResponse<{ failedEnvironments: string[]; environmentErrors: typeof environmentErrors }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          failedEnvironments: ['123456789012:us-east-1'],
          environmentErrors,
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith('Failed Environments: 123456789012:us-east-1');
      expect(mockLogger.error).toHaveBeenCalledWith(`Regional Errors: ${JSON.stringify(environmentErrors, null, 2)}`);
    });

    it('should handle response without failedEnvironments', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ someOtherField: string }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          someOtherField: 'value',
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Failed Environments'));
    });

    it('should handle response without environmentErrors', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ someOtherField: string }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          someOtherField: 'value',
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Regional Errors'));
    });

    it('should handle empty failedEnvironments array', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ failedEnvironments: string[] }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          failedEnvironments: [],
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Failed Environments'));
    });

    it('should handle empty environmentErrors array', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ environmentErrors: unknown[] }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          environmentErrors: [],
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Regional Errors'));
    });

    it('should handle null response', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: null,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Failed Environments'));
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Regional Errors'));
    });

    it('should handle undefined response', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Failed Environments'));
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Regional Errors'));
    });

    it('should handle non-array failedEnvironments', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ failedEnvironments: unknown }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          failedEnvironments: 'not-an-array',
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Failed Environments'));
    });

    it('should handle non-array environmentErrors', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse<{ environmentErrors: unknown }> = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
        response: {
          environmentErrors: 'not-an-array',
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('Regional Errors'));
    });

    it('should handle module execution with custom response data', () => {
      interface ICustomResponse {
        processedItems: number;
        failedItems: string[];
      }

      const status: IModuleResponse<ICustomResponse> = {
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'Processed 10 items',
        timestamp,
        moduleName: 'custom-module',
        dryRun: false,
        response: {
          processedItems: 10,
          failedItems: [],
        },
      };

      logModuleExecutionResult(status, 'custom-module', logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.info).toHaveBeenCalledWith('Status Summary: Processed 10 items');
      expect(mockLogger.processEnd).toHaveBeenCalledWith('Completed module custom-module with status completed');
      expect(mockLogger.info).toHaveBeenCalledWith(`Complete Status: ${JSON.stringify(status)}`, logPrefix);
      expect(mockStatusLogger.processEnd).toHaveBeenCalledWith('Completed module custom-module', logPrefix);
    });

    it('should handle different module names', () => {
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'Successfully configured GuardDuty',
        timestamp,
        moduleName: 'guardduty',
        dryRun: false,
      };

      logModuleExecutionResult(status, 'guardduty', logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.processEnd).toHaveBeenCalledWith('Completed module guardduty with status completed');
      expect(mockStatusLogger.processEnd).toHaveBeenCalledWith('Completed module guardduty', logPrefix);
    });

    it('should handle different log prefixes', () => {
      const error = new Error('Configuration failed');
      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
      };

      const customLogPrefix = '999999999999:eu-west-1';
      logModuleExecutionResult(status, moduleName, customLogPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        customLogPrefix,
      );
    });

    it('should handle complex error objects', () => {
      const error = new Error('Configuration failed');
      error.name = 'ComplexConfigurationError';
      (error as Error & { code?: string }).code = 'ERR_CONFIG_001';

      const status: IModuleResponse = {
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Failed to configure Macie',
        timestamp,
        moduleName,
        dryRun: false,
        error,
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Error in module ${moduleName}. Error: ${error.name} - ${error.message}`,
        logPrefix,
      );
    });

    it('should handle status with response but no error', () => {
      const status: IModuleResponse<{ processedCount: number }> = {
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'Successfully processed resources',
        timestamp,
        moduleName,
        dryRun: false,
        response: {
          processedCount: 42,
        },
      };

      logModuleExecutionResult(status, moduleName, logPrefix, mockLogger, mockStatusLogger);

      expect(mockLogger.processEnd).toHaveBeenCalledWith(`Completed module ${moduleName} with status completed`);
      expect(mockLogger.info).toHaveBeenCalledWith('Status Summary: Successfully processed resources');
      expect(mockLogger.info).toHaveBeenCalledWith(`Complete Status: ${JSON.stringify(status)}`, logPrefix);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
