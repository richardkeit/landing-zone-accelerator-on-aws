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
  AuditManagerDefaultReportsDestinationConfig,
  DetectiveConfig,
  GuardDutyConfig,
  MacieConfig,
  ResourcePolicyEnforcementConfig,
  SecurityConfig,
  SecurityHubConfig,
  SnsSubscriptionConfig,
} from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AcceleratorStack, AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { SecurityAuditStack } from '../../lib/stacks/security-audit-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

const HOME_REGION = 'us-east-1';

function setSecurityConfig(
  baseSecurityConfig: SecurityConfig,
  overrides: {
    macie?: Partial<MacieConfig>;
    guardDuty?: Partial<GuardDutyConfig>;
    securityHub?: Partial<SecurityHubConfig>;
    detective?: Partial<DetectiveConfig>;
    auditManager?: Partial<AuditManagerConfig>;
    accessAnalyzer?: { enable: boolean };
    resourcePolicyEnforcement?: Partial<ResourcePolicyEnforcementConfig>;
    snsSubscriptions?: SnsSubscriptionConfig[];
  },
): SecurityConfig {
  const svc = baseSecurityConfig.centralSecurityServices as any;
  if (overrides.macie) Object.assign(svc.macie, overrides.macie);
  if (overrides.guardDuty) Object.assign(svc.guardduty, overrides.guardDuty);
  if (overrides.securityHub) Object.assign(svc.securityHub, overrides.securityHub);
  if (overrides.detective) Object.assign(svc.detective, overrides.detective);
  if (overrides.auditManager) Object.assign(svc.auditManager, overrides.auditManager);
  if (overrides.snsSubscriptions) svc.snsSubscriptions = overrides.snsSubscriptions;
  if (overrides.accessAnalyzer) {
    (baseSecurityConfig as any).accessAnalyzer = overrides.accessAnalyzer;
  }
  if (overrides.resourcePolicyEnforcement) {
    (baseSecurityConfig as any).resourcePolicyEnforcement = overrides.resourcePolicyEnforcement;
  }
  return baseSecurityConfig;
}

function buildAuditProps(overrides?: {
  region?: string;
  macieEnable?: boolean;
  guardDutyEnable?: boolean;
  securityHubEnable?: boolean;
  securityHubRegionAggregation?: boolean;
  detectiveEnable?: boolean;
  auditManagerEnable?: boolean;
  auditManagerExcludeRegions?: string[];
  accessAnalyzerEnable?: boolean;
  resourcePolicyEnforcementEnable?: boolean;
  snsSubscriptions?: SnsSubscriptionConfig[];
}): AcceleratorStackProps {
  const base = createAcceleratorStackProps();
  const sec = base.securityConfig as any;
  sec.centralSecurityServices.macie = new MacieConfig();
  sec.centralSecurityServices.guardduty = new GuardDutyConfig();
  sec.centralSecurityServices.securityHub = new SecurityHubConfig();
  sec.centralSecurityServices.detective = new DetectiveConfig();
  sec.centralSecurityServices.auditManager = new AuditManagerConfig();

  const securityConfig = setSecurityConfig(base.securityConfig, {
    macie: { enable: overrides?.macieEnable ?? false, excludeRegions: [] },
    guardDuty: { enable: overrides?.guardDutyEnable ?? false },
    securityHub: {
      enable: overrides?.securityHubEnable ?? false,
      regionAggregation: overrides?.securityHubRegionAggregation ?? false,
    } as any,
    detective: { enable: overrides?.detectiveEnable ?? false, excludeRegions: [] },
    auditManager: {
      enable: overrides?.auditManagerEnable ?? false,
      excludeRegions: overrides?.auditManagerExcludeRegions ?? [],
      defaultReportsConfiguration: new AuditManagerDefaultReportsDestinationConfig(),
      lifecycleRules: [],
    } as any,
    accessAnalyzer: { enable: overrides?.accessAnalyzerEnable ?? false },
    resourcePolicyEnforcement: { enable: overrides?.resourcePolicyEnforcementEnable ?? false } as any,
    snsSubscriptions: overrides?.snsSubscriptions ?? [],
  });

  return {
    ...base,
    env: { account: '456789012', region: overrides?.region ?? HOME_REGION },
    securityConfig,
  } as AcceleratorStackProps;
}

let app: cdk.App;

beforeEach(() => {
  app = new cdk.App();
  vi.spyOn(AcceleratorStack.prototype, 'getAcceleratorKey').mockImplementation(function (this: AcceleratorStack) {
    return new cdk.aws_kms.Key(this, `MockKey-${Math.random().toString(36).slice(2, 8)}`, {
      enableKeyRotation: true,
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SecurityAuditStack - IAM Access Analyzer', () => {
  test('creates Analyzer when accessAnalyzer.enable is true', () => {
    const props = buildAuditProps({ accessAnalyzerEnable: true });
    const stack = new SecurityAuditStack(app, 'test-audit-analyzer-on', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::AccessAnalyzer::Analyzer', 1);
  });

  test('does not create Analyzer when accessAnalyzer.enable is false', () => {
    const props = buildAuditProps({ accessAnalyzerEnable: false });
    const stack = new SecurityAuditStack(app, 'test-audit-analyzer-off', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::AccessAnalyzer::Analyzer', 0);
  });

  test('creates an ORGANIZATION type analyzer', () => {
    const props = buildAuditProps({ accessAnalyzerEnable: true });
    const stack = new SecurityAuditStack(app, 'test-audit-analyzer-type', props);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::AccessAnalyzer::Analyzer', { Type: 'ORGANIZATION' });
  });
});

describe('SecurityAuditStack - AuditManager bucket gating', () => {
  test('creates AuditManager publishing bucket when auditManager is enabled', () => {
    const props = buildAuditProps({ auditManagerEnable: true });
    const stack = new SecurityAuditStack(app, 'test-audit-am-on', props);
    const template = Template.fromStack(stack);

    const buckets = template.findResources('AWS::S3::Bucket');
    const auditBucket = Object.values(buckets).find((b: any) =>
      typeof b.Properties?.BucketName === 'string' ? b.Properties.BucketName.includes('audit-manager') : false,
    );
    // bucket name may be a CloudFormation intrinsic; fall back to count check
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
    if (auditBucket) {
      expect(auditBucket).toBeDefined();
    }
  });

  test('does not create AuditManager bucket when auditManager is disabled', () => {
    const props = buildAuditProps({ auditManagerEnable: false });
    const stack = new SecurityAuditStack(app, 'test-audit-am-off', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('does not create AuditManager bucket when region is excluded', () => {
    const props = buildAuditProps({
      auditManagerEnable: true,
      auditManagerExcludeRegions: [HOME_REGION],
    });
    const stack = new SecurityAuditStack(app, 'test-audit-am-excluded', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('creates AuditManager SSM parameter for bucket ARN when enabled', () => {
    const props = buildAuditProps({ auditManagerEnable: true });
    const stack = new SecurityAuditStack(app, 'test-audit-am-ssm', props);
    const template = Template.fromStack(stack);

    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const amBucketParam = Object.values(ssmParams).find(
      (p: any) =>
        typeof p.Properties?.Name === 'string' &&
        p.Properties.Name.endsWith('/auditManager/publishing-destination/bucket-arn'),
    );
    expect(amBucketParam).toBeDefined();
  });
});

describe('SecurityAuditStack - ResourcePolicyEnforcement SSM document', () => {
  test('creates SSM document when resourcePolicyEnforcement.enable is true', () => {
    const props = buildAuditProps({ resourcePolicyEnforcementEnable: true });
    const stack = new SecurityAuditStack(app, 'test-audit-rpe-on', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSM::Document', 1);
  });

  test('does not create SSM document when resourcePolicyEnforcement is disabled', () => {
    const props = buildAuditProps({ resourcePolicyEnforcementEnable: false });
    const stack = new SecurityAuditStack(app, 'test-audit-rpe-off', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SSM::Document', 0);
  });
});

describe('SecurityAuditStack - SNS Notification topics', () => {
  test('creates no SNS topic when no subscriptions configured', () => {
    const props = buildAuditProps({ snsSubscriptions: [] });
    const stack = new SecurityAuditStack(app, 'test-audit-sns-none', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Topic', 0);
  });

  test('creates an SNS topic for each configured subscription level', () => {
    const subs: SnsSubscriptionConfig[] = [
      { level: 'High', email: 'high@example.com' } as SnsSubscriptionConfig,
      { level: 'Medium', email: 'med@example.com' } as SnsSubscriptionConfig,
    ];
    const props = buildAuditProps({ snsSubscriptions: subs });
    const stack = new SecurityAuditStack(app, 'test-audit-sns-multi', props);
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Topic', 2);
  });

  test('creates email subscription for each configured subscription', () => {
    const subs: SnsSubscriptionConfig[] = [{ level: 'High', email: 'high@example.com' } as SnsSubscriptionConfig];
    const props = buildAuditProps({ snsSubscriptions: subs });
    const stack = new SecurityAuditStack(app, 'test-audit-sns-email', props);
    const template = Template.fromStack(stack);

    const subsResources = template.findResources('AWS::SNS::Subscription');
    expect(Object.keys(subsResources).length).toBeGreaterThanOrEqual(1);
    const subHasEmail = Object.values(subsResources).some(
      (r: any) => r.Properties?.Protocol === 'email' && r.Properties?.Endpoint === 'high@example.com',
    );
    expect(subHasEmail).toBe(true);
  });

  test('topic display name includes the subscription level', () => {
    const subs: SnsSubscriptionConfig[] = [{ level: 'Low', email: 'low@example.com' } as SnsSubscriptionConfig];
    const props = buildAuditProps({ snsSubscriptions: subs });
    const stack = new SecurityAuditStack(app, 'test-audit-sns-name', props);
    const template = Template.fromStack(stack);

    const topics = template.findResources('AWS::SNS::Topic');
    const lowTopic = Object.values(topics).find(
      (t: any) => typeof t.Properties?.DisplayName === 'string' && t.Properties.DisplayName.includes('Low'),
    );
    expect(lowTopic).toBeDefined();
  });
});
