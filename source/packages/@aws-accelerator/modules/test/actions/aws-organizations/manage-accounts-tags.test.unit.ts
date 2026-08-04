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

import { beforeEach, describe, test, vi, expect, afterEach } from 'vitest';

vi.mock('../../../../accelerator', () => ({
  AcceleratorStage: {
    ACCOUNTS: 'ACCOUNTS',
  },
}));

import { AcceleratorModules, ModuleExecutionPhase } from '../../../models/enums';
import { AcceleratorStage } from '../../../../accelerator';
import { ModuleParams } from '../../../models/types';
import { MOCK_CONSTANTS, mockGlobalConfiguration } from '../../mocked-resources';
import { AccountConfig, AccountsConfig, OrganizationConfig } from '@aws-accelerator/config';
import * as awsLza from '../../../../../@aws-lza/index';
import { ManageAccountsTagsModule } from '../../../lib/actions/aws-organizations/manage-accounts-tags';

describe('ManageAccountsTagsModule', () => {
  const status = 'mock status';
  let mockOrganizationConfig: Partial<OrganizationConfig>;

  const mockAccountsWithTags: Partial<AccountsConfig> = {
    mandatoryAccounts: [
      {
        name: 'Management',
        description: 'mockManagement',
        email: 'mockManagement@example.com',
        organizationalUnit: 'Root',
        tags: [{ key: 'Environment', value: 'Production' }],
      },
      {
        name: 'LogArchive',
        description: 'mockLogArchive',
        email: 'mockLogArchive@example.com',
        organizationalUnit: 'Security',
        tags: [{ key: 'CostCenter', value: 'Security' }],
      },
      {
        name: 'Audit',
        description: 'mockAudit',
        email: 'mockAudit@example.com',
        organizationalUnit: 'Security',
      },
    ] as AccountConfig[],
    workloadAccounts: [] as AccountConfig[],
  };

  const mockAccountsWithoutTags: Partial<AccountsConfig> = {
    mandatoryAccounts: [
      {
        name: 'Management',
        description: 'mockManagement',
        email: 'mockManagement@example.com',
        organizationalUnit: 'Root',
      },
    ] as AccountConfig[],
    workloadAccounts: [] as AccountConfig[],
  };

  const createBaseMockAccountsConfig = () => ({
    getAccountId: vi.fn().mockReturnValue('111111111111'),
    getActiveAccountIds: vi.fn().mockReturnValue(['111111111111']),
  });

  const createModuleParams = (accountsConfig: Partial<AccountsConfig>): ModuleParams => ({
    moduleItem: {
      name: AcceleratorModules.MANAGE_ACCOUNTS_TAGS,
      description: '',
      runOrder: 3,
      handler: vi.fn().mockResolvedValue(`Module 3 of ${AcceleratorStage.ACCOUNTS} stage executed`),
      executionPhase: ModuleExecutionPhase.DEPLOY,
    },
    runnerParameters: MOCK_CONSTANTS.runnerParameters,
    moduleRunnerParameters: {
      configs: {
        ...MOCK_CONSTANTS.configs,
        accountsConfig: accountsConfig as AccountsConfig,
        globalConfig: mockGlobalConfiguration,
        organizationConfig: mockOrganizationConfig as OrganizationConfig,
      },
      globalRegion: MOCK_CONSTANTS.globalRegion,
      resourcePrefixes: MOCK_CONSTANTS.resourcePrefixes,
      acceleratorResourceNames: MOCK_CONSTANTS.acceleratorResourceNames,
      logging: MOCK_CONSTANTS.logging,
      organizationDetails: MOCK_CONSTANTS.organizationDetails,
      organizationAccounts: MOCK_CONSTANTS.organizationAccounts,
      managementAccountCredentials: MOCK_CONSTANTS.credentials,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(awsLza, 'manageAccountTags').mockResolvedValue(status);

    mockOrganizationConfig = {
      getIgnoredOus: vi.fn().mockReturnValue([]),
    };
  });

  test('Should execute successfully for accounts with tags', async () => {
    const mockAccountsConfig = {
      ...createBaseMockAccountsConfig(),
      ...mockAccountsWithTags,
    };
    const param = createModuleParams(mockAccountsConfig);

    const response = await ManageAccountsTagsModule.execute(param);

    // Two accounts have tags configured (Management and LogArchive)
    expect(awsLza.manageAccountTags).toHaveBeenCalledTimes(2);
    expect(response).toBe(
      `Module "${AcceleratorModules.MANAGE_ACCOUNTS_TAGS}" completed successfully for 2 account(s)`,
    );

    // No global policy configured -> safe "managed" default for every account
    expect(awsLza.manageAccountTags).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configuration: expect.objectContaining({ removalPolicy: 'managed' }) }),
    );
    expect(awsLza.manageAccountTags).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configuration: expect.objectContaining({ removalPolicy: 'managed' }) }),
    );
  });

  test('Should apply the global accountTagRemovalPolicy to every account', async () => {
    const mockAccountsConfig = {
      ...createBaseMockAccountsConfig(),
      ...mockAccountsWithTags,
      accountTagRemovalPolicy: 'authoritative' as const,
    };
    const param = createModuleParams(mockAccountsConfig);

    await ManageAccountsTagsModule.execute(param);

    expect(awsLza.manageAccountTags).toHaveBeenCalledTimes(2);
    expect(awsLza.manageAccountTags).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configuration: expect.objectContaining({ removalPolicy: 'authoritative' }) }),
    );
    expect(awsLza.manageAccountTags).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configuration: expect.objectContaining({ removalPolicy: 'authoritative' }) }),
    );
  });

  test('Should skip when no accounts have tags', async () => {
    const mockAccountsConfig = {
      ...createBaseMockAccountsConfig(),
      ...mockAccountsWithoutTags,
    };
    const param = createModuleParams(mockAccountsConfig);

    const response = await ManageAccountsTagsModule.execute(param);

    expect(awsLza.manageAccountTags).toHaveBeenCalledTimes(0);
    expect(response).toBe(
      `Skipping module "${AcceleratorModules.MANAGE_ACCOUNTS_TAGS}" because no accounts have tags configured`,
    );
  });

  test('Should filter out inactive accounts', async () => {
    const mockAccountsConfig = {
      ...createBaseMockAccountsConfig(),
      getAccountId: vi
        .fn()
        .mockReturnValueOnce('111111111111') // Management - active
        .mockReturnValueOnce('222222222222') // LogArchive - inactive
        .mockReturnValue('111111111111'),
      getActiveAccountIds: vi.fn().mockReturnValue(['111111111111']),
      ...mockAccountsWithTags,
    };
    const param = createModuleParams(mockAccountsConfig);

    await ManageAccountsTagsModule.execute(param);

    // Only the active account (Management) should be processed
    expect(awsLza.manageAccountTags).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
