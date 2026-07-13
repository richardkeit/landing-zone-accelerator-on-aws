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

import {
  DescribeAccountCommand,
  ListTagsForResourceCommand,
  OrganizationsClient,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-organizations';

interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  ResourceType: string;
  LogicalResourceId: string;
  ResourceProperties: {
    accountId: string;
    tags: { [key: string]: string };
    partition?: string;
  };
  OldResourceProperties?: {
    tags?: { [key: string]: string };
  };
}

const solutionId = process.env['SOLUTION_ID'] ?? '';

let organizationsClient: OrganizationsClient;

export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      Status: string;
      StatusReason?: string;
    }
  | undefined
> {
  console.log(JSON.stringify(event, null, 2));

  const partition = event.ResourceProperties.partition ?? 'aws';
  const globalRegion = partition === 'aws' ? 'us-east-1' : 'us-gov-east-1';

  organizationsClient = new OrganizationsClient({
    region: globalRegion,
    customUserAgent: solutionId,
  });

  const accountId = event.ResourceProperties.accountId;
  const newTags: { [key: string]: string } = event.ResourceProperties.tags || {};

  try {
    switch (event.RequestType) {
      case 'Create':
      case 'Update':
        const oldTags =
          event.RequestType === 'Update' && event.OldResourceProperties ? event.OldResourceProperties.tags || {} : {};
        await handleCreateOrUpdate(accountId, newTags, oldTags);
        break;

      case 'Delete':
        await handleDelete(accountId);
        break;
    }

    return {
      Status: 'SUCCESS',
    };
  } catch (error) {
    console.error('Error managing account tags:', error);
    return {
      Status: 'FAILED',
      StatusReason: `Failed to manage account tags: ${error}`,
    };
  }
}

async function handleCreateOrUpdate(
  accountId: string,
  newTags: { [key: string]: string },
  oldTags: { [key: string]: string },
) {
  console.log(`Managing tags for account ${accountId}`);
  console.log(`New tags:`, newTags);
  console.log(`Old tags:`, oldTags);

  // Verify account exists
  try {
    await organizationsClient.send(new DescribeAccountCommand({ AccountId: accountId }));
  } catch (error) {
    throw new Error(`Account ${accountId} not found or not accessible: ${error}`);
  }

  // Get current tags from Organizations
  const currentTags = await getCurrentAccountTags(accountId);
  console.log(`Current tags from Organizations:`, currentTags);

  // Determine tags to add/update
  const tagsToApply: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(newTags)) {
    if (currentTags[key] !== value) {
      tagsToApply[key] = value;
    }
  }

  // Determine tags to remove (tags that were in old config but not in new config)
  const tagsToRemove: string[] = [];
  for (const key of Object.keys(oldTags)) {
    if (!(key in newTags) && key in currentTags) {
      tagsToRemove.push(key);
    }
  }

  // Apply new/updated tags
  if (Object.keys(tagsToApply).length > 0) {
    console.log(`Applying tags:`, tagsToApply);
    const tags = Object.entries(tagsToApply).map(([key, value]) => ({ Key: key, Value: value }));

    await organizationsClient.send(
      new TagResourceCommand({
        ResourceId: accountId,
        Tags: tags,
      }),
    );
    console.log(`Successfully applied ${tags.length} tags to account ${accountId}`);
  }

  // Remove tags that are no longer needed
  if (tagsToRemove.length > 0) {
    console.log(`Removing tags:`, tagsToRemove);
    await organizationsClient.send(
      new UntagResourceCommand({
        ResourceId: accountId,
        TagKeys: tagsToRemove,
      }),
    );
    console.log(`Successfully removed ${tagsToRemove.length} tags from account ${accountId}`);
  }

  if (Object.keys(tagsToApply).length === 0 && tagsToRemove.length === 0) {
    console.log(`No tag changes needed for account ${accountId}`);
  }
}

async function handleDelete(accountId: string) {
  console.log(`Delete event - leaving account tags unchanged for account ${accountId}`);
  // We don't remove tags on delete as they may be managed by other resources
  // or the account may continue to exist outside of the LZA
}

async function getCurrentAccountTags(accountId: string): Promise<{ [key: string]: string }> {
  try {
    const response = await organizationsClient.send(
      new ListTagsForResourceCommand({
        ResourceId: accountId,
      }),
    );

    const tags: { [key: string]: string } = {};
    for (const tag of response.Tags || []) {
      if (tag.Key && tag.Value !== undefined) {
        tags[tag.Key] = tag.Value;
      }
    }
    return tags;
  } catch (error) {
    console.warn(`Could not retrieve tags for account ${accountId}:`, error);
    return {};
  }
}
