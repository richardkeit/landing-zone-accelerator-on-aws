/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
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
import { AcceleratorSynthStacks } from './accelerator-synth-stacks';
import { AcceleratorStage } from '../lib/accelerator-stage';

const testNamePrefix = 'Construct(FinalizeStack): ';

const acceleratorTestStacks = new AcceleratorSynthStacks(AcceleratorStage.FINALIZE, 'all-enabled', 'aws');
const stack = acceleratorTestStacks.stacks.get(`Management-us-east-1`)!;

/**
 * FinalizeStack construct test
 */
describe('FinalizeStack', () => {
  /**
   * Number of SSM parameters resource test
   */
  test(`${testNamePrefix} SSM parameters resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::SSM::Parameter', 2);
  });

  /**
   * Number of IAM Role resource test
   */
  test(`${testNamePrefix} IAM Role resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::IAM::Role', 1);
  });

  /**
   * Number of Lambda Function resource test
   */
  test(`${testNamePrefix} Lambda Function resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::Lambda::Function', 1);
  });

  /**
   * Number of Cloudwatch Log groups test
   */
  test(`${testNamePrefix} CloudWatch Log Group resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  test(`${testNamePrefix} Detach Quarantinee custom resource configuration test`, () => {
    cdk.assertions.Template.fromStack(stack).templateMatches({
      Resources: {
        CustomDetachQuarantineScpCustomResourceProviderHandlerA1F1C263: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Handler: '__entrypoint__.handler',
            MemorySize: 128,
            Role: {
              'Fn::GetAtt': ['CustomDetachQuarantineScpCustomResourceProviderRoleE5C433C1', 'Arn'],
            },
            Runtime: 'nodejs14.x',
            Timeout: 900,
          },
        },
      },
    });
  });
});
