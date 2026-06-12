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

import { setRetryStrategy } from '@aws-accelerator/utils/lib/common-functions';
import { delay, throttlingBackOff } from '@aws-accelerator/utils/lib/throttle';
import { ListResourcesCommand, RAMClient } from '@aws-sdk/client-ram';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';

const MAX_ATTEMPTS = 6;

/**
 * get-resource-share-item - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Data: {
        arn: string;
      };
      Status: string;
    }
  | {
      PhysicalResourceId: string | undefined;
      Status: string;
    }
  | undefined
> {
  const ramClient = new RAMClient({
    customUserAgent: process.env['SOLUTION_ID'],
    retryStrategy: setRetryStrategy(),
  });

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      const resourceOwner = event.ResourceProperties['resourceOwner'];
      const resourceShareArn = event.ResourceProperties['resourceShareArn'];
      const resourceType = event.ResourceProperties['resourceType'];

      // RAM resource associations are eventually consistent: a CFN-CREATE_COMPLETE
      // resource share may not yet have its resources visible to ListResources.
      // Retry with exponential-ish backoff (0, 1, 4, 9, 16, 25 s) before giving up.
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await delay(attempt ** 2 * 1000);

        let nextToken: string | undefined = undefined;
        do {
          const page = await throttlingBackOff(() =>
            ramClient.send(
              new ListResourcesCommand({
                resourceShareArns: [resourceShareArn],
                resourceType,
                resourceOwner,
                nextToken,
              }),
            ),
          );
          // Return the first item found with the specified filters
          if (page.resources && page.resources.length > 0) {
            const item = page.resources[0];
            if (item.arn) {
              console.log(item.arn);
              return {
                PhysicalResourceId: item.arn.split('/')[1],
                Data: {
                  arn: item.arn,
                },
                Status: 'SUCCESS',
              };
            }
          }
          nextToken = page.nextToken;
        } while (nextToken);

        console.log(`Resource share item not found on attempt ${attempt + 1}/${MAX_ATTEMPTS}, retrying`);
      }

      throw new Error(`Resource share item not found after ${MAX_ATTEMPTS} attempts`);

    case 'Delete':
      // Do Nothing
      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}
