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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CloudTrailConfig,
  ControlTowerConfig,
  GlobalConfig,
  LoggingConfig,
  SessionManagerConfig,
} from '../../lib/global-config';
import { INotificationConfig } from '../../lib/models/global-config';
import { AccountConfig, AccountsConfig } from '../../lib/accounts-config';
import { OrganizationConfig } from '../../lib/organization-config';
import { GlobalConfigValidator } from '../../validator/global-config-validator';
import { IamConfig, RoleSetConfig } from '../../lib/iam-config';
import {
  AwsConfig,
  CentralSecurityServicesConfig,
  CloudWatchConfig,
  KeyConfig,
  KeyManagementServiceConfig,
  S3PublicAccessBlockConfig,
  SecurityConfig,
} from '../../lib/security-config';
import { DeploymentTargets } from '../../lib/common';

const mockConfigDir = '/mock/config';

/**
 * Helper type for building partial mocks of config classes. Accepts a
 * `Partial<T>` so test fixtures only specify the fields they care about while
 * still getting compile-time feedback when the underlying config type changes.
 */
type Mock<T> = Partial<T>;

function mockAccountsConfig(overrides: Partial<AccountsConfig> = {}): AccountsConfig {
  const base: Mock<AccountsConfig> = {
    getAuditAccount: vi.fn().mockReturnValue({ name: 'Audit' }),
    getAccountIds: vi.fn().mockReturnValue(['123456789012']),
    mandatoryAccounts: [{ name: 'LogArchive' } as AccountConfig],
    workloadAccounts: [],
    ...overrides,
  };
  return base as unknown as AccountsConfig;
}

function mockOrganizationConfig(overrides: Partial<OrganizationConfig> = {}): OrganizationConfig {
  const base: Mock<OrganizationConfig> = {
    enable: true,
    organizationalUnits: [
      { name: 'Security', ignore: undefined },
      { name: 'Infrastructure', ignore: undefined },
    ],
    ...overrides,
  };
  return base as unknown as OrganizationConfig;
}

function mockIamConfig(overrides: Partial<IamConfig> = {}): IamConfig {
  const base: Mock<IamConfig> = {
    roleSets: [] as RoleSetConfig[],
    ...overrides,
  };
  return base as unknown as IamConfig;
}

function mockSecurityConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  const base: Mock<SecurityConfig> = {
    centralSecurityServices: {
      delegatedAdminAccount: 'Audit',
      ebsDefaultVolumeEncryption: { enable: true, kmsKey: 'key1', excludeRegions: [] },
      guardduty: { enable: true, excludeRegions: ['us-west-2'] },
      securityHub: { enable: true, regionAggregation: true },
      ssmAutomation: { documentSets: [] },
      s3PublicAccessBlock: new S3PublicAccessBlockConfig(),
    } as unknown as CentralSecurityServicesConfig,
    keyManagementService: {
      keySets: [{ name: 'key1', deploymentTargets: new DeploymentTargets() } as unknown as KeyConfig],
    } as KeyManagementServiceConfig,
    cloudWatch: { metricSets: [], alarmSets: [], logGroups: [] } as unknown as CloudWatchConfig,
    awsConfig: { enableConfigurationRecorder: true, ruleSets: [] } as unknown as AwsConfig,
    ...overrides,
  };
  return base as unknown as SecurityConfig;
}

function mockGlobalConfigWithBudget(
  notifications: Partial<INotificationConfig>[],
  overrides: Partial<GlobalConfig> = {},
): GlobalConfig {
  const base: Mock<GlobalConfig> = {
    controlTower: new ControlTowerConfig(),
    getSnsTopicNames: vi.fn().mockReturnValue([]),
    logging: {
      cloudtrail: {} as CloudTrailConfig,
      sessionManager: {} as SessionManagerConfig,
      account: 'LogArchive',
    } as LoggingConfig,
    reports: {
      budgets: [
        {
          name: 'test-budget',
          amount: 2000,
          timeUnit: 'MONTHLY',
          type: 'COST',
          unit: 'USD',
          includeUpfront: true,
          includeTax: true,
          includeSupport: true,
          includeOtherSubscription: true,
          includeSubscription: true,
          includeRecurring: true,
          includeDiscount: true,
          includeRefund: false,
          includeCredit: false,
          useAmortized: false,
          useBlended: false,
          notifications,
          deploymentTargets: new DeploymentTargets(),
        },
      ],
    } as unknown as GlobalConfig['reports'],
    ...overrides,
  };
  return base as unknown as GlobalConfig;
}

function createValidator(globalConfig: GlobalConfig) {
  return new GlobalConfigValidator(
    globalConfig,
    mockAccountsConfig(),
    mockIamConfig(),
    mockOrganizationConfig(),
    mockSecurityConfig(),
    mockConfigDir,
  );
}

describe('Budget Notification Validation', () => {
  beforeEach(() => {
    vi.spyOn(GlobalConfig.prototype, 'getSnsTopicNames').mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('EMAIL subscription type', () => {
    it('should pass validation with a valid email address in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          recipients: ['valid@example.com'],
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });

    it('should pass validation with multiple valid email addresses in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          recipients: ['user1@example.com', 'user2@example.com'],
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });

    it('should fail validation with an invalid email address in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          recipients: ['not-an-email'],
        },
      ]);

      expect(() => createValidator(config)).toThrow('Invalid report notification email not-an-email');
    });

    it('should fail validation with an invalid email in deprecated address field', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          address: 'not-an-email',
        },
      ]);

      expect(() => createValidator(config)).toThrow('Invalid report notification email not-an-email');
    });

    it('should pass validation with a valid email in deprecated address field', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          address: 'valid@example.com',
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });
  });

  describe('SNS subscription type', () => {
    it('should pass validation with a valid SNS topic ARN in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['arn:aws:sns:us-east-1:123456789012:my-topic'],
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });

    it('should pass validation with a valid SNS topic ARN in deprecated address field', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          address: 'arn:aws:sns:us-east-1:123456789012:my-topic',
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });

    it('should fail validation with a malformatted SNS topic ARN in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['not-an-arn'],
        },
      ]);

      expect(() => createValidator(config)).toThrow('SNS Topic Arn is malformatted');
    });

    it('should fail validation with a plain topic name in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['Security'],
        },
      ]);

      expect(() => createValidator(config)).toThrow('SNS Topic Arn is malformatted');
    });

    it('should fail validation with a malformatted SNS topic ARN in deprecated address field', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          address: 'Security',
        },
      ]);

      expect(() => createValidator(config)).toThrow('SNS Topic Arn is malformatted');
    });

    it('should fail validation with more than one SNS topic in recipients', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['arn:aws:sns:us-east-1:123456789012:topic-1', 'arn:aws:sns:us-east-1:123456789012:topic-2'],
        },
      ]);

      expect(() => createValidator(config)).toThrow('SNS subscription type can have only one SNS topic as a recipient');
    });

    it('should produce exactly one error for multiple SNS recipients, not one per recipient', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['arn:aws:sns:us-east-1:123456789012:topic-1', 'arn:aws:sns:us-east-1:123456789012:topic-2'],
        },
      ]);

      try {
        createValidator(config);
        expect.unreachable('Should have thrown');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const matches = message.match(/SNS subscription type can have only one SNS topic as a recipient/g);
        expect(matches).toHaveLength(1);
      }
    });

    it('should pass validation with a GovCloud SNS topic ARN', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['arn:aws-us-gov:sns:us-gov-west-1:123456789012:my-topic'],
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });

    it('should pass validation with a China region SNS topic ARN', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'SNS',
          recipients: ['arn:aws-cn:sns:cn-north-1:123456789012:my-topic'],
        },
      ]);

      expect(() => createValidator(config)).not.toThrow();
    });
  });

  describe('subscriber address validation', () => {
    it('should fail when both address and recipients are specified', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
          address: 'test@example.com',
          recipients: ['test@example.com'],
        },
      ]);

      expect(() => createValidator(config)).toThrow(
        'Cannot specify an address and a list of recipients for budget test-budget',
      );
    });

    it('should fail when neither address nor recipients are specified', () => {
      const config = mockGlobalConfigWithBudget([
        {
          type: 'ACTUAL',
          thresholdType: 'PERCENTAGE',
          threshold: 90,
          comparisonOperator: 'GREATER_THAN',
          subscriptionType: 'EMAIL',
        },
      ]);

      expect(() => createValidator(config)).toThrow(
        'Provide either an address or a list of recipients for budget test-budget',
      );
    });
  });
});
