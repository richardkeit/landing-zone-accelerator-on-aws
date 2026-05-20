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

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { AcceleratorStage } from '../../../lib/accelerator-stage';
import { Create } from '../../accelerator-test-helpers';

// Regression test for github issue #1089: in v2 network stacks, a CloudWatch
// VPC flow log was created even when the user opted out of CloudWatch in the
// vpcFlowLogs.destinations list. The Network-FlowLogsS3Only-V2 VPC in the
// snapshot-only config sets destinations: [s3] only, so the synthesized v2
// VPC stack must contain exactly one AWS::EC2::FlowLog (s3) and zero with
// LogDestinationType cloud-watch-logs.
describe('NetworkVpcV2FlowLogs assertions', () => {
  const stackKey = 'VpcStack-Network-us-east-1-Network-FlowLogsS3Only-V2';
  let template: Template;

  beforeAll(() => {
    const testDir = path.join(__dirname, '../..');
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (typeof filePath === 'string' && filePath.startsWith('cfn-templates')) {
        const correctedPath = path.join(testDir, filePath);
        return originalReadFileSync(correctedPath, ...args);
      }
      return originalReadFileSync(filePath, ...args);
    });

    const stacks = Create.stacks(AcceleratorStage.NETWORK_VPC);
    stacks.synthV2NetworkVpcStacks();
    const stack = stacks.stacks.get(stackKey) as Stack | undefined;
    expect(stack).toBeDefined();
    template = Template.fromStack(stack!);
    vi.restoreAllMocks();
  });

  it('synthesizes exactly one AWS::EC2::FlowLog', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  it('synthesizes the s3 flow log destination', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      LogDestinationType: 's3',
    });
  });

  it('does not synthesize a cloud-watch-logs flow log destination', () => {
    const cwlFlowLogs = Object.values(template.findResources('AWS::EC2::FlowLog')).filter(
      r => r.Properties?.LogDestinationType === 'cloud-watch-logs',
    );
    expect(cwlFlowLogs).toHaveLength(0);
  });

  it('does not synthesize a CloudWatch flow log group for the VPC', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
  });
});
