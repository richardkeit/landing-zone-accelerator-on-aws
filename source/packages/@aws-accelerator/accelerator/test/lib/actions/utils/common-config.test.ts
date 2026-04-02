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
import type { IAssumeRoleCredential } from 'aws-lza';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractSecurityServiceMetadata,
  getCfnRetentionBucketName,
  getPrincipalOrgIdCondition,
  loadOrganizationDataSources,
} from '../../../../lib/actions/utils/common-config';
import type { ModuleParams } from '../../../../lib/types';

// Mock node:path
vi.mock('node:path', () => ({
  default: {
    parse: vi.fn(() => ({ name: 'common-config' })),
    basename: vi.fn(() => 'common-config.ts'),
  },
}));

// Mock aws-lza module
vi.mock('aws-lza', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  createStatusLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getParametersValue: vi.fn(),
  DynamoDBFilterOperator: {
    ATTRIBUTE_EXISTS: 'ATTRIBUTE_EXISTS',
  },
}));

// Mock module-state for calculateArrayHash
vi.mock('../../../../lib/actions/utils/module-state', () => ({
  calculateArrayHash: vi.fn((arr: string[]) => `hash-of-${arr.join('-')}`),
}));

describe('common-config utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CONFIG_COMMIT_ID'];
  });

  describe('extractSecurityServiceMetadata', () => {
    it('should extract security service metadata with correct counts and hashes', () => {
      const mockParams = {
        moduleRunnerParameters: {
          configs: {
            accountsConfig: {
              getAccountIds: vi.fn(() => ['111111111111', '222222222222', '333333333333']),
              getAuditAccountId: vi.fn(() => '444444444444'),
            },
            globalConfig: {
              enabledRegions: ['us-east-1', 'us-west-2', 'eu-west-1'],
            },
          },
        },
      } as unknown as ModuleParams;

      const result = extractSecurityServiceMetadata(mockParams);

      expect(result).toEqual({
        accountsCount: 3,
        accountsHash: 'hash-of-111111111111-222222222222-333333333333',
        enabledRegionsCount: 3,
        enabledRegionsHash: 'hash-of-us-east-1-us-west-2-eu-west-1',
        delegatedAdminAccountId: '444444444444',
      });
    });

    it('should handle empty accounts and regions', () => {
      const mockParams = {
        moduleRunnerParameters: {
          configs: {
            accountsConfig: {
              getAccountIds: vi.fn(() => []),
              getAuditAccountId: vi.fn(() => '444444444444'),
            },
            globalConfig: {
              enabledRegions: [],
            },
          },
        },
      } as unknown as ModuleParams;

      const result = extractSecurityServiceMetadata(mockParams);

      expect(result).toEqual({
        accountsCount: 0,
        accountsHash: 'hash-of-',
        enabledRegionsCount: 0,
        enabledRegionsHash: 'hash-of-',
        delegatedAdminAccountId: '444444444444',
      });
    });
  });

  describe('getPrincipalOrgIdCondition', () => {
    it('should return aws:PrincipalOrgID for standard AWS partition with Organizations enabled', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: true,
            },
          },
          organizationDetails: {
            Id: 'o-1234567890',
          },
        },
      } as unknown as ModuleParams;

      const result = getPrincipalOrgIdCondition(mockParams);

      expect(result).toEqual({
        'aws:PrincipalOrgID': 'o-1234567890',
      });
    });

    it('should return aws:PrincipalAccount for China partition', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws-cn',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: true,
            },
          },
          organizationAccounts: [{ Id: '111111111111' }, { Id: '222222222222' }, { Id: '333333333333' }],
        },
      } as unknown as ModuleParams;

      const result = getPrincipalOrgIdCondition(mockParams);

      expect(result).toEqual({
        'aws:PrincipalAccount': ['111111111111', '222222222222', '333333333333'],
      });
    });

    it('should return aws:PrincipalAccount for China partition with Organizations disabled', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws-cn',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: false,
            },
          },
          organizationAccounts: [{ Id: '111111111111' }, { Id: '222222222222' }],
        },
      } as unknown as ModuleParams;

      const result = getPrincipalOrgIdCondition(mockParams);

      expect(result).toEqual({
        'aws:PrincipalAccount': ['111111111111', '222222222222'],
      });
    });

    it('should return aws:PrincipalAccount when Organizations is disabled', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: false,
            },
          },
          organizationAccounts: [{ Id: '111111111111' }, { Id: '222222222222' }],
        },
      } as unknown as ModuleParams;

      const result = getPrincipalOrgIdCondition(mockParams);

      expect(result).toEqual({
        'aws:PrincipalAccount': ['111111111111', '222222222222'],
      });
    });

    it('should filter out undefined account IDs', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: false,
            },
          },
          organizationAccounts: [{ Id: '111111111111' }, { Id: undefined }, { Id: '222222222222' }],
        },
      } as unknown as ModuleParams;

      const result = getPrincipalOrgIdCondition(mockParams);

      expect(result).toEqual({
        'aws:PrincipalAccount': ['111111111111', '222222222222'],
      });
    });

    it('should throw error when organization is enabled but organization ID is not found', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: true,
            },
          },
          organizationDetails: {
            Id: undefined,
          },
        },
      } as unknown as ModuleParams;

      expect(() => getPrincipalOrgIdCondition(mockParams)).toThrow(
        'Organization ID not found but organization is enabled',
      );
    });

    it('should throw error when organization is disabled but account IDs are not found', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            partition: 'aws',
          },
        },
        moduleRunnerParameters: {
          configs: {
            organizationConfig: {
              enable: false,
            },
          },
          organizationAccounts: [],
        },
      } as unknown as ModuleParams;

      expect(() => getPrincipalOrgIdCondition(mockParams)).toThrow(
        'Account IDs not found but required for non-organization deployment',
      );
    });
  });

  describe('getCfnRetentionBucketName', () => {
    it('should return correct CDK bootstrap bucket name', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            invokingAccountId: '123456789012',
            globalRegion: 'us-east-1',
          },
        },
      } as unknown as ModuleParams;

      const result = getCfnRetentionBucketName(mockParams);

      expect(result).toBe('cdk-accel-assets-123456789012-us-east-1');
    });

    it('should handle different account IDs and regions', () => {
      const mockParams = {
        runnerParameters: {
          sessionContext: {
            invokingAccountId: 'XXXXXXXXXXXX',
            globalRegion: 'eu-central-1',
          },
        },
      } as unknown as ModuleParams;

      const result = getCfnRetentionBucketName(mockParams);

      expect(result).toBe('cdk-accel-assets-XXXXXXXXXXXX-eu-central-1');
    });
  });

  describe('getOrganizationSourceTableName', () => {
    it('should return table name from SSM parameter', async () => {
      const { getParametersValue } = await import('aws-lza');
      const { getOrganizationSourceTableName: getTableName } = await import(
        '../../../../lib/actions/utils/common-config'
      );

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Value: 'AWSAccelerator-ConfigTable-123456789012-us-east-1' },
      ]);

      const result = await getTableName('/accelerator', 'us-east-1', 'test-prefix');

      expect(result).toBe('AWSAccelerator-ConfigTable-123456789012-us-east-1');
      expect(getParametersValue).toHaveBeenCalledWith(
        ['/accelerator/prepare-stack/configTable/name'],
        'us-east-1',
        'test-prefix',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass solutionId and credentials when provided', async () => {
      const { getParametersValue } = await import('aws-lza');
      const { getOrganizationSourceTableName: getTableName } = await import(
        '../../../../lib/actions/utils/common-config'
      );

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Value: 'AWSAccelerator-ConfigTable-123456789012-us-east-1' },
      ]);

      const mockCredentials: IAssumeRoleCredential = {
        accessKeyId: 'AKIA...',
        secretAccessKey: '...',
        sessionToken: '...',
      };

      const result = await getTableName('/accelerator', 'us-east-1', 'test-prefix', 'solution-id', mockCredentials);

      expect(result).toBe('AWSAccelerator-ConfigTable-123456789012-us-east-1');
      expect(getParametersValue).toHaveBeenCalledWith(
        ['/accelerator/prepare-stack/configTable/name'],
        'us-east-1',
        'test-prefix',
        undefined,
        'solution-id',
        mockCredentials,
      );
    });

    it('should throw error when parameter is not found', async () => {
      const { getParametersValue } = await import('aws-lza');
      const { getOrganizationSourceTableName: getTableName } = await import(
        '../../../../lib/actions/utils/common-config'
      );

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(getTableName('/accelerator', 'us-east-1', 'test-prefix')).rejects.toThrow(
        'Parameter not found: /accelerator/prepare-stack/configTable/name',
      );
    });

    it('should throw error when parameter value is undefined', async () => {
      const { getParametersValue } = await import('aws-lza');
      const { getOrganizationSourceTableName: getTableName } = await import(
        '../../../../lib/actions/utils/common-config'
      );

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([{ Value: undefined }]);

      await expect(getTableName('/accelerator', 'us-east-1', 'test-prefix')).rejects.toThrow(
        'Parameter value not found: /accelerator/prepare-stack/configTable/name',
      );
    });
  });

  describe('loadOrganizationDataSources', () => {
    it('should return undefined when DynamoDB loading is disabled', async () => {
      const mockParams = {
        runnerParameters: {
          loadOrganizationsFromDynamoDbTable: false,
        },
      } as unknown as ModuleParams;

      const result = await loadOrganizationDataSources(mockParams, 'test-prefix');

      expect(result).toBeUndefined();
    });

    it('should load organization data sources from DynamoDB when enabled', async () => {
      const { getParametersValue } = await import('aws-lza');

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Value: 'AWSAccelerator-ConfigTable-123456789012-us-east-1' },
      ]);

      process.env['CONFIG_COMMIT_ID'] = 'abc123def456';

      const mockParams = {
        runnerParameters: {
          loadOrganizationsFromDynamoDbTable: true,
          sessionContext: {
            region: 'us-east-1',
          },
        },
        moduleRunnerParameters: {
          resourcePrefixes: {
            ssmParamName: '/accelerator',
          },
        },
      } as unknown as ModuleParams;

      const result = await loadOrganizationDataSources(mockParams, 'test-prefix');

      expect(result).toEqual({
        organizations: {
          tableName: 'AWSAccelerator-ConfigTable-123456789012-us-east-1',
          filters: [
            {
              name: 'commitId',
              value: 'abc123def456',
            },
            {
              name: 'awsKey',
              operator: 'ATTRIBUTE_EXISTS',
            },
          ],
        },
      });

      expect(getParametersValue).toHaveBeenCalledWith(
        ['/accelerator/prepare-stack/configTable/name'],
        'us-east-1',
        'test-prefix',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should use empty string for commitId when CONFIG_COMMIT_ID is not set', async () => {
      const { getParametersValue } = await import('aws-lza');

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Value: 'AWSAccelerator-ConfigTable-123456789012-us-east-1' },
      ]);

      const mockParams = {
        runnerParameters: {
          loadOrganizationsFromDynamoDbTable: true,
          sessionContext: {
            region: 'us-east-1',
          },
        },
        moduleRunnerParameters: {
          resourcePrefixes: {
            ssmParamName: '/accelerator',
          },
        },
      } as unknown as ModuleParams;

      const result = await loadOrganizationDataSources(mockParams, 'test-prefix');

      expect(result?.organizations.filters[0]).toEqual({
        name: 'commitId',
        value: '',
      });
    });

    it('should throw error when SSM parameter is not found', async () => {
      const { getParametersValue } = await import('aws-lza');

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const mockParams = {
        runnerParameters: {
          loadOrganizationsFromDynamoDbTable: true,
          sessionContext: {
            region: 'us-east-1',
          },
        },
        moduleRunnerParameters: {
          resourcePrefixes: {
            ssmParamName: '/accelerator',
          },
        },
      } as unknown as ModuleParams;

      await expect(loadOrganizationDataSources(mockParams, 'test-prefix')).rejects.toThrow(
        'Parameter not found: /accelerator/prepare-stack/configTable/name',
      );
    });

    it('should throw error when SSM parameter has no value', async () => {
      const { getParametersValue } = await import('aws-lza');

      (getParametersValue as ReturnType<typeof vi.fn>).mockResolvedValue([{ Value: undefined }]);

      const mockParams = {
        runnerParameters: {
          loadOrganizationsFromDynamoDbTable: true,
          sessionContext: {
            region: 'us-east-1',
          },
        },
        moduleRunnerParameters: {
          resourcePrefixes: {
            ssmParamName: '/accelerator',
          },
        },
      } as unknown as ModuleParams;

      await expect(loadOrganizationDataSources(mockParams, 'test-prefix')).rejects.toThrow(
        'Parameter value not found: /accelerator/prepare-stack/configTable/name',
      );
    });
  });
});
