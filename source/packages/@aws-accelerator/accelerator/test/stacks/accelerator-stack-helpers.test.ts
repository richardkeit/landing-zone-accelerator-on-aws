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
  DeploymentTargets,
  GuardDutyConfig,
  LifeCycleRule,
  S3EncryptionConfig,
  SecurityHubConfig,
  ServiceEncryptionConfig,
} from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SsmResourceType } from '@aws-accelerator/utils';
import { AcceleratorStack, AcceleratorStackProps } from '../../lib/stacks/accelerator-stack';
import { createAcceleratorStackProps } from './stack-props-test-helper';

class HelperTestStack extends AcceleratorStack {
  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);
  }

  public _isRegionExcluded(regions: string[]): boolean {
    return this.isRegionExcluded(regions);
  }
  public _isCmkEnabledServiceEncryption(config?: ServiceEncryptionConfig): boolean {
    return (this as any).isCmkEnabledServiceEncryption(config);
  }
  public _isCmkEnabledS3Encryption(config?: S3EncryptionConfig): boolean {
    return (this as any).isCmkEnabledS3Encryption(config);
  }
  public _getS3LifeCycleRules(rules?: LifeCycleRule[]) {
    return (this as any).getS3LifeCycleRules(rules);
  }
  public _getPrincipalOrgIdCondition(orgId: string | undefined) {
    return (this as any).getPrincipalOrgIdCondition(orgId);
  }
  public _convertMinutesToIso8601(s: number): string {
    return (this as any).convertMinutesToIso8601(s);
  }
  public _validateExcludeRegionsAndDeploymentTargets(cfg: SecurityHubConfig | GuardDutyConfig): boolean {
    return (this as any).validateExcludeRegionsAndDeploymentTargets(cfg);
  }
  public _accessLogsBucketEnabled(): boolean {
    return (this as any).accessLogsBucketEnabled();
  }
}

let app: cdk.App;
let stack: HelperTestStack;

function buildStack(overrides?: Partial<AcceleratorStackProps>) {
  app = new cdk.App();
  const props = { ...createAcceleratorStackProps(), ...overrides } as AcceleratorStackProps;
  stack = new HelperTestStack(app, `helper-test-${Math.random().toString(36).slice(2, 8)}`, props);
  return { app, stack, props };
}

beforeEach(() => {
  buildStack();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('isRegionExcluded', () => {
  test('returns false for empty region list', () => {
    expect(stack._isRegionExcluded([])).toBe(false);
  });

  test('returns false when region is not in the list', () => {
    expect(stack._isRegionExcluded(['eu-west-1', 'ap-south-1'])).toBe(false);
  });

  test('returns true when region matches', () => {
    expect(stack._isRegionExcluded(['us-east-1'])).toBe(true);
  });

  test('returns true when region is one of many', () => {
    expect(stack._isRegionExcluded(['eu-west-1', 'us-east-1', 'ap-south-1'])).toBe(true);
  });

  test('treats regions list as case-sensitive', () => {
    expect(stack._isRegionExcluded(['US-EAST-1'])).toBe(false);
  });
});

describe('getSsmPath', () => {
  test('prepends the configured ssm prefix', () => {
    const path = stack.getSsmPath(SsmResourceType.STACK_ID, ['MyStack']);
    expect(path.startsWith('/accelerator/')).toBe(true);
  });

  test('contains the replacement values in the path', () => {
    const path = stack.getSsmPath(SsmResourceType.STACK_ID, ['MyStack']);
    expect(path).toContain('MyStack');
  });

  test('is deterministic for the same input', () => {
    const a = stack.getSsmPath(SsmResourceType.STACK_ID, ['SomeStack']);
    const b = stack.getSsmPath(SsmResourceType.STACK_ID, ['SomeStack']);
    expect(a).toBe(b);
  });
});

describe('isCmkEnabledServiceEncryption', () => {
  test('returns true when encryption config is undefined (default CMK behavior)', () => {
    expect(stack._isCmkEnabledServiceEncryption(undefined)).toBe(true);
  });

  test('returns the useCMK value when no deployment targets provided', () => {
    expect(stack._isCmkEnabledServiceEncryption({ useCMK: true } as ServiceEncryptionConfig)).toBe(true);
    expect(stack._isCmkEnabledServiceEncryption({ useCMK: false } as ServiceEncryptionConfig)).toBe(false);
  });

  test('respects deployment targets when region is excluded', () => {
    const config = {
      useCMK: true,
      deploymentTargets: {
        organizationalUnits: ['Root'],
        excludedRegions: ['us-east-1'],
        accounts: [],
        excludedAccounts: [],
      } as DeploymentTargets,
    } as ServiceEncryptionConfig;
    // Stack is in us-east-1 -> excluded -> should be INVERSE of useCMK
    expect(stack._isCmkEnabledServiceEncryption(config)).toBe(false);
  });
});

describe('isCmkEnabledS3Encryption', () => {
  test('returns true when encryption config is undefined', () => {
    expect(stack._isCmkEnabledS3Encryption(undefined)).toBe(true);
  });

  test('returns createCMK value when no deployment targets', () => {
    expect(stack._isCmkEnabledS3Encryption({ createCMK: true } as S3EncryptionConfig)).toBe(true);
    expect(stack._isCmkEnabledS3Encryption({ createCMK: false } as S3EncryptionConfig)).toBe(false);
  });

  test('inverts createCMK when region is excluded by deploymentTargets', () => {
    const config = {
      createCMK: true,
      deploymentTargets: {
        organizationalUnits: ['Root'],
        excludedRegions: ['us-east-1'],
        accounts: [],
        excludedAccounts: [],
      } as DeploymentTargets,
    } as S3EncryptionConfig;
    expect(stack._isCmkEnabledS3Encryption(config)).toBe(false);
  });
});

describe('getS3LifeCycleRules', () => {
  // Helper that returns a fully-populated LifeCycleRule with sensible defaults,
  // overridable by the caller. Avoids TypeScript widening errors from partial
  // casts against the concrete LifeCycleRule class.
  const makeRule = (overrides: Partial<LifeCycleRule> = {}): LifeCycleRule => {
    const base: LifeCycleRule = {
      abortIncompleteMultipartUpload: 1,
      enabled: true,
      expiration: 1825,
      expiredObjectDeleteMarker: false,
      id: '',
      noncurrentVersionExpiration: 366,
      noncurrentVersionTransitions: [],
      transitions: [],
      prefix: undefined,
    };
    return { ...base, ...overrides };
  };

  test('returns empty array for undefined input', () => {
    expect(stack._getS3LifeCycleRules(undefined)).toEqual([]);
  });

  test('returns empty array for empty input', () => {
    expect(stack._getS3LifeCycleRules([])).toEqual([]);
  });

  test('maps a single rule with basic fields', () => {
    const rules: LifeCycleRule[] = [
      makeRule({
        enabled: true,
        expiration: 30,
        id: 'test',
        abortIncompleteMultipartUpload: 7,
        noncurrentVersionExpiration: 60,
        prefix: 'logs/',
      }),
    ];
    const result = stack._getS3LifeCycleRules(rules);
    expect(result.length).toBe(1);
    expect(result[0].enabled).toBe(true);
    expect(result[0].expiration).toBe(30);
    expect(result[0].id).toBe('test');
    expect(result[0].prefix).toBe('logs/');
  });

  test('maps noncurrent version transitions', () => {
    const rules: LifeCycleRule[] = [
      makeRule({
        id: 'tx',
        abortIncompleteMultipartUpload: 0,
        noncurrentVersionTransitions: [{ storageClass: 'GLACIER', transitionAfter: 90 }],
        transitions: [{ storageClass: 'STANDARD_IA', transitionAfter: 30 }],
      }),
    ];
    const result = stack._getS3LifeCycleRules(rules);
    expect(result[0].noncurrentVersionTransitions!.length).toBe(1);
    expect(result[0].noncurrentVersionTransitions![0].storageClass).toBe('GLACIER');
    expect(result[0].transitions!.length).toBe(1);
    expect(result[0].transitions![0].storageClass).toBe('STANDARD_IA');
  });

  test('maps two rules', () => {
    const rules: LifeCycleRule[] = [
      makeRule({ enabled: true, id: 'a', abortIncompleteMultipartUpload: 0 }),
      makeRule({ enabled: false, id: 'b', abortIncompleteMultipartUpload: 0 }),
    ];
    expect(stack._getS3LifeCycleRules(rules).length).toBe(2);
  });
});

describe('getPrincipalOrgIdCondition', () => {
  test('returns PrincipalOrgID when partition is aws and organization is enabled', () => {
    const result = stack._getPrincipalOrgIdCondition('o-1234567890');
    expect(result).toEqual({ 'aws:PrincipalOrgID': 'o-1234567890' });
  });

  test('falls back to PrincipalAccount list for aws-cn partition', () => {
    buildStack({ partition: 'aws-cn' });
    const result = stack._getPrincipalOrgIdCondition('o-1234567890');
    expect(result).toHaveProperty('aws:PrincipalAccount');
  });

  test('falls back to PrincipalAccount list when organization is disabled', () => {
    const props = createAcceleratorStackProps();
    (props.organizationConfig as any).enable = false;
    app = new cdk.App();
    stack = new HelperTestStack(app, 'helper-no-org', props);
    const result = stack._getPrincipalOrgIdCondition('o-1234567890');
    expect(result).toHaveProperty('aws:PrincipalAccount');
  });
});

describe('convertMinutesToIso8601', () => {
  test('converts 60 minutes to PT1H0M', () => {
    expect(stack._convertMinutesToIso8601(60)).toBe('PT1H0M');
  });

  test('converts less than 60 minutes to PT{n}M', () => {
    expect(stack._convertMinutesToIso8601(45)).toBe('PT45M');
  });

  test('converts 0 minutes to PT0M', () => {
    expect(stack._convertMinutesToIso8601(0)).toBe('PT0M');
  });

  test('converts 1440 minutes (1 day) to include days', () => {
    expect(stack._convertMinutesToIso8601(1440)).toBe('PT1D0M');
  });

  test('converts 90 minutes to include hours and minutes', () => {
    expect(stack._convertMinutesToIso8601(90)).toBe('PT1H30M');
  });

  test('converts 1500 minutes to include days, hours and minutes', () => {
    // 1500 min = 1 day + 60 min + 0 hours (because 60 min = 1 hr) = 1D 1H 0M
    expect(stack._convertMinutesToIso8601(1500)).toBe('PT1D1H0M');
  });
});

describe('validateExcludeRegionsAndDeploymentTargets', () => {
  test('returns false when disabled', () => {
    const config = { enable: false, excludeRegions: [] } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(false);
  });

  test('returns true when enabled with no excludeRegions list', () => {
    const config = { enable: true } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(true);
  });

  test('returns false when current region is in excludeRegions', () => {
    const config = { enable: true, excludeRegions: ['us-east-1'] } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(false);
  });

  test('returns true when current region is not in excludeRegions', () => {
    const config = { enable: true, excludeRegions: ['eu-west-1'] } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(true);
  });

  test('respects deploymentTargets.excludedRegions', () => {
    const config = {
      enable: true,
      deploymentTargets: { excludedRegions: ['us-east-1'] },
    } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(false);
  });

  test('returns true with deploymentTargets that do not exclude current region', () => {
    const config = {
      enable: true,
      deploymentTargets: { excludedRegions: ['eu-west-1'] },
    } as unknown as SecurityHubConfig;
    expect(stack._validateExcludeRegionsAndDeploymentTargets(config)).toBe(true);
  });
});

describe('accessLogsBucketEnabled', () => {
  test('returns true by default when no explicit config is provided', () => {
    expect(stack._accessLogsBucketEnabled()).toBe(true);
  });

  test('returns false when explicitly disabled', () => {
    const props = createAcceleratorStackProps();
    (props.globalConfig as any).logging.accessLogBucket = { enable: false };
    app = new cdk.App();
    stack = new HelperTestStack(app, 'helper-access-logs-off', props);
    expect(stack._accessLogsBucketEnabled()).toBe(false);
  });
});

describe('isIncluded', () => {
  test('returns false when current region is excluded', () => {
    const targets: DeploymentTargets = {
      excludedRegions: ['us-east-1'],
      excludedAccounts: [],
      organizationalUnits: ['Root'],
      accounts: [],
    };
    expect(stack.isIncluded(targets)).toBe(false);
  });

  test('returns false when deploymentTargets are entirely empty (implicit deny)', () => {
    const targets: DeploymentTargets = {
      excludedRegions: [],
      excludedAccounts: [],
      organizationalUnits: [],
      accounts: [],
    };
    expect(stack.isIncluded(targets)).toBe(false);
  });
});
