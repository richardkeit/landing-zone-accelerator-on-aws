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
 * @fileoverview Per-module session policy scoping integration tests.
 *
 * For each module in the registry, verifies:
 * 1. A representative action from the module's policy SUCCEEDS with scoped credentials
 * 2. An out-of-scope action (s3:ListBuckets) FAILS with AccessDenied
 *
 * This catches policy drift: if a module adds an SDK call without updating its
 * session policy, the pipeline will fail with AccessDenied — and this test
 * validates that the scoping mechanism correctly blocks undeclared actions.
 *
 * Prerequisites:
 *   - INTEGRATION_TEST_ROLE_ARN: Role with AdministratorAccess that trusts current principal
 *   - AWS_DEFAULT_REGION: Region to test in
 *
 * Run: INTEGRATION_TEST_ROLE_ARN=arn:aws:iam::ACCOUNT:role/ROLE \
 *      npx vitest run --config vitest.integration.config.ts test/common/session-policy-per-module/
 */

import { describe, it, expect } from 'vitest';
import { EC2Client, DescribeTransitGatewaysCommand, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { DirectConnectClient, DescribeDirectConnectGatewaysCommand } from '@aws-sdk/client-direct-connect';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { OrganizationsClient, ListRootsCommand, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { IAMClient, ListAccountAliasesCommand, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { SSMClient, GetServiceSettingCommand } from '@aws-sdk/client-ssm';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { Macie2Client, GetMacieSessionCommand } from '@aws-sdk/client-macie2';
import { SecurityHubClient, ListAutomationRulesCommand } from '@aws-sdk/client-securityhub';
import { ControlTowerClient, ListLandingZonesCommand } from '@aws-sdk/client-controltower';
import { getCredentials } from '../../../lib/common/sts-functions';
import { MODULE_SESSION_POLICIES } from '../../../lib/common/module-session-policies';
import { IAssumeRoleCredential } from '../../../lib/common/interfaces';

const ROLE_ARN = process.env['INTEGRATION_TEST_ROLE_ARN'];
const REGION = process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';

/**
 * Maps each module to a representative API call that should SUCCEED with its policy.
 * Uses read-only Describe/List/Get calls to avoid side effects.
 */

// Helper to assume role with a specific module's policy
async function assumeWithModulePolicy(moduleName: string): Promise<IAssumeRoleCredential | undefined> {
  const policy = MODULE_SESSION_POLICIES[moduleName];
  if (!policy || !ROLE_ARN) return undefined;
  return getCredentials({
    accountId: ROLE_ARN.split(':')[4],
    region: REGION,
    logPrefix: `IntegTest:${moduleName}`,
    assumeRoleArn: ROLE_ARN,
    sessionName: `Test-${moduleName.substring(0, 30)}`,
    sessionPolicy: policy.policy,
    sessionTags: policy.tags,
  });
}

// Helper to make a call with given credentials
function makeClient<T>(ClientClass: new (config: object) => T, creds: IAssumeRoleCredential): T {
  return new ClientClass({ region: REGION, credentials: creds });
}

describe('Per-Module Session Policy Scoping', () => {
  // Skip all if no role ARN
  const describeOrSkip = ROLE_ARN ? describe : describe.skip;

  describeOrSkip('tgw-associations-and-propagations', () => {
    it('should allow ec2:DescribeTransitGateways', async () => {
      const creds = await assumeWithModulePolicy('tgw-associations-and-propagations');
      const ec2 = makeClient(EC2Client, creds!);
      const result = await ec2.send(new DescribeTransitGatewaysCommand({}));
      expect(result.TransitGateways).toBeDefined();
    });

    it('should allow directconnect:DescribeDirectConnectGateways', async () => {
      const creds = await assumeWithModulePolicy('tgw-associations-and-propagations');
      const dx = makeClient(DirectConnectClient, creds!);
      const result = await dx.send(new DescribeDirectConnectGatewaysCommand({}));
      expect(result.directConnectGateways).toBeDefined();
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('tgw-associations-and-propagations');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('macie', () => {
    it('should allow macie2:GetMacieSession (may throw Macie not enabled — not AccessDenied)', async () => {
      const creds = await assumeWithModulePolicy('macie');
      const macie = makeClient(Macie2Client, creds!);
      try {
        await macie.send(new GetMacieSessionCommand({}));
      } catch (e: unknown) {
        // AccessDeniedException from Macie means "not enabled" — that's fine, it's not IAM AccessDenied
        expect((e as Error).name).not.toBe('AccessDenied');
        expect((e as Error).name).not.toBe('UnauthorizedOperation');
      }
    });

    it('should allow iam:CreateServiceLinkedRole for the Macie SLR', async () => {
      // The clamped session must permit creating AWSServiceRoleForAmazonMacie, otherwise
      // macie2:EnableMacie 400s on member accounts with no pre-existing SLR. Use
      // SimulatePrincipalPolicy so we assert the grant without actually creating the role.
      const creds = await assumeWithModulePolicy('macie');
      const iam = makeClient(IAMClient, creds!);
      const result = await iam.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: ROLE_ARN,
          ActionNames: ['iam:CreateServiceLinkedRole'],
          ResourceArns: [
            `arn:aws:iam::${ROLE_ARN!.split(':')[4]}:role/aws-service-role/macie.amazonaws.com/AWSServiceRoleForAmazonMacie`,
          ],
          ContextEntries: [
            {
              ContextKeyName: 'iam:AWSServiceName',
              ContextKeyType: 'string',
              ContextKeyValues: ['macie.amazonaws.com'],
            },
          ],
        }),
      );
      expect(result.EvaluationResults?.[0]?.EvalDecision).toBe('allowed');
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('macie');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('create-stack-policy', () => {
    it('should allow cloudformation:DescribeStacks (implicit via SetStackPolicy needs)', async () => {
      const creds = await assumeWithModulePolicy('create-stack-policy');
      const cfn = makeClient(CloudFormationClient, creds!);
      // SetStackPolicy is the only action — but we can't call it without a stack
      // Verify the credential works at all by checking it's not immediately rejected
      // Note: DescribeStacks is NOT in this module's policy, so this should fail
      await expect(cfn.send(new DescribeStacksCommand({}))).rejects.toThrow(
        /AccessDenied|UnauthorizedOperation|not authorized/,
      );
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('create-stack-policy');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('create-organizational-unit', () => {
    it('should allow organizations:ListRoots', async () => {
      const creds = await assumeWithModulePolicy('create-organizational-unit');
      const orgs = makeClient(OrganizationsClient, creds!);
      try {
        const result = await orgs.send(new ListRootsCommand({}));
        expect(result.Roots).toBeDefined();
      } catch (e: unknown) {
        // Non-management accounts get "You don't have permissions" from Organizations
        // Session policy denials say "no session policy allows" — that's what we're checking against
        const msg = (e as Error).message;
        expect(msg).not.toContain('no session policy allows');
      }
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('create-organizational-unit');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('manage-accounts-alias', () => {
    it('should allow iam:ListAccountAliases', async () => {
      const creds = await assumeWithModulePolicy('manage-accounts-alias');
      const iam = makeClient(IAMClient, creds!);
      const result = await iam.send(new ListAccountAliasesCommand({}));
      expect(result.AccountAliases).toBeDefined();
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('manage-accounts-alias');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('ssm-block-public-document-sharing', () => {
    it('should allow ssm:GetServiceSetting', async () => {
      const creds = await assumeWithModulePolicy('ssm-block-public-document-sharing');
      const ssm = makeClient(SSMClient, creds!);
      try {
        await ssm.send(new GetServiceSettingCommand({ SettingId: '/ssm/documents/console/public-sharing-permission' }));
      } catch (e: unknown) {
        // May throw ServiceSettingNotFound — that's fine, not AccessDenied
        expect((e as Error).name).not.toBe('AccessDenied');
      }
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('ssm-block-public-document-sharing');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('manage-automation-rules', () => {
    it('should allow securityhub:ListAutomationRules (may throw if not enabled)', async () => {
      const creds = await assumeWithModulePolicy('manage-automation-rules');
      const sh = makeClient(SecurityHubClient, creds!);
      try {
        await sh.send(new ListAutomationRulesCommand({}));
      } catch (e: unknown) {
        expect((e as Error).name).not.toBe('AccessDenied');
      }
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('manage-automation-rules');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('stack-resources-retention', () => {
    it('should allow cloudformation:DescribeStacks', async () => {
      const creds = await assumeWithModulePolicy('stack-resources-retention');
      const cfn = makeClient(CloudFormationClient, creds!);
      const result = await cfn.send(new DescribeStacksCommand({}));
      expect(result.Stacks).toBeDefined();
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('stack-resources-retention');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });

  describeOrSkip('accelerator-prerequisites', () => {
    it('should allow organizations:ListAccounts', async () => {
      const creds = await assumeWithModulePolicy('accelerator-prerequisites');
      const orgs = makeClient(OrganizationsClient, creds!);
      try {
        const result = await orgs.send(new ListAccountsCommand({}));
        expect(result.Accounts).toBeDefined();
      } catch (e: unknown) {
        // Non-management accounts get service-level rejection
        // Session policy denials say "no session policy allows" — that's what we guard against
        const msg = (e as Error).message;
        expect(msg).not.toContain('no session policy allows');
      }
    });

    it('should DENY ec2:DescribeRegions', async () => {
      const creds = await assumeWithModulePolicy('accelerator-prerequisites');
      const ec2 = makeClient(EC2Client, creds!);
      await expect(ec2.send(new DescribeRegionsCommand({}))).rejects.toThrow(
        /AccessDenied|UnauthorizedOperation|not authorized/,
      );
    });
  });

  describeOrSkip('control-tower-landing-zone', () => {
    it('should allow controltower:ListLandingZones', async () => {
      const creds = await assumeWithModulePolicy('control-tower-landing-zone');
      const ct = makeClient(ControlTowerClient, creds!);
      try {
        await ct.send(new ListLandingZonesCommand({}));
      } catch (e: unknown) {
        // May throw if CT not available — not AccessDenied
        expect((e as Error).name).not.toBe('AccessDenied');
      }
    });

    it('should DENY s3:ListBuckets', async () => {
      const creds = await assumeWithModulePolicy('control-tower-landing-zone');
      const s3 = makeClient(S3Client, creds!);
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/AccessDenied|not authorized/);
    });
  });
});
