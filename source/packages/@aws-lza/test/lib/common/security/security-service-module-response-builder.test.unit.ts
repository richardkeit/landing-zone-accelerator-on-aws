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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IRegionOperationError, ISecurityServiceModuleResponse } from '../../../../lib/common/interfaces';
import { IconLogger } from '../../../../lib/common/logger';
import { SecurityServiceModuleResponseBuilder } from '../../../../lib/common/security/security-service-module-response-builder';
import { MODULE_STATE_CODE } from '../../../../lib/common/types';

describe('SecurityServiceModuleResponseBuilder', () => {
  let responseBuilder: SecurityServiceModuleResponseBuilder;
  let mockLogger: IconLogger;

  const TEST_MODULE_NAME = 'macie';
  const TEST_OPERATION = 'enable';

  beforeEach(() => {
    // Create mock logger
    mockLogger = {
      processStart: vi.fn(),
      processEnd: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    } as unknown as IconLogger;

    // Create response builder instance
    responseBuilder = new SecurityServiceModuleResponseBuilder(mockLogger);
  });

  describe('build', () => {
    it('should build successful response with no errors', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1', 'us-west-2'],
            managementAccountId: '111111111111',
            delegatedAdminAccountId: '222222222222',
          },
        ],
        delegatedAdminAccountConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1', 'us-west-2'],
            adminAccountId: '222222222222',
            memberAccountIds: ['333333333333', '444444444444'],
          },
        ],
      };

      const operationResults: (void | IRegionOperationError)[] = [undefined, undefined, undefined, undefined];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.status).toBe(MODULE_STATE_CODE.COMPLETED);
      expect(result.summary).toBe('macie enable completed');
      expect(result.moduleName).toBe(TEST_MODULE_NAME);
      expect(result.dryRun).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.timestamp).toBeDefined();
      expect(result.response).toBe(serviceResponse);
    });

    it('should build response with regional errors', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1'],
            managementAccountId: '111111111111',
            delegatedAdminAccountId: '222222222222',
          },
        ],
        delegatedAdminAccountConfig: [],
      };

      const regionError: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Test error message',
      };

      const operationResults: (void | IRegionOperationError)[] = [undefined, regionError];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.summary).toContain('macie enable failed');
      expect(result.summary).toContain('us-west-2');
      expect(result.summary).toContain('ValidationException');
      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe('ValidationException');
      expect(result.response?.environmentErrors).toHaveLength(1);
      expect(result.response?.failedEnvironments).toContain('111111111111:us-west-2');
    });

    it('should handle multiple errors with same error type', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const error1: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Error 1',
      };

      const error2: IRegionOperationError = {
        region: 'eu-west-1',
        accountId: '222222222222',
        accountName: 'Audit',
        errorName: 'ValidationException',
        errorMessage: 'Error 2',
      };

      const operationResults: (void | IRegionOperationError)[] = [error1, error2];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.error?.name).toBe('ValidationException');
      expect(result.response?.environmentErrors).toHaveLength(2);
      expect(result.response?.failedEnvironments).toHaveLength(2);
    });

    it('should handle multiple errors with different error types', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const error1: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Error 1',
      };

      const error2: IRegionOperationError = {
        region: 'eu-west-1',
        accountId: '222222222222',
        accountName: 'Audit',
        errorName: 'AccessDeniedException',
        errorMessage: 'Error 2',
      };

      const operationResults: (void | IRegionOperationError)[] = [error1, error2];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.error?.name).toBe('MultipleErrors');
      expect(result.response?.environmentErrors).toHaveLength(2);
    });

    it('should handle dry run mode', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const operationResults: (void | IRegionOperationError)[] = [];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const response = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        true,
      );

      expect(response.dryRun).toBe(true);
      expect(response.summary).toContain('(dry-run)');
      expect(response.summary).toBe('macie enable (dry-run) completed');
    });

    it('should handle dry run mode with errors', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const regionError: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Test error',
      };

      const operationResults: (void | IRegionOperationError)[] = [regionError];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const response = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        true,
      );

      expect(response.dryRun).toBe(true);
      expect(response.summary).toContain('(dry-run) failed');
      expect(response.status).toBe(MODULE_STATE_CODE.FAILED);
    });

    it('should combine operation and cleanup results', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const operationError: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Operation error',
      };

      const cleanupError: IRegionOperationError = {
        region: 'eu-west-1',
        accountId: '222222222222',
        accountName: 'Audit',
        errorName: 'AccessDeniedException',
        errorMessage: 'Cleanup error',
      };

      const operationResults: (void | IRegionOperationError)[] = [operationError];
      const cleanupResults: (void | IRegionOperationError)[] = [cleanupError];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.response?.environmentErrors).toHaveLength(2);
      expect(result.response?.failedEnvironments).toHaveLength(2);
    });

    it('should build successful environments from organizationAdminConfig', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1', 'us-west-2'],
            managementAccountId: '111111111111',
            delegatedAdminAccountId: '222222222222',
          },
        ],
        delegatedAdminAccountConfig: [],
      };

      const operationResults: (void | IRegionOperationError)[] = [];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      // Should not have successfulEnvs when there are no errors
      expect(result.response?.successfulEnvs).toBeUndefined();
    });

    it('should build successful environments from delegatedAdminAccountConfig', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1'],
            adminAccountId: '222222222222',
            memberAccountIds: ['333333333333', '444444444444'],
          },
        ],
      };

      const regionError: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Test error',
      };

      const operationResults: (void | IRegionOperationError)[] = [regionError];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const result = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(result.response?.successfulEnvs).toBeDefined();
      expect(result.response?.successfulEnvs).toContain('333333333333:us-east-1');
      expect(result.response?.successfulEnvs).toContain('444444444444:us-east-1');
    });

    it('should include successful regions in status message when there are partial failures', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [
          {
            operation: 'enabled',
            regions: ['us-east-1'],
            managementAccountId: '111111111111',
            delegatedAdminAccountId: '222222222222',
          },
        ],
        delegatedAdminAccountConfig: [],
      };

      const regionError: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Test error',
      };

      const operationResults: (void | IRegionOperationError)[] = [regionError];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const response = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(response.summary).toContain('Successfully completed in us-east-1');
    });

    it('should handle multiple errors in same region', () => {
      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const error1: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '111111111111',
        accountName: 'Management',
        errorName: 'ValidationException',
        errorMessage: 'Error 1',
      };

      const error2: IRegionOperationError = {
        region: 'us-west-2',
        accountId: '222222222222',
        accountName: 'Audit',
        errorName: 'AccessDeniedException',
        errorMessage: 'Error 2',
      };

      const operationResults: (void | IRegionOperationError)[] = [error1, error2];
      const cleanupResults: (void | IRegionOperationError)[] = [];

      const response = responseBuilder.build(
        TEST_MODULE_NAME,
        TEST_OPERATION,
        serviceResponse,
        operationResults,
        cleanupResults,
        false,
      );

      expect(response.summary).toContain('us-west-2 (MultipleErrors)');
    });
  });

  describe('buildErrorResponse', () => {
    it('should build error response from Error object', () => {
      const error = new Error('Test error message');
      error.name = 'TestError';

      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const response = responseBuilder.buildErrorResponse(
        error,
        TEST_MODULE_NAME,
        TEST_OPERATION,
        false,
        serviceResponse,
      );

      expect(response.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(response.error).toBeDefined();
      expect(response.error?.name).toBe('TestError');
      expect(response.error?.message).toBe('Test error message');
      expect(response.summary).toBe('macie enable failed with error: Test error message');
      expect(response.moduleName).toBe(TEST_MODULE_NAME);
      expect(response.dryRun).toBe(false);
    });

    it('should build error response from non-Error object', () => {
      const error = 'String error message';

      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const response = responseBuilder.buildErrorResponse(
        error,
        TEST_MODULE_NAME,
        TEST_OPERATION,
        false,
        serviceResponse,
      );

      expect(response.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(response.error?.name).toBe('UnknownError');
      expect(response.error?.message).toBe('String error message');
    });

    it('should handle error response with regional errors in service response', () => {
      const error = new Error('Top level error');

      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
        environmentErrors: [
          {
            region: 'us-west-2',
            accountId: '111111111111',
            accountName: 'Management',
            errorName: 'ValidationException',
            errorMessage: 'Regional error',
          },
        ],
      };

      const response = responseBuilder.buildErrorResponse(
        error,
        TEST_MODULE_NAME,
        TEST_OPERATION,
        false,
        serviceResponse,
      );

      expect(response.error?.name).toBe('ValidationException');
    });

    it('should handle error response with multiple different regional errors', () => {
      const error = new Error('Top level error');

      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
        environmentErrors: [
          {
            region: 'us-west-2',
            accountId: '111111111111',
            accountName: 'Management',
            errorName: 'ValidationException',
            errorMessage: 'Error 1',
          },
          {
            region: 'eu-west-1',
            accountId: '222222222222',
            accountName: 'Audit',
            errorName: 'AccessDeniedException',
            errorMessage: 'Error 2',
          },
        ],
      };

      const response = responseBuilder.buildErrorResponse(
        error,
        TEST_MODULE_NAME,
        TEST_OPERATION,
        false,
        serviceResponse,
      );

      expect(response.error?.name).toBe('MultipleErrors');
    });

    it('should handle dry run in error response', () => {
      const error = new Error('Test error');

      const serviceResponse: ISecurityServiceModuleResponse = {
        organizationAdminConfig: [],
        delegatedAdminAccountConfig: [],
      };

      const response = responseBuilder.buildErrorResponse(
        error,
        TEST_MODULE_NAME,
        TEST_OPERATION,
        true,
        serviceResponse,
      );

      expect(response.dryRun).toBe(true);
    });
  });
});
