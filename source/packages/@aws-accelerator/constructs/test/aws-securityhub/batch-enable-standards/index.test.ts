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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import {
  DescribeStandardsCommand,
  DescribeStandardsControlsCommand,
  EnableSecurityHubCommand,
  GetEnabledStandardsCommand,
  SecurityHubClient,
  UpdateStandardsControlCommand,
} from '@aws-sdk/client-securityhub';
import { handler } from '../../../lib/aws-securityhub/batch-enable-standards/index';
import { CloudFormationCustomResourceCreateEvent } from '../../../lib/lza-custom-resource';

let securityHubMock: AwsClientStub<SecurityHubClient>;

// -- Test constants --

const FSBP_STANDARDS_ARN = 'arn:aws:securityhub:::standards/aws-foundational-security-best-practices/v/1.0.0';
const FSBP_SUBSCRIPTION_ARN =
  'arn:aws:securityhub:us-east-1:123456789012:subscription/aws-foundational-security-best-practices/v/1.0.0';

const CIS_V120_STANDARDS_ARN = 'arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0';
const CIS_V120_SUBSCRIPTION_ARN =
  'arn:aws:securityhub:us-east-1:123456789012:subscription/cis-aws-foundations-benchmark/v/1.2.0';

const CIS_V140_STANDARDS_ARN = 'arn:aws:securityhub:::standards/cis-aws-foundations-benchmark/v/1.4.0';
const CIS_V140_SUBSCRIPTION_ARN =
  'arn:aws:securityhub:us-east-1:123456789012:subscription/cis-aws-foundations-benchmark/v/1.4.0';

const PCI_STANDARDS_ARN = 'arn:aws:securityhub:::standards/pci-dss/v/3.2.1';
const PCI_SUBSCRIPTION_ARN = 'arn:aws:securityhub:us-east-1:123456789012:subscription/pci-dss/v/3.2.1';

/**
 * Helper to build a CloudFormation Create event with the given standards
 */
function createEvent(
  standards: { name: string; enable: string; controlsToDisable: string[] }[],
): CloudFormationCustomResourceCreateEvent {
  return {
    RequestType: 'Create',
    ResponseURL: 'https://example.com',
    ServiceToken: 'example-service-token',
    StackId: 'example-stack-id',
    RequestId: 'example-request-id',
    ResourceType: 'Custom::SecurityHubBatchEnableStandards',
    LogicalResourceId: 'example-logical-resource-id',
    ResourceProperties: {
      region: 'us-east-1',
      standards: standards,
      ServiceToken: 'example-service-token',
    },
  };
}

/**
 * Helper to set up the common mock responses for DescribeStandards and EnableSecurityHub
 */
function setupBaseMocks(): void {
  securityHubMock.on(EnableSecurityHubCommand).resolves({});

  securityHubMock.on(DescribeStandardsCommand).resolves({
    Standards: [
      { Name: 'AWS Foundational Security Best Practices v1.0.0', StandardsArn: FSBP_STANDARDS_ARN },
      { Name: 'CIS AWS Foundations Benchmark v1.2.0', StandardsArn: CIS_V120_STANDARDS_ARN },
      { Name: 'CIS AWS Foundations Benchmark v1.4.0', StandardsArn: CIS_V140_STANDARDS_ARN },
      { Name: 'PCI DSS v3.2.1', StandardsArn: PCI_STANDARDS_ARN },
    ],
  });
}

/**
 * Helper to create a StandardsSubscription mock object
 */
function createSubscription(standardsArn: string, subscriptionArn: string) {
  return {
    StandardsArn: standardsArn,
    StandardsSubscriptionArn: subscriptionArn,
    StandardsStatus: 'READY' as const,
    StandardsInput: {},
  };
}

// -- Tests --

describe('batch-enable-standards handler', () => {
  beforeEach(() => {
    securityHubMock = mockClient(SecurityHubClient);
  });

  afterEach(() => {
    securityHubMock.restore();
  });

  describe('controlsToDisable matching', () => {
    it('should disable FSBP controls when controlId matches exactly', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(FSBP_STANDARDS_ARN, FSBP_SUBSCRIPTION_ARN)],
      });

      // API returns ControlId like 'IAM.1', 'EC2.10'
      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          { ControlId: 'IAM.1', ControlStatus: 'ENABLED', StandardsControlArn: `${FSBP_SUBSCRIPTION_ARN}/IAM.1` },
          { ControlId: 'EC2.10', ControlStatus: 'ENABLED', StandardsControlArn: `${FSBP_SUBSCRIPTION_ARN}/EC2.10` },
          { ControlId: 'Lambda.4', ControlStatus: 'ENABLED', StandardsControlArn: `${FSBP_SUBSCRIPTION_ARN}/Lambda.4` },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      const event = createEvent([
        {
          name: 'AWS Foundational Security Best Practices v1.0.0',
          enable: 'true',
          controlsToDisable: ['IAM.1', 'EC2.10'],
        },
      ]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      expect(disableCalls).toHaveLength(2);
    });

    it('should disable CIS v1.2.0 controls when user provides CIS. prefix and API returns CIS. prefix', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(CIS_V120_STANDARDS_ARN, CIS_V120_SUBSCRIPTION_ARN)],
      });

      // CIS v1.2.0 API returns ControlId with CIS. prefix
      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          {
            ControlId: 'CIS.1.20',
            ControlStatus: 'ENABLED',
            StandardsControlArn: `${CIS_V120_SUBSCRIPTION_ARN}/CIS.1.20`,
          },
          {
            ControlId: 'CIS.1.22',
            ControlStatus: 'ENABLED',
            StandardsControlArn: `${CIS_V120_SUBSCRIPTION_ARN}/CIS.1.22`,
          },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      const event = createEvent([
        { name: 'CIS AWS Foundations Benchmark v1.2.0', enable: 'true', controlsToDisable: ['CIS.1.20', 'CIS.1.22'] },
      ]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      expect(disableCalls).toHaveLength(2);
    });

    it('should disable CIS v1.2.0 controls when user omits CIS. prefix but API returns CIS. prefix', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(CIS_V120_STANDARDS_ARN, CIS_V120_SUBSCRIPTION_ARN)],
      });

      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          {
            ControlId: 'CIS.1.20',
            ControlStatus: 'ENABLED',
            StandardsControlArn: `${CIS_V120_SUBSCRIPTION_ARN}/CIS.1.20`,
          },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      // BUG scenario: User provides '1.20' without CIS. prefix
      const event = createEvent([
        { name: 'CIS AWS Foundations Benchmark v1.2.0', enable: 'true', controlsToDisable: ['1.20'] },
      ]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      // Should still disable the control despite the prefix mismatch
      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      expect(disableCalls).toHaveLength(1);
    });

    it('should disable CIS v1.4.0 controls when user adds CIS. prefix but API returns numeric only', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(CIS_V140_STANDARDS_ARN, CIS_V140_SUBSCRIPTION_ARN)],
      });

      // CIS v1.4.0 API returns ControlId WITHOUT prefix: '1.17', '1.16'
      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          { ControlId: '1.17', ControlStatus: 'ENABLED', StandardsControlArn: `${CIS_V140_SUBSCRIPTION_ARN}/1.17` },
          { ControlId: '1.16', ControlStatus: 'ENABLED', StandardsControlArn: `${CIS_V140_SUBSCRIPTION_ARN}/1.16` },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      // BUG scenario: User provides 'CIS.1.17' with CIS. prefix
      const event = createEvent([
        { name: 'CIS AWS Foundations Benchmark v1.4.0', enable: 'true', controlsToDisable: ['CIS.1.17', 'CIS.1.16'] },
      ]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      // Should still disable the controls despite the prefix mismatch
      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      expect(disableCalls).toHaveLength(2);
    });

    it('should disable PCI controls when user omits PCI. prefix but API returns PCI. prefix', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(PCI_STANDARDS_ARN, PCI_SUBSCRIPTION_ARN)],
      });

      // PCI API returns ControlId with PCI. prefix
      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          {
            ControlId: 'PCI.IAM.3',
            ControlStatus: 'ENABLED',
            StandardsControlArn: `${PCI_SUBSCRIPTION_ARN}/PCI.IAM.3`,
          },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      // BUG scenario: User provides 'IAM.3' without PCI. prefix
      const event = createEvent([{ name: 'PCI DSS v3.2.1', enable: 'true', controlsToDisable: ['IAM.3'] }]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      expect(disableCalls).toHaveLength(1);
    });

    it('should re-enable controls that were previously disabled but are no longer in controlsToDisable', async () => {
      setupBaseMocks();

      securityHubMock.on(GetEnabledStandardsCommand).resolves({
        StandardsSubscriptions: [createSubscription(FSBP_STANDARDS_ARN, FSBP_SUBSCRIPTION_ARN)],
      });

      securityHubMock.on(DescribeStandardsControlsCommand).resolves({
        Controls: [
          { ControlId: 'IAM.1', ControlStatus: 'ENABLED', StandardsControlArn: `${FSBP_SUBSCRIPTION_ARN}/IAM.1` },
          { ControlId: 'EC2.10', ControlStatus: 'DISABLED', StandardsControlArn: `${FSBP_SUBSCRIPTION_ARN}/EC2.10` },
        ],
      });

      securityHubMock.on(UpdateStandardsControlCommand).resolves({});

      // Only IAM.1 should be disabled; EC2.10 is currently DISABLED but not in controlsToDisable
      const event = createEvent([
        { name: 'AWS Foundational Security Best Practices v1.0.0', enable: 'true', controlsToDisable: ['IAM.1'] },
      ]);

      const result = await handler(event);
      expect(result?.Status).toBe('Success');

      const updateCalls = securityHubMock.commandCalls(UpdateStandardsControlCommand);
      const disableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'DISABLED');
      const enableCalls = updateCalls.filter(call => call.args[0].input.ControlStatus === 'ENABLED');
      expect(disableCalls).toHaveLength(1);
      expect(enableCalls).toHaveLength(1);
    });
  });
});
