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

/* eslint @typescript-eslint/no-explicit-any: 0 */

import {
  AuditManagerConfig,
  CentralSecurityServicesConfig,
  DetectiveConfig,
  EbsDefaultVolumeEncryptionConfig,
  GlobalConfig,
  GuardDutyConfig,
  LoggingConfig,
  MacieConfig,
  OrganizationConfig,
  S3PublicAccessBlockConfig,
  ScpRevertChangesConfig,
  SecurityConfig,
  SecurityHubConfig,
  SsmAutomationConfig,
  SsmSettingsConfig,
} from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { KeyStack } from '../../lib/stacks/key-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

const AUDIT_ACCOUNT_ID = '456789012';
const NON_AUDIT_ACCOUNT_ID = '111111111111';
const HOME_REGION = 'us-east-1';
const OTHER_REGION = 'us-west-2';

function buildSecurityConfig(overrides?: {
  macieEnable?: boolean;
  guardDutyEnable?: boolean;
  auditManagerEnable?: boolean;
}): SecurityConfig {
  const macie = new MacieConfig();
  if (overrides?.macieEnable !== undefined) {
    (macie as any).enable = overrides.macieEnable;
  }

  const guardduty = new GuardDutyConfig();
  if (overrides?.guardDutyEnable !== undefined) {
    (guardduty as any).enable = overrides.guardDutyEnable;
  }

  const auditManager = new AuditManagerConfig();
  if (overrides?.auditManagerEnable !== undefined) {
    (auditManager as any).enable = overrides.auditManagerEnable;
  }

  const centralSecurityServices: CentralSecurityServicesConfig = {
    delegatedAdminAccount: 'Audit',
    auditManager,
    detective: new DetectiveConfig(),
    macie,
    guardduty,
    securityHub: new SecurityHubConfig(),
    ebsDefaultVolumeEncryption: new EbsDefaultVolumeEncryptionConfig(),
    s3PublicAccessBlock: new S3PublicAccessBlockConfig(),
    scpRevertChangesConfig: new ScpRevertChangesConfig(),
    snsSubscriptions: [],
    ssmAutomation: new SsmAutomationConfig(),
    ssmSettings: new SsmSettingsConfig(),
  };

  return {
    centralSecurityServices,
    accessAnalyzer: { enable: false },
    awsConfig: { aggregation: { enable: false, delegatedAdminAccount: undefined } },
    getDelegatedAccountName: vi.fn(() => 'Audit'),
  } as unknown as SecurityConfig;
}

function buildKeyStackProps(opts: {
  auditAccount?: boolean;
  region?: string;
  orgEnabled?: boolean;
  partition?: string;
  security?: Parameters<typeof buildSecurityConfig>[0];
  homeRegion?: string;
}): AcceleratorStackProps {
  const props = createAcceleratorStackProps();
  const account = opts.auditAccount ? AUDIT_ACCOUNT_ID : NON_AUDIT_ACCOUNT_ID;
  const region = opts.region ?? HOME_REGION;

  const overrideProps: Partial<AcceleratorStackProps> = {
    env: { account, region },
    partition: opts.partition ?? 'aws',
    securityConfig: buildSecurityConfig(opts.security),
    globalConfig: {
      ...props.globalConfig,
      homeRegion: opts.homeRegion ?? HOME_REGION,
      logging: {
        cloudwatchLogs: {
          enable: false,
        },
        sessionManager: {
          sendToCloudWatchLogs: false,
          sendToS3: false,
        },
        cloudtrail: {
          enable: false,
        },
      } as LoggingConfig,
    } as GlobalConfig,
    organizationConfig: {
      ...props.organizationConfig,
      enable: opts.orgEnabled ?? true,
    } as OrganizationConfig,
  };

  return { ...props, ...overrideProps } as AcceleratorStackProps;
}

let app: cdk.App;

beforeEach(() => {
  app = new cdk.App();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('KeyStack - account gating', () => {
  test('does not create KMS key in non-audit account', () => {
    const props = buildKeyStackProps({ auditAccount: false });
    const stack = new KeyStack(app, 'test-key-stack-non-audit', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 0);
    template.resourceCountIs('AWS::KMS::Alias', 0);
  });

  test('does not create cross-account role in non-audit account', () => {
    const props = buildKeyStackProps({ auditAccount: false });
    const stack = new KeyStack(app, 'test-key-stack-non-audit-role', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 0);
  });

  test('creates exactly one KMS key in audit account', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-audit', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  test('creates exactly one KMS alias in audit account', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-audit-alias', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Alias', 1);
  });
});

describe('KeyStack - KMS key properties', () => {
  test('enables key rotation', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-rotation', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::KMS::Key',
      Match.objectLike({
        EnableKeyRotation: true,
      }),
    );
  });

  test('key resource uses a Retain-based removal policy', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-removal', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    // Depending on the CDK version, RETAIN_ON_UPDATE_OR_DELETE renders as either
    // `Retain` or `RetainExceptOnCreate`. Either way, the intent is that the key
    // is never deleted or replaced silently on stack updates.
    expect(['Retain', 'RetainExceptOnCreate']).toContain(key.UpdateReplacePolicy);
    expect(['Retain', 'RetainExceptOnCreate']).toContain(key.DeletionPolicy);
  });
});

describe('KeyStack - organization policy gating', () => {
  test('includes accelerator role policy statement when organization enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: true });
    const stack = new KeyStack(app, 'test-key-stack-org-enabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const orgStatement = statements.find((s: any) => s.Sid === 'Allow Accelerator Role to use the encryption key');
    expect(orgStatement).toBeDefined();
    expect(orgStatement.Condition.StringEquals['aws:PrincipalOrgID']).toBe('o-1234567890');
  });

  test('does not include accelerator role policy statement when organization disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: false });
    const stack = new KeyStack(app, 'test-key-stack-org-disabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const orgStatement = statements.find((s: any) => s.Sid === 'Allow Accelerator Role to use the encryption key');
    expect(orgStatement).toBeUndefined();
  });
});

describe('KeyStack - CloudWatch Logs policy', () => {
  test('always allows CloudWatch Logs service access', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-cwlogs', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const cwStatement = statements.find((s: any) => s.Sid === 'Allow Cloudwatch logs to use the encryption key');
    expect(cwStatement).toBeDefined();
    expect(cwStatement.Principal.Service).toContain(`logs.${HOME_REGION}.amazonaws.com`);
  });

  test('uses the stack region in CloudWatch Logs principal', () => {
    const props = buildKeyStackProps({ auditAccount: true, region: OTHER_REGION, homeRegion: OTHER_REGION });
    const stack = new KeyStack(app, 'test-key-stack-cwlogs-region', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const cwStatement = statements.find((s: any) => s.Sid === 'Allow Cloudwatch logs to use the encryption key');
    expect(cwStatement.Principal.Service).toContain(`logs.${OTHER_REGION}.amazonaws.com`);
  });
});

describe('KeyStack - service principal policies (default)', () => {
  test('includes SNS service principal by default', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-sns-default', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const snsStatement = statements.find((s: any) => s.Sid === 'Allow Sns service to use the encryption key');
    expect(snsStatement).toBeDefined();
  });

  test('includes Lambda service principal by default', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-lambda-default', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const lambdaStatement = statements.find((s: any) => s.Sid === 'Allow Lambda service to use the encryption key');
    expect(lambdaStatement).toBeDefined();
  });

  test('includes CloudWatch service principal by default', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-cw-default', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const cwStatement = statements.find((s: any) => s.Sid === 'Allow Cloudwatch service to use the encryption key');
    expect(cwStatement).toBeDefined();
  });

  test('includes SQS service principal by default', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-sqs-default', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const sqsStatement = statements.find((s: any) => s.Sid === 'Allow Sqs service to use the encryption key');
    expect(sqsStatement).toBeDefined();
  });
});

describe('KeyStack - optional security service principals', () => {
  test('does not include Macie principal when Macie is disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { macieEnable: false } });
    const stack = new KeyStack(app, 'test-key-stack-macie-disabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const macieStatement = statements.find((s: any) => s.Sid === 'Allow Macie service to use the encryption key');
    expect(macieStatement).toBeUndefined();
  });

  test('includes Macie principal when Macie is enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { macieEnable: true } });
    const stack = new KeyStack(app, 'test-key-stack-macie-enabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const macieStatement = statements.find((s: any) => s.Sid === 'Allow Macie service to use the encryption key');
    expect(macieStatement).toBeDefined();
    expect(macieStatement.Principal.Service).toBe('macie.amazonaws.com');
  });

  test('does not include GuardDuty principal when GuardDuty is disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { guardDutyEnable: false } });
    const stack = new KeyStack(app, 'test-key-stack-gd-disabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const gdStatement = statements.find((s: any) => s.Sid === 'Allow Guardduty service to use the encryption key');
    expect(gdStatement).toBeUndefined();
  });

  test('includes GuardDuty principal when GuardDuty is enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { guardDutyEnable: true } });
    const stack = new KeyStack(app, 'test-key-stack-gd-enabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const gdStatement = statements.find((s: any) => s.Sid === 'Allow Guardduty service to use the encryption key');
    expect(gdStatement).toBeDefined();
    expect(gdStatement.Principal.Service).toBe('guardduty.amazonaws.com');
  });

  test('does not include AuditManager principal when AuditManager is disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { auditManagerEnable: false } });
    const stack = new KeyStack(app, 'test-key-stack-am-disabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const amStatement = statements.find((s: any) => s.Sid === 'Allow AuditManager service to use the encryption key');
    expect(amStatement).toBeUndefined();
  });

  test('includes AuditManager principal when AuditManager is enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { auditManagerEnable: true } });
    const stack = new KeyStack(app, 'test-key-stack-am-enabled', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const amStatement = statements.find((s: any) => s.Sid === 'Allow AuditManager service to use the encryption key');
    expect(amStatement).toBeDefined();
    expect(amStatement.Principal.Service).toBe('auditmanager.amazonaws.com');
  });

  test('adds AuditManager CreateGrant policy statement when AuditManager is enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { auditManagerEnable: true } });
    const stack = new KeyStack(app, 'test-key-stack-am-grant', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const grantStatement = statements.find(
      (s: any) => s.Sid === 'Allow Audit Manager service to provision encryption key grants',
    );
    expect(grantStatement).toBeDefined();
    expect(grantStatement.Action).toBe('kms:CreateGrant');
  });

  test('does not add AuditManager CreateGrant policy when AuditManager is disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, security: { auditManagerEnable: false } });
    const stack = new KeyStack(app, 'test-key-stack-am-no-grant', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const grantStatement = statements.find(
      (s: any) => s.Sid === 'Allow Audit Manager service to provision encryption key grants',
    );
    expect(grantStatement).toBeUndefined();
  });
});

describe('KeyStack - cross-account SSM parameter role', () => {
  test('creates cross-account role in home region + audit account', () => {
    const props = buildKeyStackProps({ auditAccount: true, region: HOME_REGION, homeRegion: HOME_REGION });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-home', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  test('does not create cross-account role when stack region != home region', () => {
    const props = buildKeyStackProps({ auditAccount: true, region: OTHER_REGION, homeRegion: HOME_REGION });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-other', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 0);
  });

  test('cross-account role has ssm:GetParameters permissions', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-perms', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::IAM::Role',
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith(['ssm:GetParameters', 'ssm:GetParameter']),
                }),
              ]),
              Version: '2012-10-17',
            },
          }),
        ]),
      }),
    );
  });

  test('cross-account role has ssm:DescribeParameters permissions on wildcard resource', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-describe', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const role = Object.values(roles)[0] as any;
    const statements = role.Properties.Policies[0].PolicyDocument.Statement as any[];
    const describeStatement = statements.find((s: any) =>
      Array.isArray(s.Action) ? s.Action.includes('ssm:DescribeParameters') : s.Action === 'ssm:DescribeParameters',
    );
    expect(describeStatement).toBeDefined();
    expect(describeStatement.Resource).toBe('*');
  });

  test('cross-account role uses PrincipalOrgID condition when organization enabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: true });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-org', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const role = Object.values(roles)[0] as any;
    const statements = role.Properties.Policies[0].PolicyDocument.Statement as any[];
    const principalOrgConditionUsed = statements.some(
      (s: any) => s.Condition?.StringEquals?.['aws:PrincipalOrgID'] === 'o-1234567890',
    );
    expect(principalOrgConditionUsed).toBe(true);
  });

  test('cross-account role does not use PrincipalOrgID when organization disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: false });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-no-org', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const role = Object.values(roles)[0] as any;
    const statements = role.Properties.Policies[0].PolicyDocument.Statement as any[];
    const principalOrgConditionUsed = statements.some(
      (s: any) => s.Condition?.StringEquals?.['aws:PrincipalOrgID'] !== undefined,
    );
    expect(principalOrgConditionUsed).toBe(false);
  });

  test('cross-account role uses PrincipalAccount condition when organization disabled', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: false });
    const stack = new KeyStack(app, 'test-key-stack-xa-role-acct', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const role = Object.values(roles)[0] as any;
    const statements = role.Properties.Policies[0].PolicyDocument.Statement as any[];
    const acctConditionUsed = statements.some((s: any) =>
      Array.isArray(s.Condition?.StringEquals?.['aws:PrincipalAccount']),
    );
    expect(acctConditionUsed).toBe(true);
  });
});

describe('KeyStack - SSM parameter for key ARN', () => {
  test('creates SSM parameter for the accelerator CMK ARN', () => {
    const props = buildKeyStackProps({ auditAccount: true });
    const stack = new KeyStack(app, 'test-key-stack-ssm', props);
    const template = Template.fromStack(stack);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const cmkParam = Object.values(ssmParams).find(
      (p: any) => typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/kms/key-arn'),
    );
    expect(cmkParam).toBeDefined();
  });
});

describe('KeyStack - partition-based key policies', () => {
  test('accelerator role ARN condition references the partition pseudo-parameter', () => {
    const props = buildKeyStackProps({ auditAccount: true, orgEnabled: true, partition: 'aws' });
    const stack = new KeyStack(app, 'test-key-stack-aws-partition', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const acceleratorRoleStmt = statements.find(
      (s: any) => s.Sid === 'Allow Accelerator Role to use the encryption key',
    );
    // The ARN contains the `${AWS::Partition}` substitution, so it renders as
    // a Fn::Join/Fn::Sub structure. Assert that the serialized string mentions
    // the partition pseudo-parameter and the accelerator prefix.
    const serialized = JSON.stringify(acceleratorRoleStmt.Condition.ArnLike['aws:PrincipalARN']);
    expect(serialized).toContain('AWS::Partition');
    expect(serialized).toContain('unit-test-*');
  });
});
