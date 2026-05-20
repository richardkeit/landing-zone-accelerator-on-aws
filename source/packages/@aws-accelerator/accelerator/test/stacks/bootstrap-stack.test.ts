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

import { AccountsConfig, GlobalConfig } from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { BootstrapStack } from '../../lib/stacks/bootstrap-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

const MANAGEMENT_ACCOUNT_ID = '234567890';
const WORKLOAD_ACCOUNT_ID = '111111111111';
const HOME_REGION = 'us-east-1';
const OTHER_REGION = 'us-west-2';

function buildBootstrapProps(opts?: {
  account?: string;
  region?: string;
  homeRegion?: string;
  useExistingRoles?: boolean;
  centralizeBuckets?: boolean;
  orgEnabled?: boolean;
  customDeploymentRole?: string;
  partition?: string;
}): AcceleratorStackProps {
  const base = createAcceleratorStackProps();
  const account = opts?.account ?? MANAGEMENT_ACCOUNT_ID;
  const region = opts?.region ?? HOME_REGION;
  const homeRegion = opts?.homeRegion ?? HOME_REGION;
  const centralizeBuckets = opts?.centralizeBuckets ?? true;

  const globalConfig = {
    ...base.globalConfig,
    homeRegion,
    managementAccountAccessRole: 'AWSControlTowerExecution',
    cdkOptions: {
      centralizeBuckets,
      useManagementAccessRole: true,
      customDeploymentRole: opts?.customDeploymentRole,
      forceBootstrap: undefined,
    },
  } as unknown as GlobalConfig;

  const accountsConfig = {
    ...base.accountsConfig,
    accountIds: [
      { email: 'management@example.com', accountId: MANAGEMENT_ACCOUNT_ID },
      { email: 'log@example.com', accountId: '345678901' },
      { email: 'audit@example.com', accountId: '456789012' },
      { email: 'workload@example.com', accountId: WORKLOAD_ACCOUNT_ID },
    ],
  } as unknown as AccountsConfig;

  return {
    ...base,
    env: { account, region },
    partition: opts?.partition ?? 'aws',
    globalConfig,
    accountsConfig,
    useExistingRoles: opts?.useExistingRoles ?? false,
    organizationConfig: {
      ...base.organizationConfig,
      enable: opts?.orgEnabled ?? true,
    } as any,
  } as AcceleratorStackProps;
}

let app: cdk.App;

beforeEach(() => {
  app = new cdk.App();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BootstrapStack - useExistingRoles short-circuit', () => {
  test('creates no IAM roles when useExistingRoles is true', () => {
    const props = buildBootstrapProps({ useExistingRoles: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-existing-roles', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 0);
  });

  test('creates no S3 buckets when useExistingRoles is true', () => {
    const props = buildBootstrapProps({ useExistingRoles: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-existing-roles-no-bucket', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('creates no KMS keys when useExistingRoles is true', () => {
    const props = buildBootstrapProps({ useExistingRoles: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-existing-roles-no-key', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 0);
  });
});

describe('BootstrapStack - custom deployment role', () => {
  test('creates CustomDeploymentRole in the home region', () => {
    const props = buildBootstrapProps({ region: HOME_REGION });
    const stack = new BootstrapStack(app, 'test-bootstrap-custom-role-home', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const roleNames = Object.values(roles).map((r: any) => r.Properties?.RoleName);
    const customDeploymentRoleExists = roleNames.some(
      (name: any) => typeof name === 'string' && name.endsWith('-Deployment-Role'),
    );
    expect(customDeploymentRoleExists).toBe(true);
  });

  test('does not create CustomDeploymentRole resource outside the home region', () => {
    const props = buildBootstrapProps({ region: OTHER_REGION, homeRegion: HOME_REGION });
    const stack = new BootstrapStack(app, 'test-bootstrap-custom-role-other', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const roleNames = Object.values(roles).map((r: any) => r.Properties?.RoleName);
    const customDeploymentRoleExists = roleNames.some(
      (name: any) => typeof name === 'string' && name.endsWith('-Deployment-Role'),
    );
    expect(customDeploymentRoleExists).toBe(false);
  });

  test('uses the configured custom deployment role name when provided', () => {
    const props = buildBootstrapProps({ customDeploymentRole: 'MyCustomDeploymentRole' });
    const stack = new BootstrapStack(app, 'test-bootstrap-custom-role-name', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const roleNames = Object.values(roles).map((r: any) => r.Properties?.RoleName);
    expect(roleNames).toContain('MyCustomDeploymentRole');
  });

  test('attaches AdministratorAccess managed policy to the deployment role', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-admin-policy', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const hasAdmin = Object.values(roles).some((r: any) => {
      const managed = r.Properties?.ManagedPolicyArns ?? [];
      const serialized = JSON.stringify(managed);
      return serialized.includes('AdministratorAccess');
    });
    expect(hasAdmin).toBe(true);
  });
});

describe('BootstrapStack - management deployment role', () => {
  test('creates ManagementDeploymentRole only in the management account', () => {
    const props = buildBootstrapProps({ account: MANAGEMENT_ACCOUNT_ID });
    const stack = new BootstrapStack(app, 'test-bootstrap-mgmt-role', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const mgmtRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName === 'unit-test-Management-Deployment-Role',
    );
    expect(mgmtRoleExists).toBe(true);
  });

  test('does not create ManagementDeploymentRole in a workload account', () => {
    const props = buildBootstrapProps({ account: WORKLOAD_ACCOUNT_ID });
    const stack = new BootstrapStack(app, 'test-bootstrap-mgmt-role-workload', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const mgmtRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName === 'unit-test-Management-Deployment-Role',
    );
    expect(mgmtRoleExists).toBe(false);
  });

  test('emits ManagementDeploymentRoleArn output in the management account home region', () => {
    const props = buildBootstrapProps({ account: MANAGEMENT_ACCOUNT_ID, region: HOME_REGION });
    const stack = new BootstrapStack(app, 'test-bootstrap-mgmt-output', props);
    const template = Template.fromStack(stack);

    template.hasOutput('ManagementDeploymentRoleArn', Match.anyValue());
  });
});

describe('BootstrapStack - CDK bootstrap qualifier and outputs', () => {
  test('uses default qualifier "accel" when none is provided', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-default-qualifier', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({ Name: '/cdk-bootstrap/accel/version' }));
  });

  test('uses the provided qualifier when passed to constructor', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-custom-qualifier', props, 'custom');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({ Name: '/cdk-bootstrap/custom/version' }));
  });

  test('creates expected CloudFormation outputs', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-outputs', props);
    const template = Template.fromStack(stack);

    template.hasOutput('BootstrapVersionOutput', Match.anyValue());
    template.hasOutput('BucketNameOutput', Match.anyValue());
    template.hasOutput('BucketDomainNameOutput', Match.anyValue());
    template.hasOutput('FileAssetKeyArnOutput', Match.anyValue());
  });

  test('emits FileAssetKeyArnOutput with ExportName based on qualifier', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-export', props, 'myqual');
    const template = Template.fromStack(stack);

    template.hasOutput(
      'FileAssetKeyArnOutput',
      Match.objectLike({ Export: { Name: 'CdkBootstrap-myqual-FileAssetKeyArn' } }),
    );
  });
});

describe('BootstrapStack - required CFN parameters', () => {
  test.each([
    'CloudFormationExecutionPolicies',
    'ContainerAssetsRepositoryName',
    'FileAssetsBucketKmsKeyId',
    'FileAssetsBucketName',
    'PublicAccessBlockConfiguration',
    'Qualifier',
    'TrustedAccountsForLookup',
    'TrustedAccounts',
  ])('declares required CfnParameter: %s', parameterName => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, `test-bootstrap-param-${parameterName}`, props);
    const template = Template.fromStack(stack);

    expect(template.toJSON()['Parameters']).toHaveProperty(parameterName);
  });

  test('TrustedAccounts parameter is CommaDelimitedList', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-trusted-list', props);
    const template = Template.fromStack(stack);

    expect(template.toJSON()['Parameters'].TrustedAccounts.Type).toBe('CommaDelimitedList');
  });
});

describe('BootstrapStack - centralizeBuckets behavior', () => {
  test('creates bucket in management account when centralizeBuckets is true', () => {
    const props = buildBootstrapProps({ account: MANAGEMENT_ACCOUNT_ID, centralizeBuckets: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-bucket-mgmt', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('does not create bucket in workload account when centralizeBuckets is true', () => {
    const props = buildBootstrapProps({ account: WORKLOAD_ACCOUNT_ID, centralizeBuckets: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-bucket-workload-centralized', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('creates bucket in workload account when centralizeBuckets is false', () => {
    const props = buildBootstrapProps({ account: WORKLOAD_ACCOUNT_ID, centralizeBuckets: false });
    const stack = new BootstrapStack(app, 'test-bootstrap-bucket-workload-distributed', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('does not create KMS key in workload account when centralizeBuckets is true', () => {
    const props = buildBootstrapProps({ account: WORKLOAD_ACCOUNT_ID, centralizeBuckets: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-key-workload-centralized', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('creates KMS key when bucket is created', () => {
    const props = buildBootstrapProps({ account: WORKLOAD_ACCOUNT_ID, centralizeBuckets: false });
    const stack = new BootstrapStack(app, 'test-bootstrap-key-workload-distributed', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 1);
  });
});

describe('BootstrapStack - asset bucket properties', () => {
  test('asset bucket blocks public access', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-block-public', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
  });

  test('asset bucket has versioning enabled', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-versioning', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({ VersioningConfiguration: { Status: 'Enabled' } }),
    );
  });

  test('asset bucket uses KMS encryption', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-encryption', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }),
          ],
        },
      }),
    );
  });

  test('asset bucket has lifecycle rule for cleaning old versions', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-lifecycle', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'CleanupOldVersions',
              Status: 'Enabled',
              NoncurrentVersionExpiration: { NoncurrentDays: 365 },
            }),
          ]),
        },
      }),
    );
  });
});

describe('BootstrapStack - bucket policy', () => {
  test('bucket policy denies insecure connections', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-deny-insecure', props);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties?.PolicyDocument?.Statement ?? [])
      .filter((s: any) => s.Sid === 'deny-insecure-connections');
    expect(policyStatements.length).toBeGreaterThan(0);
    expect(policyStatements[0].Effect).toBe('Deny');
  });

  test('bucket policy grants cdk read-write access', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-cdk-access', props);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties?.PolicyDocument?.Statement ?? [])
      .filter((s: any) => s.Sid === 'cdk-read-write-access');
    expect(policyStatements.length).toBeGreaterThan(0);
  });
});

describe('BootstrapStack - KMS key policy', () => {
  test('KMS key has rotation enabled', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-kms-rotation', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::KMS::Key', Match.objectLike({ EnableKeyRotation: true }));
  });

  test('KMS key policy includes S3 via-service condition', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-kms-s3', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const statements = key.Properties.KeyPolicy.Statement as any[];
    const s3ServiceStmt = statements.find((s: any) => s.Sid === 'Allow S3 to use the encryption key');
    expect(s3ServiceStmt).toBeDefined();
    expect(JSON.stringify(s3ServiceStmt.Condition.StringEquals)).toContain('kms:ViaService');
  });

  test('KMS key policy includes org-level conditions when organization enabled', () => {
    const props = buildBootstrapProps({ orgEnabled: true });
    const stack = new BootstrapStack(app, 'test-bootstrap-kms-org', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const serialized = JSON.stringify(key.Properties.KeyPolicy);
    expect(serialized).toContain('aws:PrincipalOrgID');
  });

  test('KMS key policy uses account-based conditions when organization disabled', () => {
    const props = buildBootstrapProps({ orgEnabled: false });
    const stack = new BootstrapStack(app, 'test-bootstrap-kms-acct', props);
    const template = Template.fromStack(stack);

    const keys = template.findResources('AWS::KMS::Key');
    const key = Object.values(keys)[0] as any;
    const serialized = JSON.stringify(key.Properties.KeyPolicy);
    // Org ID should NOT be in the org-principal statements when org is disabled
    expect(serialized).not.toContain('aws:PrincipalOrgID');
  });
});

describe('BootstrapStack - getAssetBucketName / getAssetBucketDomainName', () => {
  test('asset bucket name follows cdk qualifier + management account + region pattern', () => {
    const props = buildBootstrapProps({ account: MANAGEMENT_ACCOUNT_ID, region: HOME_REGION });
    const stack = new BootstrapStack(app, 'test-bootstrap-name-pattern', props, 'myqual');
    expect(stack.assetBucketName).toBe(`cdk-myqual-assets-${MANAGEMENT_ACCOUNT_ID}-${HOME_REGION}`);
  });

  test('asset bucket domain name follows expected S3 pattern', () => {
    const props = buildBootstrapProps({ account: MANAGEMENT_ACCOUNT_ID, region: HOME_REGION });
    const stack = new BootstrapStack(app, 'test-bootstrap-domain', props, 'myqual');
    expect(stack.getAssetBucketDomainName()).toBe(
      `cdk-myqual-assets-${MANAGEMENT_ACCOUNT_ID}-${HOME_REGION}.s3.${HOME_REGION}.amazonaws.com`,
    );
  });

  test('workload bucket name uses the target account id', () => {
    const props = buildBootstrapProps();
    const stack = new BootstrapStack(app, 'test-bootstrap-workload-name', props, 'myqual');
    expect(stack.getWorkloadBucketName('999999999999')).toBe(`cdk-myqual-assets-999999999999-${HOME_REGION}`);
  });
});
