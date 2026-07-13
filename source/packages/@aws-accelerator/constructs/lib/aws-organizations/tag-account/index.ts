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
 * aws-organizations-tag-account - lambda handler
 *
 * @param event
 * @returns
 */

import { setOrganizationsClient } from '@aws-accelerator/utils/lib/set-organizations-client';
import { throttlingBackOff } from '@aws-accelerator/utils/lib/throttle';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';
import {
  DescribeAccountCommand,
  ListTagsForResourceCommand,
  OrganizationsClient,
  Tag,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-organizations';

export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Status: string;
    }
  | undefined
> {
  console.log(JSON.stringify(event, null, 2));

  const accountId: string = event.ResourceProperties['accountId'];
  const partition: string = event.ResourceProperties['partition'];
  const solutionId = process.env['SOLUTION_ID'];

  // Organizations is a global service. The client is configured for the correct global region based on partition.
  const organizationsClient = setOrganizationsClient(partition, solutionId);

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      const newTags: { [key: string]: string } = event.ResourceProperties['tags'] ?? {};
      const oldTags: { [key: string]: string } =
        event.RequestType === 'Update' ? event.OldResourceProperties['tags'] ?? {} : {};
      await manageAccountTags(organizationsClient, accountId, newTags, oldTags);
      return {
        PhysicalResourceId: `account-tag-${accountId}`,
        Status: 'SUCCESS',
      };

    case 'Delete':
      // We don't remove tags on delete as the account may continue to exist outside of the LZA
      console.log(`Delete event - leaving account tags unchanged for account ${accountId}`);
      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}

async function manageAccountTags(
  organizationsClient: OrganizationsClient,
  accountId: string,
  newTags: { [key: string]: string },
  oldTags: { [key: string]: string },
) {
  console.log(`Managing tags for account ${accountId}`);
  console.log(`New tags:`, newTags);
  console.log(`Old tags:`, oldTags);

  // Verify account exists and is accessible
  try {
    await throttlingBackOff(() => organizationsClient.send(new DescribeAccountCommand({ AccountId: accountId })));
  } catch (error) {
    throw new Error(`Account ${accountId} not found or not accessible: ${error}`);
  }

  // Get current tags from Organizations
  const currentTags = await getCurrentAccountTags(organizationsClient, accountId);
  console.log(`Current tags from Organizations:`, currentTags);

  // Determine tags to add/update (only where the value differs from what already exists)
  const tagsToApply: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(newTags)) {
    if (currentTags[key] !== value) {
      tagsToApply[key] = value;
    }
  }

  // Determine tags to remove (previously configured tags that are no longer in the config)
  const tagsToRemove: string[] = [];
  for (const key of Object.keys(oldTags)) {
    if (!(key in newTags) && key in currentTags) {
      tagsToRemove.push(key);
    }
  }

  // Apply new/updated tags
  if (Object.keys(tagsToApply).length > 0) {
    console.log(`Applying tags:`, tagsToApply);
    const tags: Tag[] = Object.entries(tagsToApply).map(([key, value]) => ({ Key: key, Value: value }));

    await throttlingBackOff(() =>
      organizationsClient.send(
        new TagResourceCommand({
          ResourceId: accountId,
          Tags: tags,
        }),
      ),
    );
    console.log(`Successfully applied ${tags.length} tags to account ${accountId}`);
  }

  // Remove tags that are no longer needed
  if (tagsToRemove.length > 0) {
    console.log(`Removing tags:`, tagsToRemove);
    await throttlingBackOff(() =>
      organizationsClient.send(
        new UntagResourceCommand({
          ResourceId: accountId,
          TagKeys: tagsToRemove,
        }),
      ),
    );
    console.log(`Successfully removed ${tagsToRemove.length} tags from account ${accountId}`);
  }

  if (Object.keys(tagsToApply).length === 0 && tagsToRemove.length === 0) {
    console.log(`No tag changes needed for account ${accountId}`);
  }
}

async function getCurrentAccountTags(
  organizationsClient: OrganizationsClient,
  accountId: string,
): Promise<{ [key: string]: string }> {
  const tags: { [key: string]: string } = {};
  let nextToken: string | undefined = undefined;
  do {
    const response = await throttlingBackOff(() =>
      organizationsClient.send(
        new ListTagsForResourceCommand({
          ResourceId: accountId,
          NextToken: nextToken,
        }),
      ),
    );
    for (const tag of response.Tags ?? []) {
      if (tag.Key && tag.Value !== undefined) {
        tags[tag.Key] = tag.Value;
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return tags;
}
