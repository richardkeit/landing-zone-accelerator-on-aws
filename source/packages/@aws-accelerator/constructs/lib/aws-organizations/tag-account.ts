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

import { CUSTOM_RESOURCE_PROVIDER_RUNTIME } from '@aws-accelerator/utils/lib/lambda';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Account tag properties
 */
export interface AccountTagProps {
  /**
   * Account ID to tag
   */
  readonly accountId: string;
  /**
   * Tags to apply to the account
   */
  readonly tags: { [key: string]: string };
  /**
   * Custom resource lambda log group encryption key, when undefined default AWS managed key will be used
   */
  readonly kmsKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource lambda log retention in days
   */
  readonly logRetentionInDays: number;
}

/**
 * Class to manage AWS Organizations Account Tags
 */
export class AccountTag extends cdk.Resource {
  constructor(scope: Construct, id: string, props: AccountTagProps) {
    super(scope, id);

    const ACCOUNT_TAG_TYPE = 'Custom::AccountTag';

    const provider = cdk.CustomResourceProvider.getOrCreateProvider(this, ACCOUNT_TAG_TYPE, {
      codeDirectory: path.join(__dirname, 'tag-account/dist'),
      runtime: CUSTOM_RESOURCE_PROVIDER_RUNTIME,
      policyStatements: [
        {
          Effect: 'Allow',
          Action: [
            'organizations:TagResource',
            'organizations:UntagResource',
            'organizations:ListTagsForResource',
            'organizations:DescribeAccount',
          ],
          Resource: '*',
        },
      ],
    });

    new cdk.CustomResource(this, 'Resource', {
      resourceType: ACCOUNT_TAG_TYPE,
      serviceToken: provider.serviceToken,
      properties: {
        accountId: props.accountId,
        tags: props.tags,
        partition: cdk.Aws.PARTITION,
      },
    });

    /**
     * Singleton pattern to define the log group for the singleton function
     * in the stack
     */
    const stack = cdk.Stack.of(scope);
    const logGroup = stack.node.tryFindChild(`${provider.node.id}LogGroup`) as cdk.aws_logs.LogGroup;
    if (!logGroup) {
      new cdk.aws_logs.LogGroup(stack, `${provider.node.id}LogGroup`, {
        logGroupName: `/aws/lambda/${(provider.node.findChild('Handler') as cdk.aws_lambda.Function).functionName}`,
        retention: props.logRetentionInDays,
        encryptionKey: props.kmsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
  }
}
