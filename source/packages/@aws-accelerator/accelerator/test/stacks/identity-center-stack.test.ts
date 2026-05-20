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
  IamConfig,
  IdentityCenterAssignmentConfig,
  IdentityCenterConfig,
  IdentityCenterPermissionSetConfig,
  IdentityCenterPoliciesConfig,
} from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStack, AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { IdentityCenterStack } from '../../lib/stacks/identity-center-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

const MANAGEMENT_ACCOUNT_ID = '234567890';
const NON_MANAGEMENT_ACCOUNT_ID = '111111111111';
const HOME_REGION = 'us-east-1';
const OTHER_REGION = 'us-west-2';

function buildIdentityCenterStackProps(opts?: {
  region?: string;
  account?: string;
  identityCenter?: IdentityCenterConfig;
}): AcceleratorStackProps {
  const base = createAcceleratorStackProps();
  const iamConfig: Partial<IamConfig> = {
    ...base.iamConfig,
    identityCenter: opts?.identityCenter,
  };

  return {
    ...base,
    env: {
      account: opts?.account ?? MANAGEMENT_ACCOUNT_ID,
      region: opts?.region ?? HOME_REGION,
    },
    iamConfig: iamConfig as IamConfig,
  } as AcceleratorStackProps;
}

function makeIdentityCenterConfig(
  permissionSets: IdentityCenterPermissionSetConfig[] = [],
  assignments: IdentityCenterAssignmentConfig[] = [],
): IdentityCenterConfig {
  return {
    name: 'test-identity-center',
    delegatedAdminAccount: undefined,
    identityCenterPermissionSets: permissionSets,
    identityCenterAssignments: assignments,
  } as IdentityCenterConfig;
}

function makePermissionSet(
  name: string,
  policies?: Partial<IdentityCenterPoliciesConfig>,
  sessionDuration?: number,
): IdentityCenterPermissionSetConfig {
  return {
    name,
    policies: policies as IdentityCenterPoliciesConfig | undefined,
    sessionDuration,
    description: undefined,
  } as IdentityCenterPermissionSetConfig;
}

let app: cdk.App;

beforeEach(() => {
  app = new cdk.App();
  // Return a real (but unmanaged) key so IdentityCenterInstance can be built
  vi.spyOn(AcceleratorStack.prototype, 'getAcceleratorKey').mockImplementation(function (this: AcceleratorStack) {
    return new cdk.aws_kms.Key(this, `MockKey-${Math.random().toString(36).slice(2, 8)}`, {
      enableKeyRotation: true,
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IdentityCenterStack - account and region gating', () => {
  test('creates no permission sets when run outside home region', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('AdminAccess')]);
    const props = buildIdentityCenterStackProps({ region: OTHER_REGION, identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-non-home', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 0);
  });

  test('creates no permission sets when run outside management account', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('AdminAccess')]);
    const props = buildIdentityCenterStackProps({
      account: NON_MANAGEMENT_ACCOUNT_ID,
      identityCenter: idc,
    });
    const stack = new IdentityCenterStack(app, 'test-idc-non-mgmt', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 0);
  });

  test('creates no identity center resources when iamConfig.identityCenter is undefined', () => {
    const props = buildIdentityCenterStackProps({ identityCenter: undefined });
    const stack = new IdentityCenterStack(app, 'test-idc-undefined', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 0);
    template.resourceCountIs('AWS::SSO::Assignment', 0);
  });

  test('creates no IdentityCenter custom resource when iamConfig.identityCenter is undefined', () => {
    const props = buildIdentityCenterStackProps({ identityCenter: undefined });
    const stack = new IdentityCenterStack(app, 'test-idc-undefined-no-cr', props);
    const template = Template.fromStack(stack);

    // The IdentityCenterInstance custom resource creates its own Lambda - none should exist.
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });
});

describe('IdentityCenterStack - permission set count', () => {
  test('creates zero permission sets when identityCenter defined but list empty', () => {
    const idc = makeIdentityCenterConfig([]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-empty', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 0);
  });

  test('creates one permission set for a single entry', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('AdminAccess')]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-one', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 1);
  });

  test('creates three permission sets for three entries', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('AdminAccess'),
      makePermissionSet('ReadOnlyAccess'),
      makePermissionSet('DeveloperAccess'),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-three', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSO::PermissionSet', 3);
  });
});

describe('IdentityCenterStack - AWS managed policies', () => {
  test('attaches a single AWS managed policy by name', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('AdminAccess', { awsManaged: ['AdministratorAccess'] })]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-aws-managed-single', props);
    const template = Template.fromStack(stack);

    const sets = template.findResources('AWS::SSO::PermissionSet');
    const set = Object.values(sets)[0] as any;
    const managed = set.Properties.ManagedPolicies;
    expect(managed).toBeDefined();
    expect(Array.isArray(managed)).toBe(true);
    expect(managed.length).toBe(1);
  });

  test('attaches multiple AWS managed policies', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('Multi', { awsManaged: ['AdministratorAccess', 'ReadOnlyAccess'] }),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-aws-managed-multi', props);
    const template = Template.fromStack(stack);

    const sets = template.findResources('AWS::SSO::PermissionSet');
    const set = Object.values(sets)[0] as any;
    expect(set.Properties.ManagedPolicies.length).toBe(2);
  });

  test('accepts AWS managed policy ARNs directly', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('ArnBased', {
        awsManaged: ['arn:aws:iam::aws:policy/AdministratorAccess'],
      }),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-aws-managed-arn', props);
    const template = Template.fromStack(stack);

    const sets = template.findResources('AWS::SSO::PermissionSet');
    const set = Object.values(sets)[0] as any;
    expect(set.Properties.ManagedPolicies).toContain('arn:aws:iam::aws:policy/AdministratorAccess');
  });

  test('omits ManagedPolicies when no AWS managed policies are configured', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('NoPolicies')]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-no-managed', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'NoPolicies',
        ManagedPolicies: Match.absent(),
      }),
    );
  });
});

describe('IdentityCenterStack - customer managed policy references', () => {
  test('attaches customer managed policy references by name', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('Custom', { customerManaged: ['MyCustomerPolicy'] })]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-cmp', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'Custom',
        CustomerManagedPolicyReferences: [{ Name: 'MyCustomerPolicy' }],
      }),
    );
  });

  test('attaches acceleratorManaged policies as customer managed references', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('Acc', { acceleratorManaged: ['LzaManagedPolicy'] })]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-acc-managed', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'Acc',
        CustomerManagedPolicyReferences: [{ Name: 'LzaManagedPolicy' }],
      }),
    );
  });

  test('combines customer managed and acceleratorManaged policy lists', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('Combined', {
        customerManaged: ['Cust1'],
        acceleratorManaged: ['Acc1'],
      }),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-combined-cmp', props);
    const template = Template.fromStack(stack);

    const sets = template.findResources('AWS::SSO::PermissionSet');
    const set = Object.values(sets)[0] as any;
    expect(set.Properties.CustomerManagedPolicyReferences.length).toBe(2);
  });

  test('omits CustomerManagedPolicyReferences when none are configured', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('NoCmp', { awsManaged: ['ReadOnlyAccess'] })]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-no-cmp', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'NoCmp',
        CustomerManagedPolicyReferences: Match.absent(),
      }),
    );
  });
});

describe('IdentityCenterStack - session duration', () => {
  test('converts 60 minutes to PT1H', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('OneHour', undefined, 60)]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-dur-60', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'OneHour', SessionDuration: 'PT1H0M' }),
    );
  });

  test('converts 480 minutes to PT8H', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('EightHours', undefined, 480)]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-dur-480', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'EightHours', SessionDuration: 'PT8H0M' }),
    );
  });

  test('omits SessionDuration when not configured', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('NoDuration')]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-no-dur', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'NoDuration', SessionDuration: Match.absent() }),
    );
  });

  test('converts less than an hour to just minutes', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('FortyFive', undefined, 45)]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-dur-45', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'FortyFive', SessionDuration: 'PT45M' }),
    );
  });

  test('converts a full day to include days', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('Day', undefined, 1440)]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-dur-1440', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'Day', SessionDuration: 'PT1D0M' }),
    );
  });
});

describe('IdentityCenterStack - permissions boundary', () => {
  test('sets AWS managed permissions boundary', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('Bound', {
        permissionsBoundary: { awsManagedPolicyName: 'ReadOnlyAccess' } as any,
      }),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-aws-boundary', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'Bound',
        PermissionsBoundary: Match.objectLike({ ManagedPolicyArn: Match.anyValue() }),
      }),
    );
  });

  test('sets customer managed permissions boundary', () => {
    const idc = makeIdentityCenterConfig([
      makePermissionSet('CustBound', {
        permissionsBoundary: {
          customerManagedPolicy: { name: 'MyBoundary', path: '/boundary/' },
        } as any,
      }),
    ]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-cust-boundary', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({
        Name: 'CustBound',
        PermissionsBoundary: {
          CustomerManagedPolicyReference: { Name: 'MyBoundary', Path: '/boundary/' },
        },
      }),
    );
  });

  test('omits permissions boundary when not configured', () => {
    const idc = makeIdentityCenterConfig([makePermissionSet('NoBound')]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-no-boundary', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties(
      'AWS::SSO::PermissionSet',
      Match.objectLike({ Name: 'NoBound', PermissionsBoundary: Match.absent() }),
    );
  });
});

describe('IdentityCenterStack - SSM parameters for Identity Center instance', () => {
  test('publishes Identity Center instance ARN SSM parameter', () => {
    const idc = makeIdentityCenterConfig([]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-ssm-instance-arn', props);
    const template = Template.fromStack(stack);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const instanceArnParam = Object.values(ssmParams).find(
      (p: any) => typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/identity-center/instance-arn'),
    );
    expect(instanceArnParam).toBeDefined();
  });

  test('publishes Identity Center identity store ID SSM parameter', () => {
    const idc = makeIdentityCenterConfig([]);
    const props = buildIdentityCenterStackProps({ identityCenter: idc });
    const stack = new IdentityCenterStack(app, 'test-idc-ssm-store-id', props);
    const template = Template.fromStack(stack);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const storeIdParam = Object.values(ssmParams).find(
      (p: any) =>
        typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/identity-center/identity-store-id'),
    );
    expect(storeIdParam).toBeDefined();
  });
});
