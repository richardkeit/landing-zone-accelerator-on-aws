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

import { GlobalConfig, IamConfig } from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { DependenciesStack } from '../../lib/stacks/dependencies-stack/dependencies-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

const HOME_REGION = 'us-east-1';
const OTHER_REGION = 'us-west-2';
const MANAGEMENT_ACCOUNT_ID = '234567890';
const WORKLOAD_ACCOUNT_ID = '111111111111';
const PIPELINE_ACCOUNT_ID_EXTERNAL = '1234567890';

function buildDependenciesProps(opts?: {
  account?: string;
  region?: string;
  homeRegion?: string;
  isDiagnosticsPackEnabled?: 'Yes' | 'No';
  enableSingleAccountMode?: boolean;
  useExistingRoles?: boolean;
  pipelineAccountId?: string;
  iamConfig?: Partial<IamConfig>;
  defaultEventBusPolicy?: string;
}): AcceleratorStackProps {
  const base = createAcceleratorStackProps();
  const account = opts?.account ?? WORKLOAD_ACCOUNT_ID;
  const region = opts?.region ?? HOME_REGION;
  const homeRegion = opts?.homeRegion ?? HOME_REGION;

  const globalConfig = {
    ...base.globalConfig,
    homeRegion,
    defaultEventBus: opts?.defaultEventBusPolicy
      ? { policy: opts.defaultEventBusPolicy, deploymentTargets: { accounts: [], organizationalUnits: ['Root'] } }
      : undefined,
  } as unknown as GlobalConfig;

  return {
    ...base,
    env: { account, region },
    globalConfig,
    iamConfig: { ...base.iamConfig, ...opts?.iamConfig } as IamConfig,
    isDiagnosticsPackEnabled: opts?.isDiagnosticsPackEnabled ?? 'No',
    enableSingleAccountMode: opts?.enableSingleAccountMode ?? false,
    useExistingRoles: opts?.useExistingRoles ?? false,
    pipelineAccountId: opts?.pipelineAccountId ?? PIPELINE_ACCOUNT_ID_EXTERNAL,
  } as AcceleratorStackProps;
}

let app: cdk.App;

beforeEach(() => {
  app = new cdk.App();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DependenciesStack - PutSsmParameterRole region gating', () => {
  test('creates PutSsmParameterRole in the home region', () => {
    const props = buildDependenciesProps({ region: HOME_REGION, homeRegion: HOME_REGION });
    const stack = new DependenciesStack(app, 'test-deps-stack-home', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const putSsmRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('CrossAccountSsmParameterShare'),
    );
    expect(putSsmRoleExists).toBe(true);
  });

  test('does not create PutSsmParameterRole outside the home region', () => {
    const props = buildDependenciesProps({ region: OTHER_REGION, homeRegion: HOME_REGION });
    const stack = new DependenciesStack(app, 'test-deps-stack-other', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const putSsmRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('CrossAccountSsmParameterShare'),
    );
    expect(putSsmRoleExists).toBe(false);
  });

  test('PutSsmParameterRole grants ssm:PutParameter action', () => {
    const props = buildDependenciesProps();
    const stack = new DependenciesStack(app, 'test-deps-put-ssm-action', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const putSsmRole = Object.values(roles).find(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('CrossAccountSsmParameterShare'),
    ) as any;
    expect(putSsmRole).toBeDefined();
    const actions = putSsmRole.Properties.Policies[0].PolicyDocument.Statement[0].Action as string[];
    expect(actions).toContain('ssm:PutParameter');
  });

  test('PutSsmParameterRole grants ssm:DeleteParameter action', () => {
    const props = buildDependenciesProps();
    const stack = new DependenciesStack(app, 'test-deps-put-ssm-delete', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const putSsmRole = Object.values(roles).find(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('CrossAccountSsmParameterShare'),
    ) as any;
    const actions = putSsmRole.Properties.Policies[0].PolicyDocument.Statement[0].Action as string[];
    expect(actions).toContain('ssm:DeleteParameter');
  });
});

describe('DependenciesStack - default event bus policy', () => {
  test('does not create event bus policy when defaultEventBus config is undefined', () => {
    const props = buildDependenciesProps({ defaultEventBusPolicy: undefined });
    const stack = new DependenciesStack(app, 'test-deps-no-eb-policy', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::EventBusPolicy', 0);
  });
});

describe('DependenciesStack - DiagnosticsPack role gating', () => {
  test('does not create DiagnosticsPackAssumeRole when isDiagnosticsPackEnabled is "No"', () => {
    const props = buildDependenciesProps({ isDiagnosticsPackEnabled: 'No' });
    const stack = new DependenciesStack(app, 'test-deps-dp-disabled', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(false);
  });

  test('does not create DiagnosticsPackAssumeRole in single account mode', () => {
    const props = buildDependenciesProps({ isDiagnosticsPackEnabled: 'Yes', enableSingleAccountMode: true });
    const stack = new DependenciesStack(app, 'test-deps-dp-single', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(false);
  });

  test('does not create DiagnosticsPackAssumeRole when useExistingRoles is true', () => {
    const props = buildDependenciesProps({ isDiagnosticsPackEnabled: 'Yes', useExistingRoles: true });
    const stack = new DependenciesStack(app, 'test-deps-dp-existing', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(false);
  });

  test('creates DiagnosticsPackAssumeRole in workload account home region when diagnostics enabled', () => {
    const props = buildDependenciesProps({
      account: WORKLOAD_ACCOUNT_ID,
      region: HOME_REGION,
      homeRegion: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-workload-home', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(true);
  });

  test('does not create DiagnosticsPackAssumeRole outside home region', () => {
    const props = buildDependenciesProps({
      account: WORKLOAD_ACCOUNT_ID,
      region: OTHER_REGION,
      homeRegion: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-other-region', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(false);
  });

  test('does not create DiagnosticsPackAssumeRole in management account for non-external deployment', () => {
    // Non-external deployment: pipelineAccountId == managementAccountId
    const props = buildDependenciesProps({
      account: MANAGEMENT_ACCOUNT_ID,
      region: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
      pipelineAccountId: MANAGEMENT_ACCOUNT_ID,
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-mgmt-non-external', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(false);
  });

  test('creates DiagnosticsPackAssumeRole in management account for external deployment', () => {
    const props = buildDependenciesProps({
      account: MANAGEMENT_ACCOUNT_ID,
      region: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
      pipelineAccountId: PIPELINE_ACCOUNT_ID_EXTERNAL,
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-mgmt-external', props);
    const template = Template.fromStack(stack);

    const roles = template.findResources('AWS::IAM::Role');
    const dpRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('DiagnosticsPackAccessRole'),
    );
    expect(dpRoleExists).toBe(true);
  });

  test('DiagnosticsPackAssumeRole policy includes CloudFormation DescribeStacks permission', () => {
    const props = buildDependenciesProps({
      account: WORKLOAD_ACCOUNT_ID,
      region: HOME_REGION,
      homeRegion: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-cfn-perms', props);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::IAM::Policy');
    const hasCfnDescribe = Object.values(policies).some((p: any) => {
      const serialized = JSON.stringify(p.Properties?.PolicyDocument);
      return serialized.includes('cloudformation:DescribeStacks');
    });
    expect(hasCfnDescribe).toBe(true);
  });

  test('DiagnosticsPackAssumeRole policy includes Organizations ListAccounts when in management account', () => {
    const props = buildDependenciesProps({
      account: MANAGEMENT_ACCOUNT_ID,
      region: HOME_REGION,
      homeRegion: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
      pipelineAccountId: PIPELINE_ACCOUNT_ID_EXTERNAL,
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-orgs', props);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::IAM::Policy');
    const hasOrgs = Object.values(policies).some((p: any) => {
      const serialized = JSON.stringify(p.Properties?.PolicyDocument);
      return serialized.includes('organizations:ListAccounts');
    });
    expect(hasOrgs).toBe(true);
  });

  test('DiagnosticsPackAssumeRole does not include Organizations ListAccounts in workload account', () => {
    const props = buildDependenciesProps({
      account: WORKLOAD_ACCOUNT_ID,
      region: HOME_REGION,
      homeRegion: HOME_REGION,
      isDiagnosticsPackEnabled: 'Yes',
    });
    const stack = new DependenciesStack(app, 'test-deps-dp-no-orgs', props);
    const template = Template.fromStack(stack);

    const policies = template.findResources('AWS::IAM::Policy');
    const hasOrgs = Object.values(policies).some((p: any) => {
      const serialized = JSON.stringify(p.Properties?.PolicyDocument);
      return serialized.includes('organizations:ListAccounts');
    });
    expect(hasOrgs).toBe(false);
  });
});

describe('DependenciesStack - Identity Center managed policies', () => {
  test('creates no IAM managed policies when no policySets are configured', () => {
    const props = buildDependenciesProps();
    const stack = new DependenciesStack(app, 'test-deps-idc-no-policies', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });

  test('creates no IAM managed policies outside home region', () => {
    const props = buildDependenciesProps({ region: OTHER_REGION, homeRegion: HOME_REGION });
    const stack = new DependenciesStack(app, 'test-deps-idc-other-region', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });
});
