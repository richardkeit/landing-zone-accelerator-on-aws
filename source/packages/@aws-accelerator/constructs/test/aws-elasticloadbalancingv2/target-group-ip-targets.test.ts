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

import * as cdk from 'aws-cdk-lib';
import { SynthUtils } from '@aws-cdk/assert';
import { describe, it, expect } from 'vitest';
import { TargetGroup } from '../../lib/aws-elasticloadbalancingv2/target-group';

describe('TargetGroup IP targets', () => {
  it('should set availabilityZone to all for ip-type target groups with string targets', () => {
    const stack = new cdk.Stack();

    new TargetGroup(stack, 'IpTargetGroup', {
      name: 'ip-tg-test',
      port: 80,
      protocol: 'HTTP',
      protocolVersion: 'HTTP1',
      type: 'ip',
      vpc: 'vpc-12345',
      targets: ['10.0.1.100', '10.0.2.200'],
    });

    const template = SynthUtils.toCloudFormation(stack);
    const resources = template.Resources;
    const targetGroupResource = Object.values(resources).find(
      (r: Record<string, unknown>) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup',
    ) as Record<string, Record<string, unknown>>;

    expect(targetGroupResource).toBeDefined();
    const targets = targetGroupResource.Properties.Targets as Array<Record<string, string>>;
    expect(targets).toBeDefined();
    expect(targets).toHaveLength(2);

    // Each target must have AvailabilityZone set to 'all' for cross-VPC IP registration
    for (const target of targets) {
      expect(target.Id).toBeDefined();
      expect(target.AvailabilityZone).toBe('all');
    }
  });

  it('should not set availabilityZone for instance-type target groups', () => {
    const stack = new cdk.Stack();

    new TargetGroup(stack, 'InstanceTargetGroup', {
      name: 'instance-tg-test',
      port: 80,
      protocol: 'HTTP',
      type: 'instance',
      vpc: 'vpc-12345',
      targets: ['i-1234567890abcdef0'],
    });

    const template = SynthUtils.toCloudFormation(stack);
    const resources = template.Resources;
    const targetGroupResource = Object.values(resources).find(
      (r: Record<string, unknown>) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup',
    ) as Record<string, Record<string, unknown>>;

    expect(targetGroupResource).toBeDefined();
    const targets = targetGroupResource.Properties.Targets as Array<Record<string, string>>;
    expect(targets).toBeDefined();

    // Instance targets should NOT have AvailabilityZone set
    for (const target of targets) {
      expect(target.Id).toBeDefined();
      expect(target.AvailabilityZone).toBeUndefined();
    }
  });

  it('should not set availabilityZone when no targets are specified', () => {
    const stack = new cdk.Stack();

    new TargetGroup(stack, 'NoTargetsGroup', {
      name: 'no-targets-tg',
      port: 80,
      protocol: 'HTTP',
      type: 'ip',
      vpc: 'vpc-12345',
    });

    const template = SynthUtils.toCloudFormation(stack);
    const resources = template.Resources;
    const targetGroupResource = Object.values(resources).find(
      (r: Record<string, unknown>) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup',
    ) as Record<string, Record<string, unknown>>;

    expect(targetGroupResource).toBeDefined();
    expect(targetGroupResource.Properties.Targets).toBeUndefined();
  });
});
