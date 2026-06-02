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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Account, OrganizationsClient } from '@aws-sdk/client-organizations';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundaryResolver, BoundaryType } from '../../../../lib/common/boundary-resolver';
import {
  DEFAULT_MAX_CONCURRENT_ENVIRONMENTS,
  DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS,
} from '../../../../lib/common/constants';
import {
  AcceleratorModuleName,
  IModuleRegionFilters,
  IModuleRequest,
  ISecurityBaseConfig,
} from '../../../../lib/common/interfaces';
import { IconLogger } from '../../../../lib/common/logger';
import * as organizationsFunctions from '../../../../lib/common/organizations-functions';
import { SecurityServiceContextBuilder } from '../../../../lib/common/security/security-service-context-builder';
import * as utility from '../../../../lib/common/utility';

// Test configuration interface that extends ISecurityBaseConfig with additional properties
interface ITestSecurityConfig extends ISecurityBaseConfig {
  readonly regionFilters?: IModuleRegionFilters;
  readonly boundary?: {
    regions?: string[];
  };
  readonly concurrency?: {
    maxConcurrentEnvironments?: number;
    operationTimeoutMs?: number;
  };
  readonly dataSources?: {
    organizations?: {
      tableName: string;
      accountIdColumnName: string;
      accountNameColumnName: string;
    };
  };
}

// Test interface that extends IModuleRequest with configuration
interface ITestModuleRequest extends IModuleRequest {
  readonly configuration: ITestSecurityConfig;
}

// Mock all dependencies
vi.mock('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(),
}));

describe('SecurityServiceContextBuilder', () => {
  let contextBuilder: SecurityServiceContextBuilder;
  let mockLogger: IconLogger;
  let mockProps: ITestModuleRequest;
  let mockAccounts: Account[];

  const TEST_SERVICE_NAME = 'macie.amazonaws.com';
  const TEST_LOG_PREFIX = 'test-prefix';
  const MANAGEMENT_ACCOUNT_ID = '111111111111';
  const DELEGATED_ADMIN_ACCOUNT_ID = '222222222222';
  const WORKLOAD_ACCOUNT_ID_1 = '333333333333';
  const WORKLOAD_ACCOUNT_ID_2 = '444444444444';

  beforeEach(() => {
    vi.clearAllMocks();
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

    // Create mock accounts
    mockAccounts = [
      { Id: MANAGEMENT_ACCOUNT_ID, Name: 'Management', Status: 'ACTIVE' } as Account,
      { Id: DELEGATED_ADMIN_ACCOUNT_ID, Name: 'Audit', Status: 'ACTIVE' } as Account,
      { Id: WORKLOAD_ACCOUNT_ID_1, Name: 'Workload1', Status: 'ACTIVE' } as Account,
      { Id: WORKLOAD_ACCOUNT_ID_2, Name: 'Workload2', Status: 'ACTIVE' } as Account,
    ];

    // Create mock props
    mockProps = {
      moduleName: AcceleratorModuleName.AMAZON_MACIE,
      operation: 'enable',
      invokingAccountId: MANAGEMENT_ACCOUNT_ID,
      region: 'us-east-1',
      globalRegion: 'us-east-1',
      partition: 'aws',
      solutionId: 'test-solution',
      credentials: {} as never,
      configuration: {
        enable: true,
        delegatedAdminAccountId: DELEGATED_ADMIN_ACCOUNT_ID,
        accountAccessRoleName: 'AWSControlTowerExecution',
        regionFilters: [],
        boundary: {
          regions: ['us-east-1', 'us-west-2'],
        },
      },
    } as ITestModuleRequest;

    // Create context builder instance
    contextBuilder = new SecurityServiceContextBuilder(mockLogger);

    // Mock utility functions
    vi.spyOn(utility, 'validateRegionFilters').mockReturnValue(undefined);
    vi.spyOn(utility, 'setRetryStrategy').mockReturnValue({} as never);

    // Mock organizations functions
    vi.spyOn(organizationsFunctions, 'isManagementAccount').mockResolvedValue(true);
    vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(mockAccounts);
    vi.spyOn(organizationsFunctions, 'getOrganizationAccountsFromSourceTable').mockResolvedValue(mockAccounts);

    // Mock BoundaryResolver
    vi.spyOn(BoundaryResolver, 'calculateBoundaries').mockResolvedValue({
      enabledBoundaries: ['us-east-1', 'us-west-2'],
      disabledBoundaries: [],
    });
  });

  describe('build', () => {
    it('should successfully build context with all required data', async () => {
      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context).toBeDefined();
      expect(context.moduleName).toBe(AcceleratorModuleName.AMAZON_MACIE);
      expect(context.serviceName).toBe(TEST_SERVICE_NAME);
      expect(context.logPrefix).toBe(TEST_LOG_PREFIX);
      expect(context.managementAccountId).toBe(MANAGEMENT_ACCOUNT_ID);
      expect(context.organizationAccounts).toEqual(mockAccounts);
      expect(context.enabledRegions).toEqual(['us-east-1', 'us-west-2']);
      expect(context.disabledRegions).toEqual([]);
      expect(context.props).toBe(mockProps);
    });

    it('should throw error when not invoked from management account', async () => {
      vi.spyOn(organizationsFunctions, 'isManagementAccount').mockResolvedValue(false);

      await expect(
        contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX),
      ).rejects.toThrow('is not the AWS Organizations Management Account');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('not the AWS Organizations'),
        TEST_LOG_PREFIX,
      );
    });

    it('should validate region filters', async () => {
      await contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX);

      expect(utility.validateRegionFilters).toHaveBeenCalledWith(
        mockProps.configuration.enable,
        mockLogger,
        TEST_LOG_PREFIX,
        mockProps.configuration.regionFilters,
      );
    });

    it('should create Organizations client with correct configuration', async () => {
      await contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX);

      expect(OrganizationsClient).toHaveBeenCalledWith({
        region: mockProps.region,
        customUserAgent: mockProps.solutionId,
        retryStrategy: {},
        credentials: mockProps.credentials,
      });
    });

    it('should retrieve accounts from Organizations API when no data source configured', async () => {
      await contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX);

      expect(organizationsFunctions.getOrganizationAccounts).toHaveBeenCalled();
      expect(organizationsFunctions.getOrganizationAccountsFromSourceTable).not.toHaveBeenCalled();
    });

    it('should retrieve accounts from DynamoDB when data source configured', async () => {
      const propsWithDataSource = {
        ...mockProps,
        configuration: {
          ...mockProps.configuration,
          dataSources: {
            organizations: {
              tableName: 'test-table',
              accountIdColumnName: 'accountId',
              accountNameColumnName: 'accountName',
            },
          },
        },
      };

      await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        propsWithDataSource,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(organizationsFunctions.getOrganizationAccountsFromSourceTable).toHaveBeenCalled();
      expect(organizationsFunctions.getOrganizationAccounts).not.toHaveBeenCalled();
      expect(DynamoDBClient).toHaveBeenCalledWith({
        region: mockProps.region,
        customUserAgent: mockProps.solutionId,
        retryStrategy: {},
        credentials: mockProps.credentials,
      });
    });

    it('should calculate regional boundaries', async () => {
      await contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX);

      expect(BoundaryResolver.calculateBoundaries).toHaveBeenCalledWith(
        BoundaryType.REGIONS,
        mockProps.configuration.enable,
        {
          partition: mockProps.partition,
          region: mockProps.region,
          solutionId: mockProps.solutionId,
          credentials: mockProps.credentials,
        },
        mockProps.configuration.boundary?.regions,
        mockProps.configuration.regionFilters,
      );
    });

    it('should use default concurrency settings when not provided', async () => {
      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.batchOperationSettings.maxConcurrentEnvironments).toBe(DEFAULT_MAX_CONCURRENT_ENVIRONMENTS);
      expect(context.batchOperationSettings.operationTimeoutMs).toBe(DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS);
    });

    it('should use custom concurrency settings when provided', async () => {
      const propsWithConcurrency = {
        ...mockProps,
        configuration: {
          ...mockProps.configuration,
          batchOperationSettings: {
            maxConcurrentEnvironments: 20,
            operationTimeoutMs: 600000,
          },
        },
      };

      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        propsWithConcurrency,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.batchOperationSettings.maxConcurrentEnvironments).toBe(20);
      expect(context.batchOperationSettings.operationTimeoutMs).toBe(600000);
    });

    it('should sort accounts for enable operations correctly', async () => {
      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.enableOrderedAccounts).toHaveLength(3);
      expect(context.enableOrderedAccounts[0].name).toBe('Management');
      expect(context.enableOrderedAccounts[0].order).toBe(1);
      expect(context.enableOrderedAccounts[0].accounts).toHaveLength(1);
      expect(context.enableOrderedAccounts[0].accounts[0].Id).toBe(MANAGEMENT_ACCOUNT_ID);

      expect(context.enableOrderedAccounts[1].name).toBe('DelegatedAdmin');
      expect(context.enableOrderedAccounts[1].order).toBe(2);
      expect(context.enableOrderedAccounts[1].accounts).toHaveLength(1);
      expect(context.enableOrderedAccounts[1].accounts[0].Id).toBe(DELEGATED_ADMIN_ACCOUNT_ID);

      expect(context.enableOrderedAccounts[2].name).toBe('WorkLoads');
      expect(context.enableOrderedAccounts[2].order).toBe(3);
      expect(context.enableOrderedAccounts[2].accounts).toHaveLength(2);
    });

    it('should sort accounts for disable operations correctly', async () => {
      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.disableOrderedAccounts).toHaveLength(3);
      expect(context.disableOrderedAccounts[0].name).toBe('DelegatedAdmin');
      expect(context.disableOrderedAccounts[0].order).toBe(1);
      expect(context.disableOrderedAccounts[0].accounts).toHaveLength(1);
      expect(context.disableOrderedAccounts[0].accounts[0].Id).toBe(DELEGATED_ADMIN_ACCOUNT_ID);

      expect(context.disableOrderedAccounts[1].name).toBe('Management');
      expect(context.disableOrderedAccounts[1].order).toBe(2);
      expect(context.disableOrderedAccounts[1].accounts).toHaveLength(1);
      expect(context.disableOrderedAccounts[1].accounts[0].Id).toBe(MANAGEMENT_ACCOUNT_ID);

      expect(context.disableOrderedAccounts[2].name).toBe('WorkLoads');
      expect(context.disableOrderedAccounts[2].order).toBe(3);
      expect(context.disableOrderedAccounts[2].accounts).toHaveLength(2);
    });

    it('should throw error when management account not found in organization accounts', async () => {
      const accountsWithoutManagement = mockAccounts.filter(acc => acc.Id !== MANAGEMENT_ACCOUNT_ID);
      vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(accountsWithoutManagement);

      await expect(
        contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX),
      ).rejects.toThrow(`Management account ${MANAGEMENT_ACCOUNT_ID} not found`);
    });

    it('should throw error when delegated admin account not found in organization accounts', async () => {
      const accountsWithoutDelegatedAdmin = mockAccounts.filter(acc => acc.Id !== DELEGATED_ADMIN_ACCOUNT_ID);
      vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(accountsWithoutDelegatedAdmin);

      await expect(
        contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX),
      ).rejects.toThrow(`Delegated admin account ${DELEGATED_ADMIN_ACCOUNT_ID} not found`);
    });

    it('should log all major steps during context building', async () => {
      await contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX);

      expect(mockLogger.processStart).toHaveBeenCalledWith('Starting amazon-macie module', TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Execution invoked from'), TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith('Validating region filter configuration', TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Region filter configuration validated successfully',
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Management account verified, proceeding with security service setup',
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Get Organizations Accounts', TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Service will be enabled in regions'),
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Service will be disabled in regions'),
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Batch operation settings resolved'),
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Enable account ordering'), TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Disable account ordering'),
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Account ordering configured'),
        TEST_LOG_PREFIX,
      );
    });

    it('should handle enabled and disabled regions correctly', async () => {
      vi.spyOn(BoundaryResolver, 'calculateBoundaries').mockResolvedValue({
        enabledBoundaries: ['us-east-1', 'us-west-2'],
        disabledBoundaries: ['eu-west-1', 'ap-southeast-1'],
      });

      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.enabledRegions).toEqual(['us-east-1', 'us-west-2']);
      expect(context.disabledRegions).toEqual(['eu-west-1', 'ap-southeast-1']);
    });

    it('should handle empty workload accounts list', async () => {
      const minimalAccounts = [
        { Id: MANAGEMENT_ACCOUNT_ID, Name: 'Management', Status: 'ACTIVE' } as Account,
        { Id: DELEGATED_ADMIN_ACCOUNT_ID, Name: 'Audit', Status: 'ACTIVE' } as Account,
      ];
      vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(minimalAccounts);

      const context = await contextBuilder.build(
        AcceleratorModuleName.AMAZON_MACIE,
        mockProps,
        TEST_SERVICE_NAME,
        TEST_LOG_PREFIX,
      );

      expect(context.enableOrderedAccounts[2].accounts).toHaveLength(0);
      expect(context.disableOrderedAccounts[2].accounts).toHaveLength(0);
    });

    it('should throw error when management account not found during disable operations', async () => {
      // Mock to have disabled regions so sortAccountsForDisable is called
      vi.spyOn(BoundaryResolver, 'calculateBoundaries').mockResolvedValue({
        enabledBoundaries: [],
        disabledBoundaries: ['us-west-2'],
      });

      // Mock accounts without management account
      const accountsWithoutManagement = [
        { Id: DELEGATED_ADMIN_ACCOUNT_ID, Name: 'Audit', Status: 'ACTIVE' } as Account,
        { Id: WORKLOAD_ACCOUNT_ID_1, Name: 'Workload1', Status: 'ACTIVE' } as Account,
      ];
      vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(accountsWithoutManagement);

      await expect(
        contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX),
      ).rejects.toThrow(`Management account ${MANAGEMENT_ACCOUNT_ID} not found in the list of Organizations accounts`);
    });

    it('should throw error when delegated admin account not found during disable operations', async () => {
      // Mock to have disabled regions so sortAccountsForDisable is called
      vi.spyOn(BoundaryResolver, 'calculateBoundaries').mockResolvedValue({
        enabledBoundaries: [],
        disabledBoundaries: ['us-west-2'],
      });

      // Mock accounts without delegated admin account
      const accountsWithoutDelegatedAdmin = [
        { Id: MANAGEMENT_ACCOUNT_ID, Name: 'Management', Status: 'ACTIVE' } as Account,
        { Id: WORKLOAD_ACCOUNT_ID_1, Name: 'Workload1', Status: 'ACTIVE' } as Account,
      ];
      vi.spyOn(organizationsFunctions, 'getOrganizationAccounts').mockResolvedValue(accountsWithoutDelegatedAdmin);

      await expect(
        contextBuilder.build(AcceleratorModuleName.AMAZON_MACIE, mockProps, TEST_SERVICE_NAME, TEST_LOG_PREFIX),
      ).rejects.toThrow(
        `Delegated admin account ${DELEGATED_ADMIN_ACCOUNT_ID} not found in the list of Organizations accounts`,
      );
    });
  });
});
