import { generateBucketPolicy } from '../index';
import { AcceleratorImportedBucketType, AwsPrincipalAccessesType } from '@aws-accelerator/utils';
import { describe, expect, test } from 'vitest';

interface PolicyStatement {
  Sid?: string;
  Effect: string;
  Action: string[];
  Principal: Record<string, string | string[]>;
  Resource: string[];
  Condition?: Record<string, Record<string, string>>;
}

describe('generateBucketPolicy', () => {
  const firewallRoles: string[] = [];
  const applyAcceleratorManagedPolicy = 'true';
  const partition = 'aws';
  const sourceAccount = '111111111111';
  const bucketArn = 'arn:aws:s3:::test-bucket';
  const bucketPolicyFilePaths: string[] = [];
  const principalOrgIdCondition = { 'aws:PrincipalOrgID': '${ORG_ID}' };
  const awsPrincipalAccesses: AwsPrincipalAccessesType[] = [];

  test('should use service principal for ELB access logging', () => {
    const bucketType = AcceleratorImportedBucketType.ELB_LOGS_BUCKET;

    const policy = generateBucketPolicy(
      firewallRoles,
      applyAcceleratorManagedPolicy,
      partition,
      sourceAccount,
      bucketType,
      bucketArn,
      bucketPolicyFilePaths,
      principalOrgIdCondition,
      awsPrincipalAccesses,
    );

    const policyObj = JSON.parse(policy);

    const elbStatement = policyObj.Statement.find(
      (statement: PolicyStatement) => statement.Sid === 'Allow write access for ELB Account principal',
    );

    expect(elbStatement).toBeDefined();
    expect(elbStatement.Effect).toBe('Allow');
    expect(elbStatement.Action).toContain('s3:PutObject');
    expect(elbStatement.Principal.Service).toContain('logdelivery.elasticloadbalancing.amazonaws.com');
    expect(elbStatement.Principal.AWS).toBeUndefined();
  });

  test('should not include ELB account principal for non-ELB bucket types', () => {
    const bucketType = AcceleratorImportedBucketType.CENTRAL_LOGS_BUCKET;

    const policy = generateBucketPolicy(
      firewallRoles,
      applyAcceleratorManagedPolicy,
      partition,
      sourceAccount,
      bucketType,
      bucketArn,
      bucketPolicyFilePaths,
      principalOrgIdCondition,
      awsPrincipalAccesses,
    );

    const policyObj = JSON.parse(policy);

    const elbStatement = policyObj.Statement.find(
      (statement: PolicyStatement) => statement.Sid === 'Allow write access for ELB Account principal',
    );

    expect(elbStatement).toBeUndefined();
  });
});
