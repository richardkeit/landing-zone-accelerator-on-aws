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

import { SubnetConfig } from '@aws-accelerator/config';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AcceleratorStackProps } from '../../../lib/stacks/accelerator-stack';
import { NetworkPrepStack } from '../../../lib/stacks/network-stacks/network-prep-stack/network-prep-stack';
import { createAcceleratorStackProps } from '../stack-props-test-helper';

// `Network` shares the deploying-stack id so the filter has an owner to remove.
const OWNING_ACCOUNT_ID = '111111111111';
const ACCOUNT_IDS: Record<string, string> = {
  Network: OWNING_ACCOUNT_ID,
  SharedServices: '222222222222',
  Perimeter: '333333333333',
  Workload_A: '444444444444',
  Workload_B: '555555555555',
  Sibling: '666666666666',
};

// Build a SubnetConfig-shaped item with the given shareTargets.
function shareItem(shareTargets: SubnetConfig['shareTargets']): SubnetConfig {
  return { shareTargets } as unknown as SubnetConfig;
}

describe('NetworkStack.addResourceShare — owning-account principal filter', () => {
  let app: cdk.App;
  let props: AcceleratorStackProps;
  let stack: NetworkPrepStack;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(NetworkPrepStack.prototype, 'getCentralLogBucketName').mockReturnValue('unitTestLogBucket');
    vi.spyOn(NetworkPrepStack.prototype, 'getSsmPath').mockReturnValue('/test/ssm-path/');
    vi.spyOn(NetworkPrepStack.prototype, 'getAcceleratorKey').mockReturnValue(undefined);
    vi.spyOn(NetworkPrepStack.prototype, 'isIncluded').mockReturnValue(true);

    app = new cdk.App();
    props = createAcceleratorStackProps({
      env: { account: OWNING_ACCOUNT_ID, region: 'us-east-1' },
    } as AcceleratorStackProps);
    (props.accountsConfig.getAccountId as any).mockImplementation(
      (name: string) => ACCOUNT_IDS[name] ?? `unknown-${name}`,
    );
    stack = new NetworkPrepStack(app, 'unit-test-network-prep-stack', props);
  });

  function principalsOf(name: string): unknown[] {
    const template = Template.fromStack(stack);
    const shares = template.findResources('AWS::RAM::ResourceShare', {
      Properties: { Name: name },
    });
    const keys = Object.keys(shares);
    expect(keys.length, `expected exactly one RAM share named "${name}"`).toBe(1);
    return shares[keys[0]].Properties.Principals ?? [];
  }

  // baseline: no owner in the list, nothing filtered
  test('case 1 — accounts: [Workload_A, Workload_B] retains both, filters nothing', () => {
    stack.addResourceShare(
      shareItem({ accounts: ['Workload_A', 'Workload_B'], organizationalUnits: [] }),
      'case1-share',
      ['arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x'],
    );
    expect(principalsOf('case1-share')).toEqual([ACCOUNT_IDS.Workload_A, ACCOUNT_IDS.Workload_B]);
  });

  // owner listed alongside others — only the owner is removed
  test('case 2 — accounts: [SharedServices, Network, Perimeter] removes only the owner', () => {
    stack.addResourceShare(
      shareItem({ accounts: ['SharedServices', 'Network', 'Perimeter'], organizationalUnits: [] }),
      'case2-share',
      ['arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x'],
    );
    const principals = principalsOf('case2-share');
    expect(principals).toEqual([ACCOUNT_IDS.SharedServices, ACCOUNT_IDS.Perimeter]);
    expect(principals).not.toContain(OWNING_ACCOUNT_ID);
  });

  // guard against over-filtering: a sibling in owner's OU stays
  test("case 3 — accounts: [Sibling] (sibling in owner's OU) is retained", () => {
    stack.addResourceShare(shareItem({ accounts: ['Sibling'], organizationalUnits: [] }), 'case3-share', [
      'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x',
    ]);
    expect(principalsOf('case3-share')).toEqual([ACCOUNT_IDS.Sibling]);
  });

  // OU containing owner is retained — filter is account-only
  test('case 4 — organizationalUnits: [Infrastructure] retains OU principal unchanged', () => {
    stack.addResourceShare(shareItem({ accounts: [], organizationalUnits: ['Infrastructure'] }), 'case4-share', [
      'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x',
    ]);
    const principals = principalsOf('case4-share');
    expect(principals).toHaveLength(1);
    expect(principals[0]).toMatch(/^arn:aws:organizations::\d+:ou\/o-[a-z0-9]+\/Infrastructure$/);
  });

  // share to an account outside the owner's OU
  test('case 5 — accounts: [Workload_A] (different OU) retained', () => {
    stack.addResourceShare(shareItem({ accounts: ['Workload_A'], organizationalUnits: [] }), 'case5-share', [
      'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x',
    ]);
    expect(principalsOf('case5-share')).toEqual([ACCOUNT_IDS.Workload_A]);
  });

  // only owner listed: principals empty but the share resource still synthesizes
  test('case 6 — accounts: [Network] only — no principals emitted but share still synthesizes', () => {
    stack.addResourceShare(shareItem({ accounts: ['Network'], organizationalUnits: [] }), 'case6-share', [
      'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x',
    ]);
    const template = Template.fromStack(stack);
    const shares = template.findResources('AWS::RAM::ResourceShare', {
      Properties: { Name: 'case6-share' },
    });
    expect(Object.keys(shares).length).toBe(1);
    const props = shares[Object.keys(shares)[0]].Properties;
    expect(props.Principals).toEqual([]);
  });

  // empty shareTargets must not crash the filter
  test('case 7 — empty shareTargets — principals empty, no crash', () => {
    stack.addResourceShare(shareItem({ accounts: [], organizationalUnits: [] }), 'case7-share', [
      'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x',
    ]);
    expect(principalsOf('case7-share')).toEqual([]);
  });

  // mixed inputs: OU kept, owner removed, other accounts kept
  test('case 8 — mixed OU + accounts (owner present): OU kept, owner filtered, others kept', () => {
    stack.addResourceShare(
      shareItem({
        accounts: ['SharedServices', 'Network'],
        organizationalUnits: ['Infrastructure'],
      }),
      'case8-share',
      ['arn:aws:ec2:us-east-1:111111111111:subnet/subnet-x'],
    );
    const principals = principalsOf('case8-share');
    expect(principals).toHaveLength(2);
    expect(principals[0]).toMatch(/Infrastructure$/);
    expect(principals[1]).toBe(ACCOUNT_IDS.SharedServices);
    expect(principals).not.toContain(OWNING_ACCOUNT_ID);
  });
});
