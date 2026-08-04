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

import { IModuleCommonParameter } from '../../common/resources';

/**
 * AWS Organizations account tag
 *
 * @description
 * A single tag key/value pair to apply to an account.
 */
export interface IAccountTag {
  /**
   * Tag key
   */
  readonly key: string;
  /**
   * Tag value
   */
  readonly value: string;
}

/**
 * Account tag removal policy
 *
 * @description
 * Controls which existing account tags the module removes when reconciling. Tags in the
 * configuration are always applied regardless of this value.
 *
 * - `managed` - Only remove tags the accelerator previously applied (tracked in the
 *   `accelerator:managed-tags` marker tag) that are no longer in the configuration. Tags
 *   applied outside the accelerator are left untouched.
 * - `authoritative` - Remove any tag present on the account but absent from the configuration,
 *   including tags applied outside the accelerator.
 * - `additive` - Never remove tags; only add or update.
 */
export type AccountTagRemovalPolicy = 'managed' | 'authoritative' | 'additive';

/**
 * AWS Organizations account tags management configuration
 *
 * @description
 * This is the essential inputs for API operation by this module
 *
 * @example
 *
 * ```
 * {
 *   accountId: '111111111111',
 *   tags: [
 *     { key: 'Environment', value: 'Production' },
 *     { key: 'CostCenter', value: 'Engineering' },
 *   ],
 *   removalPolicy: 'managed',
 * }
 * ```
 */
export interface IManageAccountTagsConfiguration {
  /**
   * The AWS account id to apply tags to
   *
   * @description
   * The account is tagged through the AWS Organizations `TagResource` API, therefore the
   * module must be invoked with credentials for the AWS Organizations management account.
   */
  readonly accountId: string;
  /**
   * The desired set of tags for the account
   *
   * @description
   * This is treated as the authoritative set of accelerator managed tags for the account.
   * Tags present on the account that were previously configured but are no longer present
   * here will be removed. Tags applied outside of the accelerator are not modified.
   *
   * @example
   * ```
   * [
   *   { key: 'Environment', value: 'Production' },
   *   { key: 'CostCenter', value: 'Engineering' },
   * ]
   * ```
   */
  readonly tags: IAccountTag[];
  /**
   * The policy governing which existing tags are removed during reconciliation
   *
   * @see {@link AccountTagRemovalPolicy}
   */
  readonly removalPolicy: AccountTagRemovalPolicy;
}

/**
 * AWS Organizations account tags management handler parameter
 */
export interface IManageAccountTagsHandlerParameter extends IModuleCommonParameter {
  /**
   * AWS account tags management configuration
   *
   * @example
   * ```
   * {
   *   accountId: '111111111111',
   *   tags: [
   *     { key: 'Environment', value: 'Production' },
   *   ],
   * }
   * ```
   */
  configuration: IManageAccountTagsConfiguration;
}

/**
 * AWS Organizations account tags management Module interface
 *
 */
export interface IManageAccountTagsModule {
  /**
   * Handler function to manage AWS account tags
   *
   * @param props {@link IManageAccountTagsHandlerParameter}
   * @returns status string indicating the result(s) of the operation
   *
   */
  handler(props: IManageAccountTagsHandlerParameter): Promise<string>;
}
