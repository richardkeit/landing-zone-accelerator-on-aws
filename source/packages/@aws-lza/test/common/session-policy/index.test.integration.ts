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

/**
 * @fileoverview Integration test for session policy enforcement on AssumeRole.
 *
 * Verifies that:
 * 1. getCredentials() correctly passes session policy to STS
 * 2. Allowed actions succeed with scoped credentials
 * 3. Disallowed actions return AccessDenied
 *
 * Prerequisites:
 *   - AWS credentials available (any account with sts:AssumeRole permission)
 *   - A role that trusts the current principal (e.g., OrganizationAccountAccessRole)
 *   - Environment variables: INTEGRATION_TEST_ROLE_ARN, AWS_DEFAULT_REGION
 *
 * Run: npx vitest run test/common/session-policy.test.integration.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EC2Client, DescribeRegionsCommand, DescribeTransitGatewaysCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { getCredentials } from '../../../lib/common/sts-functions';

const ROLE_ARN = process.env['INTEGRATION_TEST_ROLE_ARN'];
const REGION = process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';

// Session policy that ONLY allows ec2:DescribeRegions and sts:GetCallerIdentity
const RESTRICTIVE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowedActions',
      Effect: 'Allow',
      Action: ['ec2:DescribeRegions', 'sts:GetCallerIdentity'],
      Resource: '*',
    },
  ],
});

describe('Session Policy Integration', () => {
  beforeAll(() => {
    if (!ROLE_ARN) {
      console.log('Skipping: INTEGRATION_TEST_ROLE_ARN not set');
    }
  });

  it('should assume role with session policy and restrict actions', async () => {
    if (!ROLE_ARN) return;

    // Assume role WITH session policy
    const credentials = await getCredentials({
      accountId: ROLE_ARN.split(':')[4],
      region: REGION,
      logPrefix: 'IntegTest',
      assumeRoleArn: ROLE_ARN,
      sessionName: 'SessionPolicyIntegTest',
      sessionPolicy: RESTRICTIVE_POLICY,
    });

    expect(credentials).toBeDefined();
    expect(credentials!.accessKeyId).toBeDefined();
    expect(credentials!.secretAccessKey).toBeDefined();
    expect(credentials!.sessionToken).toBeDefined();
  });

  it('should allow ec2:DescribeRegions with scoped credentials', async () => {
    if (!ROLE_ARN) return;

    const credentials = await getCredentials({
      accountId: ROLE_ARN.split(':')[4],
      region: REGION,
      logPrefix: 'IntegTest',
      assumeRoleArn: ROLE_ARN,
      sessionName: 'SessionPolicyIntegTest',
      sessionPolicy: RESTRICTIVE_POLICY,
    });

    const ec2 = new EC2Client({ region: REGION, credentials: credentials! });
    const response = await ec2.send(new DescribeRegionsCommand({}));
    expect(response.Regions).toBeDefined();
    expect(response.Regions!.length).toBeGreaterThan(0);
  });

  it('should DENY ec2:DescribeTransitGateways with scoped credentials', async () => {
    if (!ROLE_ARN) return;

    const credentials = await getCredentials({
      accountId: ROLE_ARN.split(':')[4],
      region: REGION,
      logPrefix: 'IntegTest',
      assumeRoleArn: ROLE_ARN,
      sessionName: 'SessionPolicyIntegTest',
      sessionPolicy: RESTRICTIVE_POLICY,
    });

    const ec2 = new EC2Client({ region: REGION, credentials: credentials! });

    await expect(ec2.send(new DescribeTransitGatewaysCommand({}))).rejects.toThrow(
      /AccessDenied|UnauthorizedOperation|not authorized/,
    );
  });

  it('should DENY s3:ListBuckets with scoped credentials', async () => {
    if (!ROLE_ARN) return;

    const credentials = await getCredentials({
      accountId: ROLE_ARN.split(':')[4],
      region: REGION,
      logPrefix: 'IntegTest',
      assumeRoleArn: ROLE_ARN,
      sessionName: 'SessionPolicyIntegTest',
      sessionPolicy: RESTRICTIVE_POLICY,
    });

    const s3 = new S3Client({ region: REGION, credentials: credentials! });

    await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
  });

  it('should work without session policy (backward compatibility)', async () => {
    if (!ROLE_ARN) return;

    // Assume role WITHOUT session policy — should have full permissions
    const credentials = await getCredentials({
      accountId: ROLE_ARN.split(':')[4],
      region: REGION,
      logPrefix: 'IntegTest',
      assumeRoleArn: ROLE_ARN,
      sessionName: 'NoSessionPolicyTest',
    });

    expect(credentials).toBeDefined();

    // Without session policy, DescribeTransitGateways should succeed
    const ec2 = new EC2Client({ region: REGION, credentials: credentials! });
    const response = await ec2.send(new DescribeTransitGatewaysCommand({}));
    expect(response.TransitGateways).toBeDefined();
  });
});
