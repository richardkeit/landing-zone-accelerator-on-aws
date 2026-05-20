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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { PrepareStack } from '../../lib/stacks/prepare-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';
import { Create } from '../accelerator-test-helpers';
import { AcceleratorStage } from '../../lib/accelerator-stage';

const MANAGEMENT_ACCOUNT_ID = '234567890';
const WORKLOAD_ACCOUNT_ID = '111111111111';
const HOME_REGION = 'us-east-1';
const OTHER_REGION = 'us-west-2';

function buildPrepareProps(opts?: { account?: string; region?: string; homeRegion?: string }): AcceleratorStackProps {
  const base = createAcceleratorStackProps();
  return {
    ...base,
    env: {
      account: opts?.account ?? WORKLOAD_ACCOUNT_ID,
      region: opts?.region ?? OTHER_REGION,
    },
    globalConfig: {
      ...base.globalConfig,
      homeRegion: opts?.homeRegion ?? HOME_REGION,
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

describe('PrepareStack - account and region gating (minimal props)', () => {
  test('creates no DynamoDB tables in a workload account (not management)', () => {
    const props = buildPrepareProps({ account: WORKLOAD_ACCOUNT_ID });
    const stack = new PrepareStack(app, 'test-prepare-workload', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  test('creates no KMS keys in a workload account', () => {
    const props = buildPrepareProps({ account: WORKLOAD_ACCOUNT_ID });
    const stack = new PrepareStack(app, 'test-prepare-workload-keys', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('creates no DynamoDB tables outside home region in management account', () => {
    const props = buildPrepareProps({ account: MANAGEMENT_ACCOUNT_ID, region: OTHER_REGION });
    const stack = new PrepareStack(app, 'test-prepare-mgmt-other', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  test('creates no KMS keys outside home region in management account', () => {
    const props = buildPrepareProps({ account: MANAGEMENT_ACCOUNT_ID, region: OTHER_REGION });
    const stack = new PrepareStack(app, 'test-prepare-mgmt-other-keys', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('creates no custom resources in workload account', () => {
    const props = buildPrepareProps({ account: WORKLOAD_ACCOUNT_ID });
    const stack = new PrepareStack(app, 'test-prepare-workload-custom', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 0);
  });
});

describe('PrepareStack - management home region (real configs)', () => {
  test('creates Accelerator config DynamoDB table when organization is enabled', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const tables = template.findResources('AWS::DynamoDB::Table');
    const configTable = Object.values(tables).find((t: any) => JSON.stringify(t).includes('awsResourceKeys'));
    expect(configTable).toBeDefined();
  });

  test('creates management KMS key SSM parameter', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const mgmtKeyParam = Object.values(ssmParams).find(
      (p: any) => typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/management/kms/key-arn'),
    );
    expect(mgmtKeyParam).toBeDefined();
  });

  test('creates config table ARN SSM parameter', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const tableArnParam = Object.values(ssmParams).find(
      (p: any) =>
        typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/prepare-stack/configTable/arn'),
    );
    expect(tableArnParam).toBeDefined();
  });

  test('creates config table name SSM parameter', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const tableNameParam = Object.values(ssmParams).find(
      (p: any) =>
        typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/prepare-stack/configTable/name'),
    );
    expect(tableNameParam).toBeDefined();
  });

  test('creates AcceleratorMoveAccountRole IAM role', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const roles = template.findResources('AWS::IAM::Role');
    const moveAccountRoleExists = Object.values(roles).some(
      (r: any) => r.Properties?.RoleName && String(r.Properties.RoleName).includes('MoveAccountConfigRule-Role'),
    );
    expect(moveAccountRoleExists).toBe(true);
  });

  test('uses customer-managed KMS encryption for the config table', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const tables = template.findResources('AWS::DynamoDB::Table');
    const configTable = Object.values(tables).find((t: any) => JSON.stringify(t).includes('awsResourceKeys')) as any;
    expect(configTable.Properties.SSESpecification).toBeDefined();
    expect(configTable.Properties.SSESpecification.SSEEnabled).toBe(true);
    expect(configTable.Properties.SSESpecification.SSEType).toBe('KMS');
  });

  test('config table has PAY_PER_REQUEST billing mode', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const tables = template.findResources('AWS::DynamoDB::Table');
    const configTable = Object.values(tables).find((t: any) => JSON.stringify(t).includes('awsResourceKeys')) as any;
    expect(configTable.Properties.BillingMode).toBe('PAY_PER_REQUEST');
  });

  test('config table has point-in-time recovery enabled', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const tables = template.findResources('AWS::DynamoDB::Table');
    const configTable = Object.values(tables).find((t: any) => JSON.stringify(t).includes('awsResourceKeys')) as any;
    expect(configTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
  });

  test('creates AcceleratorResourceTable DynamoDB table', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const tables = template.findResources('AWS::DynamoDB::Table');
    const resourceTables = Object.values(tables).filter((t: any) => {
      const keys = (t.Properties?.KeySchema ?? []) as any[];
      return keys.length === 2 && keys.some(k => k.AttributeName === 'pk');
    });
    expect(resourceTables.length).toBeGreaterThanOrEqual(1);
  });

  test('creates resource table name SSM parameter', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const resourceTableParam = Object.values(ssmParams).find(
      (p: any) =>
        typeof p.Properties?.Name === 'string' && p.Properties.Name.endsWith('/prepare-stack/resourceTable/name'),
    );
    expect(resourceTableParam).toBeDefined();
  });

  test('management key has rotation enabled', () => {
    const stack = Create.stack('Management-us-east-1', AcceleratorStage.PREPARE);
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);

    const keys = template.findResources('AWS::KMS::Key');
    const managementKey = Object.values(keys).find(
      (k: any) =>
        typeof k.Properties?.Description === 'string' && k.Properties.Description.toLowerCase().includes('management'),
    ) as any;
    expect(managementKey).toBeDefined();
    expect(managementKey.Properties.EnableKeyRotation).toBe(true);
  });
});
