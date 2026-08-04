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

import path from 'path';
import {
  DescribeAccountCommand,
  ListTagsForResourceCommand,
  OrganizationsClient,
  Tag,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-organizations';

import {
  AccountTagRemovalPolicy,
  IAccountTag,
  IManageAccountTagsHandlerParameter,
  IManageAccountTagsModule,
} from '../../../interfaces/aws-organizations/manage-account-tags';
import { createLogger } from '../../../common/logger';
import { MODULE_EXCEPTIONS } from '../../../common/enums';
import { throttlingBackOff } from '../../../common/throttle';
import { AcceleratorModuleName } from '../../../common/resources';
import { setRetryStrategy, generateDryRunResponse, getModuleDefaultParameters } from '../../../common/functions';

/**
 * Marker tag key used to track the set of tag keys the accelerator manages on an account.
 * Its value is a sorted, delimited list of the accelerator managed tag keys.
 */
const MANAGED_TAGS_MARKER_KEY = 'accelerator:managed-tags';

/**
 * Delimiter used to join managed tag keys in the marker tag value.
 *
 * @description
 * AWS Organizations tag values only permit the characters matched by
 * {@link ORG_TAG_PATTERN} (a comma is not allowed), so `+` is used as the separator. A key
 * that itself contains a `+` degrades safely: on read it is split into fragments that do not
 * match any real tag key, so nothing is ever removed erroneously (at worst a dropped key is
 * not cleaned up).
 */
const MANAGED_TAGS_DELIMITER = '+';

/**
 * Maximum length of an AWS Organizations tag value.
 */
const MAX_TAG_VALUE_LENGTH = 256;

/**
 * Allowed character pattern for AWS Organizations tag keys and values.
 *
 * @see https://docs.aws.amazon.com/organizations/latest/APIReference/API_Tag.html
 */
const ORG_TAG_PATTERN = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

/**
 * ManageAccountTags class to manage AWS Organizations account tags
 *
 * @description
 * AWS Organizations tags are managed from the management account against the global
 * AWS Organizations endpoint. The tags provided in the configuration are always applied
 * (added or updated). Which existing tags are removed is governed by the configured
 * {@link AccountTagRemovalPolicy | removal policy}:
 * - `managed` - Only tags the accelerator previously applied (tracked in the
 *   `accelerator:managed-tags` marker tag) and no longer desired are removed. Foreign tags
 *   are never touched.
 * - `authoritative` - Any tag not present in the configuration is removed.
 * - `additive` - No tags are ever removed.
 */
export class ManageAccountTags implements IManageAccountTagsModule {
  private readonly logger = createLogger([path.parse(path.basename(__filename)).name]);

  /**
   * Handler function to manage AWS account tags
   *
   * The following activities are performed by this function:
   * - Validate the tag keys and values against AWS requirements
   * - Return early with validation errors for both dry run and live execution
   * - Read the current tags applied to the account
   * - Apply new or changed tags and remove tags that are no longer desired
   *
   * @param props - Handler parameters containing tag configuration and credentials
   * @returns Promise resolving to a status message describing the operations performed
   */
  async handler(props: IManageAccountTagsHandlerParameter): Promise<string> {
    const defaultProps = getModuleDefaultParameters(AcceleratorModuleName.AWS_ORGANIZATIONS, props);
    const { accountId, tags, removalPolicy } = props.configuration;

    const validationResult = this.validateTags(tags);

    const client = new OrganizationsClient({
      region: defaultProps.globalRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    const currentTags = await this.getCurrentAccountTags(client, accountId);
    const { tagsToApply, tagsToRemove, markerSkipped } = this.calculateTagChanges(tags, currentTags, removalPolicy);

    if (markerSkipped) {
      this.logger.warn(
        `The "${MANAGED_TAGS_MARKER_KEY}" marker for account "${accountId}" would exceed the ${MAX_TAG_VALUE_LENGTH} character tag value limit; skipping managed tag removal for this account. Configured tags are still applied.`,
      );
    }

    if (defaultProps.dryRun) {
      return this.getDryRunResponse(
        defaultProps.moduleName,
        props.operation,
        accountId,
        tagsToApply,
        tagsToRemove,
        validationResult.errorStatus,
      );
    }

    if (!validationResult.isValid && validationResult.errorStatus) {
      return validationResult.errorStatus;
    }

    // Verify account exists and is accessible before making changes
    await this.assertAccountExists(client, accountId);

    const statuses: string[] = [];
    await this.applyTags(client, accountId, tagsToApply, statuses);
    await this.removeTags(client, accountId, tagsToRemove, statuses);

    if (statuses.length === 0) {
      const message = `No tag changes required for account "${accountId}"`;
      this.logger.info(message);
      statuses.push(message);
    }

    return statuses.join('\n');
  }

  /**
   * Validates the desired tags against AWS Organizations tagging requirements
   *
   * @see https://docs.aws.amazon.com/organizations/latest/userguide/orgs_tagging.html
   *
   * @param tags - Desired account tags
   * @returns Validation result object with isValid flag and optional error status
   */
  private validateTags(tags: IAccountTag[]): { isValid: boolean; errorStatus?: string } {
    if (tags.length > 50) {
      return this.invalidTags(`a maximum of 50 tags are allowed per account, received ${tags.length}`);
    }

    const seenKeys = new Set<string>();
    for (const tag of tags) {
      if (!tag.key || tag.key.length < 1 || tag.key.length > 128) {
        return this.invalidTags(`tag key "${tag.key}" must be between 1 and 128 characters`);
      }
      if (tag.value === undefined || tag.value.length > 256) {
        return this.invalidTags(`tag value for key "${tag.key}" must be 256 characters or fewer`);
      }
      if (tag.key.toLowerCase().startsWith('aws:')) {
        return this.invalidTags(`tag key "${tag.key}" must not start with the reserved "aws:" prefix`);
      }
      if (!ORG_TAG_PATTERN.test(tag.key)) {
        return this.invalidTags(
          `tag key "${tag.key}" contains unsupported characters (allowed: letters, numbers, whitespace and _.:/=+-@)`,
        );
      }
      if (!ORG_TAG_PATTERN.test(tag.value)) {
        return this.invalidTags(
          `tag value "${tag.value}" for key "${tag.key}" contains unsupported characters (allowed: letters, numbers, whitespace and _.:/=+-@)`,
        );
      }
      if (seenKeys.has(tag.key)) {
        return this.invalidTags(`duplicate tag key "${tag.key}" is not allowed`);
      }
      seenKeys.add(tag.key);
    }

    return { isValid: true };
  }

  /**
   * Builds an invalid tag validation result and logs the reason
   *
   * @param reason - Human readable validation failure reason
   * @returns Validation result with isValid false and a formatted error status
   */
  private invalidTags(reason: string): { isValid: boolean; errorStatus: string } {
    const errorStatus = `${MODULE_EXCEPTIONS.INVALID_INPUT}: Invalid account tags - ${reason}`;
    this.logger.error(`Invalid account tags - ${reason}`);
    return { isValid: false, errorStatus };
  }

  /**
   * Calculates the tags that need to be applied and removed to reconcile the account
   * to the desired state, honouring the configured removal policy.
   *
   * @param desiredTags - Desired account tags
   * @param currentTags - Tags currently applied to the account keyed by tag key
   * @param removalPolicy - Policy governing which existing tags may be removed
   * @returns Object containing tags to apply, tag keys to remove, and whether the managed
   * marker had to be skipped (managed policy only)
   */
  private calculateTagChanges(
    desiredTags: IAccountTag[],
    currentTags: { [key: string]: string },
    removalPolicy: AccountTagRemovalPolicy,
  ): { tagsToApply: Tag[]; tagsToRemove: string[]; markerSkipped: boolean } {
    const desiredKeys = new Set(desiredTags.map(tag => tag.key));

    // Tags to add or update, only where the value differs from what already exists
    const tagsToApply: Tag[] = desiredTags
      .filter(tag => currentTags[tag.key] !== tag.value)
      .map(tag => ({ Key: tag.key, Value: tag.value }));

    let tagsToRemove: string[] = [];
    let markerSkipped = false;

    switch (removalPolicy) {
      case 'additive':
        // Never remove tags
        break;

      case 'authoritative':
        // Remove any tag not desired, except our own bookkeeping marker
        tagsToRemove = Object.keys(currentTags).filter(key => key !== MANAGED_TAGS_MARKER_KEY && !desiredKeys.has(key));
        break;

      case 'managed': {
        // Only remove tags the accelerator previously managed and no longer desires
        const previouslyManaged = this.parseManagedKeys(currentTags[MANAGED_TAGS_MARKER_KEY]);
        tagsToRemove = previouslyManaged.filter(key => !desiredKeys.has(key) && key in currentTags);

        // Maintain the marker so it reflects the current desired key set
        const markerValue = [...desiredKeys].sort().join(MANAGED_TAGS_DELIMITER);
        if (markerValue.length > MAX_TAG_VALUE_LENGTH) {
          // The managed key list cannot be persisted within the tag value limit. Degrade to
          // additive for this account rather than send an invalid request or lose track of state.
          markerSkipped = true;
          tagsToRemove = [];
        } else if (currentTags[MANAGED_TAGS_MARKER_KEY] !== markerValue) {
          tagsToApply.push({ Key: MANAGED_TAGS_MARKER_KEY, Value: markerValue });
        }
        break;
      }
    }

    return { tagsToApply, tagsToRemove, markerSkipped };
  }

  /**
   * Parses the comma separated managed key list stored in the marker tag value
   *
   * @param markerValue - Raw marker tag value, or undefined when no marker exists
   * @returns Array of tag keys the accelerator previously managed
   */
  private parseManagedKeys(markerValue?: string): string[] {
    if (!markerValue) {
      return [];
    }
    return markerValue
      .split(MANAGED_TAGS_DELIMITER)
      .map(key => key.trim())
      .filter(key => key.length > 0);
  }

  /**
   * Generates dry run response showing what operations would be performed
   *
   * @param moduleName - Module name for dry run response
   * @param operation - Operation name for dry run response
   * @param accountId - Target account id
   * @param tagsToApply - Tags that would be applied
   * @param tagsToRemove - Tag keys that would be removed
   * @param validationErrorStatus - Validation error, when the desired tags are invalid
   * @returns Dry run status message describing planned operations
   */
  private getDryRunResponse(
    moduleName: string,
    operation: string,
    accountId: string,
    tagsToApply: Tag[],
    tagsToRemove: string[],
    validationErrorStatus?: string,
  ): string {
    if (validationErrorStatus) {
      return generateDryRunResponse(moduleName, operation, `Will experience ${validationErrorStatus}`);
    }

    // Exclude the internal bookkeeping marker from the user facing plan
    const applyKeys = tagsToApply.map(tag => tag.Key).filter(key => key !== MANAGED_TAGS_MARKER_KEY);

    if (applyKeys.length === 0 && tagsToRemove.length === 0) {
      return generateDryRunResponse(
        moduleName,
        operation,
        `Account "${accountId}" tags are already up to date, no changes required`,
      );
    }

    const messages: string[] = [];
    if (applyKeys.length > 0) {
      messages.push(`apply tags [${applyKeys.join(', ')}]`);
    }
    if (tagsToRemove.length > 0) {
      messages.push(`remove tags [${tagsToRemove.join(', ')}]`);
    }

    return generateDryRunResponse(moduleName, operation, `Will ${messages.join(' and ')} for account "${accountId}"`);
  }

  /**
   * Verifies that the target account exists and is accessible
   *
   * @param client - Configured Organizations client
   * @param accountId - Target account id
   * @throws Error when the account cannot be described
   */
  private async assertAccountExists(client: OrganizationsClient, accountId: string): Promise<void> {
    try {
      await throttlingBackOff(() => client.send(new DescribeAccountCommand({ AccountId: accountId })));
    } catch (error) {
      throw new Error(
        `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Account "${accountId}" not found or not accessible: ${error}`,
      );
    }
  }

  /**
   * Retrieves the current tags applied to the account from AWS Organizations
   *
   * @param client - Configured Organizations client
   * @param accountId - Target account id
   * @returns Promise resolving to a map of tag key to tag value
   */
  private async getCurrentAccountTags(
    client: OrganizationsClient,
    accountId: string,
  ): Promise<{ [key: string]: string }> {
    const tags: { [key: string]: string } = {};
    let nextToken: string | undefined = undefined;
    do {
      const response = await throttlingBackOff(() =>
        client.send(new ListTagsForResourceCommand({ ResourceId: accountId, NextToken: nextToken })),
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

  /**
   * Applies new or changed tags to the account
   *
   * @param client - Configured Organizations client
   * @param accountId - Target account id
   * @param tagsToApply - Tags to apply
   * @param statuses - Array to collect status messages
   */
  private async applyTags(
    client: OrganizationsClient,
    accountId: string,
    tagsToApply: Tag[],
    statuses: string[],
  ): Promise<void> {
    if (tagsToApply.length === 0) {
      return;
    }

    try {
      await throttlingBackOff(() => client.send(new TagResourceCommand({ ResourceId: accountId, Tags: tagsToApply })));
    } catch (error) {
      const keys = tagsToApply.map(tag => tag.Key).join(', ');
      throw new Error(
        `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Failed to apply tags [${keys}] to account "${accountId}": ${error}`,
      );
    }

    // Report only the user facing tags; the managed marker is internal bookkeeping
    const appliedKeys = tagsToApply.map(tag => tag.Key).filter(key => key !== MANAGED_TAGS_MARKER_KEY);
    if (appliedKeys.length === 0) {
      return;
    }

    const message = `Successfully applied ${appliedKeys.length} tag(s) [${appliedKeys.join(
      ', ',
    )}] to account "${accountId}"`;
    this.logger.info(message);
    statuses.push(message);
  }

  /**
   * Removes tags that are no longer desired from the account
   *
   * @param client - Configured Organizations client
   * @param accountId - Target account id
   * @param tagsToRemove - Tag keys to remove
   * @param statuses - Array to collect status messages
   */
  private async removeTags(
    client: OrganizationsClient,
    accountId: string,
    tagsToRemove: string[],
    statuses: string[],
  ): Promise<void> {
    if (tagsToRemove.length === 0) {
      return;
    }

    try {
      await throttlingBackOff(() =>
        client.send(new UntagResourceCommand({ ResourceId: accountId, TagKeys: tagsToRemove })),
      );
    } catch (error) {
      throw new Error(
        `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Failed to remove tags [${tagsToRemove.join(
          ', ',
        )}] from account "${accountId}": ${error}`,
      );
    }

    const message = `Successfully removed ${tagsToRemove.length} tag(s) [${tagsToRemove.join(
      ', ',
    )}] from account "${accountId}"`;
    this.logger.info(message);
    statuses.push(message);
  }
}
