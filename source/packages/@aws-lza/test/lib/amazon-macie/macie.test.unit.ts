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

import { ClassificationScopeUpdateOperation } from '@aws-sdk/client-macie2';
import { Account } from '@aws-sdk/client-organizations';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all dependencies
vi.mock('../../../lib/common/logger', () => ({
  createLogger: vi.fn(() => ({
    processStart: vi.fn(),
    processEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    dryRun: vi.fn(),
  })),
}));

vi.mock('../../../lib/common/batch-processor', () => ({
  processEnableOperations: vi.fn(),
  processDisableOperations: vi.fn(),
}));

vi.mock('../../../lib/common/security/security-service-context-builder', () => ({
  SecurityServiceContextBuilder: vi.fn(),
}));

vi.mock('../../../lib/common/security/security-service-module-response-builder', () => ({
  SecurityServiceModuleResponseBuilder: vi.fn(),
}));

vi.mock('../../../lib/common/sts-functions', () => ({
  getCredentials: vi.fn(),
}));

vi.mock('../../../lib/common/security/delegated-admin-manager', () => ({
  DelegatedAdminManager: vi.fn().mockImplementation(() => ({
    enable: vi.fn().mockImplementation(
      async (
        _accountId: string,
        client: unknown,
        ops: {
          enable: (client: unknown, accountId: string, dryRun: boolean, logPrefix: string) => Promise<void>;
          getCurrent: (client: unknown, logPrefix: string) => Promise<string | null>;
        },
        dryRun: boolean,
        logPrefix: string,
      ) => {
        await ops.getCurrent(client, logPrefix);
        await ops.enable(client, _accountId, dryRun, logPrefix);
      },
    ),
    disable: vi.fn().mockImplementation(
      async (
        client: unknown,
        ops: {
          disable: (client: unknown, accountId: string, dryRun: boolean, logPrefix: string) => Promise<void>;
          getCurrent: (client: unknown, logPrefix: string) => Promise<string | null>;
        },
        dryRun: boolean,
        logPrefix: string,
      ) => {
        const currentAdmin = await ops.getCurrent(client, logPrefix);
        if (currentAdmin) {
          await ops.disable(client, currentAdmin, dryRun, logPrefix);
        }
      },
    ),
  })),
  manageOrganizationsApiDelegatedAdmin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/amazon-macie/functions', () => ({
  enableMacie: vi.fn(),
  disableMacie: vi.fn(),
  isMacieEnabled: vi.fn(),
}));

vi.mock('../../../lib/amazon-macie/organizations-delegated-admin-account', () => ({
  OrganizationsDelegatedAdminAccount: {
    getOrganizationAdminAccountId: vi.fn(),
    enableOrganizationAdminAccount: vi.fn(),
    disableOrganizationAdminAccount: vi.fn(),
  },
}));

vi.mock('../../../lib/amazon-macie/macie-members', () => ({
  MacieMembers: {
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock('../../../lib/amazon-macie/macie-session', () => ({
  MacieSession: {
    configure: vi.fn(),
    configureAutomatedDiscovery: vi.fn(),
    updateClassificationScope: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ DelegatedAdministrators: [] }),
  })),
  ListDelegatedAdministratorsCommand: vi.fn(),
  RegisterDelegatedAdministratorCommand: vi.fn(),
  DeregisterDelegatedAdministratorCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-macie2', () => ({
  Macie2Client: vi.fn(),
  AutoEnableMode: { ALL: 'ALL', NEW: 'NEW', NONE: 'NONE' },
  ClassificationScopeUpdateOperation: { ADD: 'ADD', REMOVE: 'REMOVE', REPLACE: 'REPLACE' },
}));

// Import after mocks
import { disableMacie, enableMacie, isMacieEnabled } from '../../../lib/amazon-macie/functions';
import { IMacieModuleRequest } from '../../../lib/amazon-macie/interfaces';
import { configureMacie, macieAccountSetup } from '../../../lib/amazon-macie/macie';
import { MacieMembers } from '../../../lib/amazon-macie/macie-members';
import { MacieSession } from '../../../lib/amazon-macie/macie-session';
import { OrganizationsDelegatedAdminAccount } from '../../../lib/amazon-macie/organizations-delegated-admin-account';
import { processDisableOperations, processEnableOperations } from '../../../lib/common/batch-processor';
import { AcceleratorModuleName } from '../../../lib/common/interfaces';
import { manageOrganizationsApiDelegatedAdmin } from '../../../lib/common/security/delegated-admin-manager';
import { SecurityServiceContextBuilder } from '../../../lib/common/security/security-service-context-builder';
import { SecurityServiceModuleResponseBuilder } from '../../../lib/common/security/security-service-module-response-builder';
import { getCredentials } from '../../../lib/common/sts-functions';
import { MODULE_STATE_CODE, SecurityModuleOperationAction } from '../../../lib/common/types';

describe('configureMacie', () => {
  const mockCredentials = {
    accessKeyId: 'test-accessKeyId',
    secretAccessKey: 'test-secretAccessKey',
    sessionToken: 'test-sessionToken',
  };

  const mockOrganizationAccounts: Account[] = [
    { Id: '123456789012', Name: 'Management' },
    { Id: '111111111111', Name: 'DelegatedAdmin' },
    { Id: '222222222222', Name: 'Workload1' },
  ];

  const baseMacieRequest: IMacieModuleRequest = {
    invokingAccountId: '123456789012',
    region: 'us-east-1',
    globalRegion: 'us-east-1',
    partition: 'aws',
    solutionId: 'test-solution',
    credentials: mockCredentials,
    operation: 'enable',
    moduleName: AcceleratorModuleName.AMAZON_MACIE,
    configuration: {
      enable: true,
      delegatedAdminAccountId: '111111111111',
      accountAccessRoleName: 'TestRole',
      batchOperationSettings: {
        maxConcurrentEnvironments: 5,
        operationTimeoutMs: 60000,
      },
      s3Destination: {
        bucketName: 'test-bucket',
        keyPrefix: 'test-prefix',
        kmsKeyArn: 'test-key',
      },
      policyFindingsPublishingFrequency: 'FIFTEEN_MINUTES',
      publishSensitiveDataFindings: true,
      publishPolicyFindings: true,
      automatedDiscoveryEnabled: false,
    },
  };

  let mockContextBuilder: {
    build: ReturnType<typeof vi.fn>;
  };

  let mockResponseBuilder: {
    build: ReturnType<typeof vi.fn>;
    buildErrorResponse: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock context builder
    mockContextBuilder = {
      build: vi.fn().mockResolvedValue({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: ['us-east-1'],
        disabledRegions: [],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
          {
            name: 'DelegatedAdmin',
            order: 2,
            accounts: [mockOrganizationAccounts[1]],
          },
        ],
        disableOrderedAccounts: [],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      }),
    };
    (SecurityServiceContextBuilder as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockContextBuilder);

    // Mock response builder
    mockResponseBuilder = {
      build: vi
        .fn()
        .mockImplementation(
          (
            moduleName: string,
            operation: string,
            _data: unknown,
            _enableResults: unknown[],
            _disableResults: unknown[],
            dryRun: boolean,
          ) => ({
            status: MODULE_STATE_CODE.COMPLETED,
            moduleName: moduleName,
            dryRun: dryRun,
            summary: `${moduleName} ${operation} ${dryRun ? '(dry-run) ' : ''}completed`,
            timestamp: new Date().toISOString(),
            response: {
              sessionConfig: [],
              organizationAdminConfig: [],
              delegatedAdminAccountConfig: [],
            },
          }),
        ),
      buildErrorResponse: vi
        .fn()
        .mockImplementation((error: unknown, moduleName: string, operation: string, dryRun: boolean) => {
          let errorMessage = String(error);
          let errorName = 'UnknownError';

          if (error instanceof Error) {
            errorMessage = error.message;
            errorName = error.name;
          }

          return {
            status: MODULE_STATE_CODE.FAILED,
            moduleName: moduleName,
            dryRun: dryRun,
            summary: `${moduleName} ${operation} failed with error: ${errorMessage}`,
            timestamp: new Date().toISOString(),
            error: {
              name: errorName,
              message: errorMessage,
            },
            response: {
              sessionConfig: [],
              organizationAdminConfig: [],
              delegatedAdminAccountConfig: [],
            },
          };
        }),
    };
    (SecurityServiceModuleResponseBuilder as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockResponseBuilder,
    );

    // Mock batch processor functions
    (processEnableOperations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (processDisableOperations as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Mock Organizations API delegated admin function
    (manageOrganizationsApiDelegatedAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Mock other functions
    (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue(mockCredentials);
    (enableMacie as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (disableMacie as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (OrganizationsDelegatedAdminAccount.getOrganizationAdminAccountId as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    (OrganizationsDelegatedAdminAccount.enableOrganizationAdminAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (OrganizationsDelegatedAdminAccount.disableOrganizationAdminAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (MacieMembers.enable as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieMembers.disable as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieSession.configure as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieSession.configureAutomatedDiscovery as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  describe('Basic Functionality', () => {
    it('should successfully configure Macie with default values', async () => {
      const result = await configureMacie(baseMacieRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.COMPLETED);
      expect(result.moduleName).toBe('macie');
      expect(result.dryRun).toBe(false);
      expect(result.summary).toBe('macie enable completed');
      expect(SecurityServiceContextBuilder).toHaveBeenCalled();
      expect(processEnableOperations).toHaveBeenCalled();
      expect(SecurityServiceModuleResponseBuilder).toHaveBeenCalled();
    });

    it('should use default module name when moduleName is not provided', async () => {
      const requestWithoutModuleName = { ...baseMacieRequest, moduleName: undefined };
      const result = await configureMacie(requestWithoutModuleName);

      expect(result.status).toBe(MODULE_STATE_CODE.COMPLETED);
      expect(mockContextBuilder.build).toHaveBeenCalledWith(
        AcceleratorModuleName.AMAZON_MACIE,
        expect.anything(),
        'macie.amazonaws.com',
        expect.any(String),
      );
    });

    it('should call manageOrganizationsApiDelegatedAdmin before regional operations', async () => {
      await configureMacie(baseMacieRequest);

      // Verify Organizations API call was made
      expect(manageOrganizationsApiDelegatedAdmin).toHaveBeenCalledWith(
        expect.any(Object), // OrganizationsClient
        'macie.amazonaws.com',
        '111111111111', // delegatedAdminAccountId
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false, // dryRun
        '123456789012:us-east-1', // logPrefix
        expect.any(Object), // logger
      );

      // Verify it was called before processEnableOperations
      const orgApiCallOrder = (manageOrganizationsApiDelegatedAdmin as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const enableOpsCallOrder = (processEnableOperations as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(orgApiCallOrder).toBeLessThan(enableOpsCallOrder);
    });

    it('should create OrganizationsClient with correct configuration', async () => {
      const { OrganizationsClient } = await import('@aws-sdk/client-organizations');

      await configureMacie(baseMacieRequest);

      expect(OrganizationsClient).toHaveBeenCalledWith({
        region: 'us-east-1',
        customUserAgent: 'test-solution',
        retryStrategy: expect.any(Object),
        credentials: mockCredentials,
      });
    });

    it('should pass correct parameters to manageOrganizationsApiDelegatedAdmin in dry run mode', async () => {
      const dryRunRequest = { ...baseMacieRequest, dryRun: true };
      await configureMacie(dryRunRequest);

      expect(manageOrganizationsApiDelegatedAdmin).toHaveBeenCalledWith(
        expect.any(Object),
        'macie.amazonaws.com',
        '111111111111',
        ['us-east-1'],
        [],
        true, // dryRun should be true
        '123456789012:us-east-1',
        expect.any(Object),
      );
    });

    it('should pass disabled regions to manageOrganizationsApiDelegatedAdmin', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: ['us-east-1'],
        disabledRegions: ['us-west-2', 'eu-west-1'],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        disableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      expect(manageOrganizationsApiDelegatedAdmin).toHaveBeenCalledWith(
        expect.any(Object),
        'macie.amazonaws.com',
        '111111111111',
        ['us-east-1'],
        ['us-west-2', 'eu-west-1'], // Should include disabled regions
        false,
        '123456789012:us-east-1',
        expect.any(Object),
      );
    });

    it('should handle errors from manageOrganizationsApiDelegatedAdmin', async () => {
      const testError = new Error('Organizations API error');
      (manageOrganizationsApiDelegatedAdmin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(testError);

      const result = await configureMacie(baseMacieRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.error?.name).toBe('Error');
      expect(result.error?.message).toBe('Organizations API error');
      expect(mockResponseBuilder.buildErrorResponse).toHaveBeenCalledWith(
        testError,
        'macie',
        'enable',
        false,
        expect.any(Object),
      );

      // Verify regional operations were not called
      expect(processEnableOperations).not.toHaveBeenCalled();
      expect(processDisableOperations).not.toHaveBeenCalled();
    });

    it('should handle dry run mode', async () => {
      const dryRunRequest = { ...baseMacieRequest, dryRun: true };
      const result = await configureMacie(dryRunRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.COMPLETED);
      expect(result.dryRun).toBe(true);
      expect(result.summary).toBe('macie enable (dry-run) completed');
    });

    it('should call context builder with correct parameters', async () => {
      await configureMacie(baseMacieRequest);

      expect(mockContextBuilder.build).toHaveBeenCalledWith(
        AcceleratorModuleName.AMAZON_MACIE,
        baseMacieRequest,
        'macie.amazonaws.com',
        '123456789012:us-east-1',
      );
    });

    it('should call processEnableOperations when enabled regions exist', async () => {
      await configureMacie(baseMacieRequest);

      expect(processEnableOperations).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'macie',
          managementAccountId: '123456789012',
          targetRegions: ['us-east-1'],
          dryRun: false,
        }),
      );
    });

    it('should call processDisableOperations when disabled regions exist', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: [],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [],
        disableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      expect(processDisableOperations).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle errors from context builder', async () => {
      const testError = new Error('Context builder error');
      mockContextBuilder.build.mockRejectedValueOnce(testError);

      const result = await configureMacie(baseMacieRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.error?.name).toBe('Error');
      expect(result.error?.message).toBe('Context builder error');
      expect(mockResponseBuilder.buildErrorResponse).toHaveBeenCalledWith(
        testError,
        'macie',
        'enable',
        false,
        expect.any(Object),
      );
    });

    it('should handle non-Error exceptions', async () => {
      mockContextBuilder.build.mockRejectedValueOnce('String error');

      const result = await configureMacie(baseMacieRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(result.error?.name).toBe('UnknownError');
      expect(result.error?.message).toBe('String error');
    });

    it('should handle errors from processEnableOperations', async () => {
      const testError = new Error('Enable operation error');
      (processEnableOperations as ReturnType<typeof vi.fn>).mockRejectedValueOnce(testError);

      const result = await configureMacie(baseMacieRequest);

      expect(result.status).toBe(MODULE_STATE_CODE.FAILED);
      expect(mockResponseBuilder.buildErrorResponse).toHaveBeenCalled();
    });
  });

  describe('Response Building', () => {
    it('should build response with enable results', async () => {
      await configureMacie(baseMacieRequest);

      expect(mockResponseBuilder.build).toHaveBeenCalledWith(
        'macie',
        'enable',
        expect.objectContaining({
          organizationAdminConfig: expect.any(Array),
          delegatedAdminAccountConfig: expect.any(Array),
          sessionConfig: expect.any(Array),
        }),
        [], // enable results
        [], // disable results
        false,
      );
    });

    it('should handle both enable and disable operations', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: ['us-east-1'],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        disableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      expect(processEnableOperations).toHaveBeenCalled();
      expect(processDisableOperations).toHaveBeenCalled();
    });

    it('should handle empty enable responses', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: [],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [],
        disableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      expect(processEnableOperations).toHaveBeenCalled();
      expect(processDisableOperations).toHaveBeenCalled();
    });

    it('should handle empty disable responses', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: ['us-east-1'],
        disabledRegions: [],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        disableOrderedAccounts: [],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      expect(processEnableOperations).toHaveBeenCalled();
      expect(processDisableOperations).toHaveBeenCalled();
    });

    it('should build module response when enable responses are collected', async () => {
      // Mock processEnableOperations to actually call the handler and collect responses
      (processEnableOperations as ReturnType<typeof vi.fn>).mockImplementation(async config => {
        // Simulate handler adding a response with all three response types
        const propsWithResponses = config.props as IMacieModuleRequest & {
          collectedResponses?: Array<{
            region: string;
            accountId: string;
            response: {
              organizationAdmin?: unknown;
              delegatedAdmin?: unknown;
              session?: unknown;
            };
            operation: SecurityModuleOperationAction;
          }>;
        };
        if (propsWithResponses.collectedResponses) {
          propsWithResponses.collectedResponses.push({
            region: 'us-east-1',
            accountId: '123456789012',
            response: {
              organizationAdmin: {
                managementAccountId: '123456789012',
                delegatedAdminAccountId: '111111111111',
              },
              delegatedAdmin: {
                adminAccountId: '111111111111',
                memberAccountIds: ['222222222222'],
              },
              session: {
                accountIds: ['123456789012'],
                publishSensitiveDataFindings: true,
                findingPublishingFrequency: 'FIFTEEN_MINUTES',
              },
            },
            operation: 'enable',
          });
        }
        return [];
      });

      await configureMacie(baseMacieRequest);

      expect(mockResponseBuilder.build).toHaveBeenCalled();
    });

    it('should build module response when disable responses are collected', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: [],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [],
        disableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      // Mock processDisableOperations to actually call the handler and collect responses
      (processDisableOperations as ReturnType<typeof vi.fn>).mockImplementation(async config => {
        // Simulate handler adding a response with all three response types
        const propsWithResponses = config.props as IMacieModuleRequest & {
          collectedResponses?: Array<{
            region: string;
            accountId: string;
            response: {
              organizationAdmin?: unknown;
              delegatedAdmin?: unknown;
              session?: unknown;
            };
            operation: SecurityModuleOperationAction;
          }>;
        };
        if (propsWithResponses.collectedResponses) {
          propsWithResponses.collectedResponses.push({
            region: 'us-west-2',
            accountId: '123456789012',
            response: {
              organizationAdmin: {
                managementAccountId: '123456789012',
                delegatedAdminAccountId: '111111111111',
              },
              delegatedAdmin: {
                adminAccountId: '111111111111',
                memberAccountIds: ['222222222222'],
              },
              session: {
                accountIds: ['222222222222'],
              },
            },
            operation: 'disable',
          });
        }
        return [];
      });

      await configureMacie(baseMacieRequest);

      expect(mockResponseBuilder.build).toHaveBeenCalled();
    });
  });

  describe('Cleanup Operations', () => {
    it('should perform cleanup when disabled regions exist', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '123456789012',
        enabledRegions: ['us-east-1'],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        disableOrderedAccounts: [],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      await configureMacie(baseMacieRequest);

      // Should call processDisableOperations twice: once for disable, once for cleanup
      expect(processDisableOperations).toHaveBeenCalledTimes(2);
    });

    it('should not perform cleanup when no disabled regions', async () => {
      await configureMacie(baseMacieRequest);

      // Should only call processDisableOperations once (for disable, not cleanup)
      expect(processDisableOperations).toHaveBeenCalledTimes(1);
    });

    it('should skip cleanup when no cleanup accounts found', async () => {
      mockContextBuilder.build.mockResolvedValueOnce({
        moduleName: 'macie',
        managementAccountId: '999999999999', // Non-existent account
        enabledRegions: ['us-east-1'],
        disabledRegions: ['us-west-2'],
        enableOrderedAccounts: [
          {
            name: 'Management',
            order: 1,
            accounts: [mockOrganizationAccounts[0]],
          },
        ],
        disableOrderedAccounts: [],
        organizationAccounts: mockOrganizationAccounts,
        batchOperationSettings: { maxConcurrentEnvironments: 5, operationTimeoutMs: 60000 },
      });

      const requestWithDifferentDelegatedAdmin = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          delegatedAdminAccountId: 'ZZZZZZZZZZZZ', // Non-existent account
        },
      };

      await configureMacie(requestWithDifferentDelegatedAdmin);

      // Should only call processDisableOperations once (no cleanup since no accounts found)
      expect(processDisableOperations).toHaveBeenCalledTimes(1);
    });
  });
});

describe('macieAccountSetup', () => {
  const mockCredentials = {
    accessKeyId: 'test-accessKeyId',
    secretAccessKey: 'test-secretAccessKey',
    sessionToken: 'test-sessionToken',
  };

  const baseMacieRequest: IMacieModuleRequest = {
    invokingAccountId: '123456789012',
    region: 'us-east-1',
    globalRegion: 'us-east-1',
    partition: 'aws',
    solutionId: 'test-solution',
    credentials: mockCredentials,
    operation: 'enable',
    moduleName: AcceleratorModuleName.AMAZON_MACIE,
    configuration: {
      enable: true,
      delegatedAdminAccountId: '111111111111',
      accountAccessRoleName: 'TestRole',
      batchOperationSettings: {
        maxConcurrentEnvironments: 5,
        operationTimeoutMs: 60000,
      },
      s3Destination: {
        bucketName: 'test-bucket',
        keyPrefix: 'test-prefix',
        kmsKeyArn: 'test-key',
      },
      policyFindingsPublishingFrequency: 'FIFTEEN_MINUTES',
      publishSensitiveDataFindings: true,
      publishPolicyFindings: true,
      automatedDiscoveryEnabled: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessKeyId: 'assumed-key',
      secretAccessKey: 'assumed-secret',
      sessionToken: 'assumed-token',
    });
  });

  it('should return original props for management account', async () => {
    const managementAccount: Account = { Id: '123456789012', Name: 'Management' };

    const result = await macieAccountSetup(managementAccount, '123456789012', baseMacieRequest);

    expect(result).toBe(baseMacieRequest);
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('should assume role for non-management accounts', async () => {
    const targetAccount: Account = { Id: '111111111111', Name: 'DelegatedAdmin' };

    const result = await macieAccountSetup(targetAccount, '123456789012', baseMacieRequest);

    expect(getCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: 'aws',
        accountId: '111111111111',
        region: 'us-east-1',
        logPrefix: 'Invoker:us-east-1',
        solutionId: 'test-solution',
        assumeRoleName: 'TestRole',
        credentials: mockCredentials,
      }),
    );

    expect(result.credentials).toEqual({
      accessKeyId: 'assumed-key',
      secretAccessKey: 'assumed-secret',
      sessionToken: 'assumed-token',
    });
  });
});

describe('Handler Functions', () => {
  const mockCredentials = {
    accessKeyId: 'test-accessKeyId',
    secretAccessKey: 'test-secretAccessKey',
    sessionToken: 'test-sessionToken',
  };

  const mockOrganizationAccounts: Account[] = [
    { Id: '123456789012', Name: 'Management' },
    { Id: '111111111111', Name: 'DelegatedAdmin' },
    { Id: '222222222222', Name: 'Workload1' },
  ];

  const baseMacieRequest: IMacieModuleRequest = {
    invokingAccountId: '123456789012',
    region: 'us-east-1',
    globalRegion: 'us-east-1',
    partition: 'aws',
    solutionId: 'test-solution',
    credentials: mockCredentials,
    operation: 'enable',
    moduleName: AcceleratorModuleName.AMAZON_MACIE,
    configuration: {
      enable: true,
      delegatedAdminAccountId: '111111111111',
      accountAccessRoleName: 'TestRole',
      batchOperationSettings: {
        maxConcurrentEnvironments: 5,
        operationTimeoutMs: 60000,
      },
      s3Destination: {
        bucketName: 'test-bucket',
        keyPrefix: 'test-prefix',
        kmsKeyArn: 'test-key',
      },
      policyFindingsPublishingFrequency: 'FIFTEEN_MINUTES',
      publishSensitiveDataFindings: true,
      publishPolicyFindings: true,
      automatedDiscoveryEnabled: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (enableMacie as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (disableMacie as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (OrganizationsDelegatedAdminAccount.enableOrganizationAdminAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (OrganizationsDelegatedAdminAccount.disableOrganizationAdminAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (OrganizationsDelegatedAdminAccount.getOrganizationAdminAccountId as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    (MacieMembers.enable as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieMembers.disable as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieSession.configure as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieSession.configureAutomatedDiscovery as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (MacieSession.updateClassificationScope as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  describe('macieEnableHandler', () => {
    it('should enable Macie for management account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[0],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(enableMacie).toHaveBeenCalled();
      // Management account uses DelegatedAdminManager, not direct call
      expect(collectedResponses).toHaveLength(1);
    });

    it('should enable Macie for delegated admin account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(enableMacie).toHaveBeenCalled();
      expect(MacieMembers.enable).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });

    it('should enable Macie for workload account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(enableMacie).toHaveBeenCalled();
      expect(MacieSession.configure).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });

    it('should skip enableMacie when already enabled', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        baseMacieRequest,
        mockOrganizationAccounts,
      );

      expect(enableMacie).not.toHaveBeenCalled();
      expect(MacieSession.configure).toHaveBeenCalled();
    });

    it('should handle undefined organizationAccounts by defaulting to empty array', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        undefined,
      );

      expect(MacieSession.configure).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });
  });

  describe('macieDisableHandler', () => {
    it('should disable Macie for management account', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (OrganizationsDelegatedAdminAccount.getOrganizationAdminAccountId as ReturnType<typeof vi.fn>).mockResolvedValue(
        '111111111111',
      );
      const { macieDisableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieDisableHandler(
        '123456789012',
        mockOrganizationAccounts[0],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      // Management account disables delegated admin, which uses DelegatedAdminManager
      expect(collectedResponses).toHaveLength(1);
    });

    it('should disable Macie for delegated admin account', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieDisableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieDisableHandler(
        '123456789012',
        mockOrganizationAccounts[1],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieMembers.disable).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });

    it('should disable Macie for workload account', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieDisableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieDisableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(disableMacie).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });

    it('should return early when Macie already disabled', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const { macieDisableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieDisableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(disableMacie).not.toHaveBeenCalled();
      // Even when Macie is already disabled, the handler still adds an empty response
      // This is by design - the response object is empty but still tracked
      expect(collectedResponses).toHaveLength(1);
    });

    it('should handle undefined organizationAccounts by defaulting to empty array', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieDisableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieDisableHandler(
        '123456789012',
        mockOrganizationAccounts[2],
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        undefined,
      );

      expect(disableMacie).toHaveBeenCalled();
      expect(collectedResponses).toHaveLength(1);
    });
  });

  describe('macieFinalCleanupHandler', () => {
    it('should disable Macie when enabled', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieFinalCleanupHandler } = await import('../../../lib/amazon-macie/macie.js');

      await macieFinalCleanupHandler(
        '123456789012',
        mockOrganizationAccounts[0],
        'us-east-1',
        false,
        'test-prefix',
        baseMacieRequest,
      );

      expect(disableMacie).toHaveBeenCalled();
    });

    it('should skip disable when Macie already disabled', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const { macieFinalCleanupHandler } = await import('../../../lib/amazon-macie/macie.js');

      await macieFinalCleanupHandler(
        '123456789012',
        mockOrganizationAccounts[0],
        'us-east-1',
        false,
        'test-prefix',
        baseMacieRequest,
      );

      expect(disableMacie).not.toHaveBeenCalled();
    });

    it('should handle dry run mode', async () => {
      (isMacieEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { macieFinalCleanupHandler } = await import('../../../lib/amazon-macie/macie.js');

      await macieFinalCleanupHandler(
        '123456789012',
        mockOrganizationAccounts[0],
        'us-east-1',
        true,
        'test-prefix',
        baseMacieRequest,
      );

      expect(disableMacie).toHaveBeenCalledWith(expect.anything(), true, 'test-prefix');
    });
  });

  describe('skipClassificationExport logic', () => {
    it('should pass skipClassificationExport: false for delegated admin account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          skipClassificationExport: false,
        }),
      );
    });

    it('should pass skipClassificationExport: true for workload account by default', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2], // Workload1 (222222222222)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          skipClassificationExport: true,
        }),
      );
    });

    it('should pass skipClassificationExport: true for management account by default', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[0], // Management (123456789012)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          skipClassificationExport: true,
        }),
      );
    });
  });

  describe('configureAutomatedDiscovery logic', () => {
    it('should call configureAutomatedDiscovery on delegated admin when automatedDiscoveryEnabled is true', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithDiscovery: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
        },
      };
      const propsWithResponses = { ...requestWithDiscovery, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configureAutomatedDiscovery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          autoEnableOrganizationMembers: 'ALL',
          dryRun: false,
        }),
      );
    });

    it('should call configureAutomatedDiscovery with enabled: false when automatedDiscoveryEnabled is false', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithDisabledDiscovery: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: false,
        },
      };
      const propsWithResponses = { ...requestWithDisabledDiscovery, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configureAutomatedDiscovery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          autoEnableOrganizationMembers: 'NONE',
        }),
      );
    });

    it('should call configureAutomatedDiscovery with enabled: false on delegated admin when automatedDiscoveryEnabled is false', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const propsWithResponses = { ...baseMacieRequest, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configureAutomatedDiscovery).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          autoEnableOrganizationMembers: 'NONE',
        }),
      );
    });

    it('should not call configureAutomatedDiscovery on workload accounts', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithDiscovery: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
        },
      };
      const propsWithResponses = { ...requestWithDiscovery, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2], // Workload1 (222222222222)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configureAutomatedDiscovery).not.toHaveBeenCalled();
    });

    it('should not call configureAutomatedDiscovery on management account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithDiscovery: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
        },
      };
      const propsWithResponses = { ...requestWithDiscovery, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[0], // Management (123456789012)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.configureAutomatedDiscovery).not.toHaveBeenCalled();
    });
  });

  describe('updateClassificationScope logic', () => {
    it('should call updateClassificationScope on delegated admin with region-aware buckets', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithExclusion: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
          classificationScopeExclusion: {
            buckets: [
              { name: 'my-logging-bucket', region: 'us-east-1' },
              { name: 'my-cloudtrail-bucket', region: 'us-east-1' },
              { name: 'my-west-bucket', region: 'us-west-2' },
            ],
            operation: ClassificationScopeUpdateOperation.REPLACE,
          },
        },
      };
      const propsWithResponses = { ...requestWithExclusion, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).toHaveBeenCalledWith(
        expect.objectContaining({
          buckets: [
            { name: 'my-logging-bucket', region: 'us-east-1' },
            { name: 'my-cloudtrail-bucket', region: 'us-east-1' },
            { name: 'my-west-bucket', region: 'us-west-2' },
          ],
          operation: 'REPLACE',
          targetRegion: 'us-east-1',
          dryRun: false,
        }),
      );
    });

    it('should not call updateClassificationScope when automatedDiscoveryEnabled is false', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithExclusionButNoDiscovery: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: false,
          classificationScopeExclusion: {
            buckets: [{ name: 'my-logging-bucket', region: 'us-east-1' }],
            operation: ClassificationScopeUpdateOperation.REPLACE,
          },
        },
      };
      const propsWithResponses = { ...requestWithExclusionButNoDiscovery, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).not.toHaveBeenCalled();
    });

    it('should not call updateClassificationScope when classificationScopeExclusion is undefined', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithDiscoveryOnly: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
        },
      };
      const propsWithResponses = { ...requestWithDiscoveryOnly, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).not.toHaveBeenCalled();
    });

    it('should not call updateClassificationScope on workload accounts', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithExclusion: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
          classificationScopeExclusion: {
            buckets: [{ name: 'my-logging-bucket', region: 'us-east-1' }],
            operation: ClassificationScopeUpdateOperation.REPLACE,
          },
        },
      };
      const propsWithResponses = { ...requestWithExclusion, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[2], // Workload1 (222222222222)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).not.toHaveBeenCalled();
    });

    it('should not call updateClassificationScope on management account', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithExclusion: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
          classificationScopeExclusion: {
            buckets: [{ name: 'my-logging-bucket', region: 'us-east-1' }],
            operation: ClassificationScopeUpdateOperation.REPLACE,
          },
        },
      };
      const propsWithResponses = { ...requestWithExclusion, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[0], // Management (123456789012)
        'us-east-1',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).not.toHaveBeenCalled();
    });

    it('should pass targetRegion matching the handler target region', async () => {
      const { macieEnableHandler } = await import('../../../lib/amazon-macie/macie.js');
      const collectedResponses: unknown[] = [];
      const requestWithExclusion: IMacieModuleRequest = {
        ...baseMacieRequest,
        configuration: {
          ...baseMacieRequest.configuration,
          automatedDiscoveryEnabled: true,
          classificationScopeExclusion: {
            buckets: [
              { name: 'bucket-east-2', region: 'us-east-2' },
              { name: 'bucket-east-1', region: 'us-east-1' },
            ],
            operation: ClassificationScopeUpdateOperation.REPLACE,
          },
        },
      };
      const propsWithResponses = { ...requestWithExclusion, collectedResponses };

      await macieEnableHandler(
        '123456789012',
        mockOrganizationAccounts[1], // DelegatedAdmin (111111111111)
        'us-east-2',
        false,
        'test-prefix',
        propsWithResponses,
        mockOrganizationAccounts,
      );

      expect(MacieSession.updateClassificationScope).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRegion: 'us-east-2',
        }),
      );
    });
  });
});
