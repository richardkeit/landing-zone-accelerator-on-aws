import { describe, test, expect, beforeEach } from 'vitest';
import { IamConfig } from '../../lib/iam-config';
import { AccountsConfig } from '../../lib/accounts-config';
import { NetworkConfig } from '../../lib/network-config';
import { OrganizationConfig } from '../../lib/organization-config';
import { SecurityConfig } from '../../lib/security-config';
import { IamConfigValidator } from '../../validator/iam-config-validator';

describe('IamConfigValidator', () => {
  let mockAccountsConfig: AccountsConfig;
  let mockNetworkConfig: NetworkConfig;
  let mockOrganizationConfig: OrganizationConfig;
  let mockSecurityConfig: SecurityConfig;
  let mockConfigDir: string;

  beforeEach(() => {
    mockAccountsConfig = {
      mandatoryAccounts: [{ name: 'Management', organizationalUnit: 'Root' }],
      workloadAccounts: [],
    } as unknown as AccountsConfig;

    mockNetworkConfig = { vpcs: [], vpcTemplates: [] } as unknown as NetworkConfig;
    mockOrganizationConfig = { organizationalUnits: [] } as unknown as OrganizationConfig;
    mockSecurityConfig = {} as unknown as SecurityConfig;
    mockConfigDir = '/mock/config';
  });

  const createValidatorWithConfig = (iamConfig: Partial<IamConfig>) => {
    const fullConfig = {
      providers: [],
      roleSets: [],
      groupSets: [],
      userSets: [],
      managedActiveDirectories: [],
      ...iamConfig,
    } as IamConfig;

    return new IamConfigValidator(
      fullConfig,
      mockAccountsConfig,
      mockNetworkConfig,
      mockOrganizationConfig,
      mockSecurityConfig,
      mockConfigDir,
    );
  };

  describe('validateIdentityCenterPermissionSetPolicies - Policy Name Length', () => {
    test('accepts policy names with 32 characters or less', () => {
      const shortName = 'ShortName'; // 9 characters
      const exactlyThirtyTwo = 'A'.repeat(32); // exactly 32 characters

      const iamConfig = {
        policySets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedRegions: [],
              excludedAccounts: [],
            },
            identityCenterDependency: false,
            name: shortName,
            policies: [{ name: shortName, policy: 'policy.json' }],
          },
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedRegions: [],
              excludedAccounts: [],
            },
            identityCenterDependency: false,
            name: exactlyThirtyTwo,
            policies: [{ name: exactlyThirtyTwo, policy: 'policy.json' }],
          },
        ],
        identityCenter: {
          name: 'TestIdentityCenter',
          delegatedAdminAccount: 'Management',
          identityCenterPermissionSets: [
            {
              name: shortName,
              policies: undefined,
              sessionDuration: undefined,
              description: undefined,
            },
            {
              name: exactlyThirtyTwo,
              policies: undefined,
              sessionDuration: undefined,
              description: undefined,
            },
          ],
          identityCenterAssignments: [],
        },
      };
      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateIdentityCenterPermissionSetName']();
      expect(errors).toHaveLength(0);
    });

    test('rejects policy names longer than 32 characters', () => {
      const tooLongName = 'A'.repeat(33); // 33 characters - should fail

      const iamConfig = {
        policySets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedRegions: [],
              excludedAccounts: [],
            },
            name: tooLongName,
            identityCenterDependency: false,
            policies: [{ name: tooLongName, policy: 'policy.json' }],
          },
        ],
        identityCenter: {
          name: 'TestIdentityCenter',
          delegatedAdminAccount: 'Management',
          identityCenterPermissionSets: [
            {
              name: tooLongName,
              policies: undefined,
              sessionDuration: undefined,
              description: undefined,
            },
          ],
          identityCenterAssignments: [],
        },
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateIdentityCenterPermissionSetName']();
      expect(errors).toHaveLength(1);
    });

    test('handles empty policy sets gracefully', () => {
      const iamConfig = {
        policySets: [],
        identityCenter: {
          name: 'TestIdentityCenter',
          delegatedAdminAccount: 'Management',
          identityCenterPermissionSets: [],
          identityCenterAssignments: [],
        },
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateIdentityCenterPermissionSetName']();
      expect(errors).toHaveLength(0);
    });

    test('handles missing identity center gracefully', () => {
      const iamConfig = {
        policySets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedRegions: [],
              excludedAccounts: [],
            },
            identityCenterDependency: false,
            policies: [{ name: 'ValidName', policy: 'policy.json' }],
          },
        ],
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateIdentityCenterPermissionSetName']();
      expect(errors).toHaveLength(0);
    });
  });

  describe('validateAssumedByConditionsForIamRoles', () => {
    test('returns an error when duplicate operator+key condition entries exist for a single assumedBy principal', () => {
      const iamConfig = {
        roleSets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedAccounts: [],
              excludedRegions: [],
            },
            roles: [
              {
                name: 'TestRole-DuplicateConditions',
                assumedBy: [
                  {
                    type: 'account',
                    principal: '111111111111',
                    conditions: [
                      { type: 'StringEquals', key: 'sts:ExternalId', values: ['id-1'] },
                      { type: 'StringEquals', key: 'sts:ExternalId', values: ['id-2'] }, // duplicate type+key
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateAssumedByConditionsForIamRoles']();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Duplicate AssumedBy condition');
    });

    test('returns an error when a condition has an empty values array', () => {
      const iamConfig = {
        roleSets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedAccounts: [],
              excludedRegions: [],
            },
            roles: [
              {
                name: 'TestRole-EmptyValues',
                assumedBy: [
                  {
                    type: 'account',
                    principal: '111111111111',
                    conditions: [{ type: 'StringEquals', key: 'aws:PrincipalArn', values: [] }], // invalid
                  },
                ],
              },
            ],
          },
        ],
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateAssumedByConditionsForIamRoles']();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('must include at least one value');
    });

    test('returns an error when sts:ExternalId is used for a non-account/non-principalArn assumedBy type', () => {
      const iamConfig = {
        roleSets: [
          {
            deploymentTargets: {
              accounts: ['Management'],
              organizationalUnits: [],
              excludedAccounts: [],
              excludedRegions: [],
            },
            roles: [
              {
                name: 'TestRole-ExternalIdWrongType',
                assumedBy: [
                  {
                    type: 'service',
                    principal: 'ec2.amazonaws.com',
                    conditions: [{ type: 'StringEquals', key: 'sts:ExternalId', values: ['ext-123'] }], // invalid for service principal
                  },
                ],
              },
            ],
          },
        ],
      };

      const validator = createValidatorWithConfig(iamConfig);
      const errors = validator['validateAssumedByConditionsForIamRoles']();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('sts:ExternalId');
      expect(errors[0]).toContain('only supported');
    });
  });
});
