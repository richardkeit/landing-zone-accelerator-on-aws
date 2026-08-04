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
  createStatusLogger,
  IManageAccountTagsHandlerParameter,
  manageAccountTags,
} from '../../../../../@aws-lza/index';
import { ModuleParams } from '../../../models/types';
import { processModulePromises } from '../../../../../@aws-lza/common/functions';

const statusLogger = createStatusLogger([path.parse(path.basename(__filename)).name]);

/**
 * An abstract class to manage AWS Accounts tags module
 *
 * @description
 * AWS Organizations account tags are applied through the AWS Organizations `TagResource`
 * API which is a global, management account operation. Unlike the account alias module,
 * this module does not assume a role into each member account. It executes from the
 * management account against the global AWS Organizations endpoint and tags each account
 * by its account id.
 */
export abstract class ManageAccountsTagsModule {
  /**
   * Function to invoke manage account tags module
   * @param params {@link ModuleParams}
   * @returns status string
   */
  public static async execute(params: ModuleParams): Promise<string> {
    const statuses: string[] = [];
    const promises: Promise<string>[] = [];

    const { accountsConfig, organizationConfig } = params.moduleRunnerParameters.configs;

    const ignoredOus = organizationConfig.getIgnoredOus();
    const activeAccountIds = accountsConfig.getActiveAccountIds(ignoredOus);

    const allAccounts = [...accountsConfig.mandatoryAccounts, ...accountsConfig.workloadAccounts];

    // Only include active accounts that have tags configured
    const activeAccountsWithTags = allAccounts
      .filter(account => activeAccountIds.includes(accountsConfig.getAccountId(account.name)))
      .filter(account => Array.isArray(account.tags) && account.tags.length > 0);

    if (activeAccountsWithTags.length === 0) {
      return `Skipping module "${params.moduleItem.name}" because no accounts have tags configured`;
    }

    for (const account of activeAccountsWithTags) {
      const accountId = accountsConfig.getAccountId(account.name);
      const input: IManageAccountTagsHandlerParameter = {
        moduleName: params.moduleItem.name,
        operation: 'manage-account-tags',
        partition: params.runnerParameters.partition,
        region: params.moduleRunnerParameters.configs.globalConfig.homeRegion,
        globalRegion: params.moduleRunnerParameters.globalRegion,
        useExistingRole: params.runnerParameters.useExistingRoles,
        solutionId: params.runnerParameters.solutionId,
        credentials: params.moduleRunnerParameters.managementAccountCredentials,
        dryRun: params.runnerParameters.dryRun,
        configuration: {
          accountId,
          tags: account.tags!.map(tag => ({ key: tag.key, value: tag.value })),
          removalPolicy: accountsConfig.accountTagRemovalPolicy ?? 'managed',
        },
      };

      // Log each per-account result through this module's status logger so every line is
      // clearly attributed to "manage-accounts-tags". The runner logs the aggregated module
      // return value as a single blob, where only the first line keeps a label, so the
      // per-account detail is emitted here and the return value is kept to a concise summary.
      promises.push(
        manageAccountTags(input).then(status => {
          statusLogger.info(`[${account.name}] ${status}`);
          return status;
        }),
      );
    }

    statusLogger.info(`Executing "${params.moduleItem.name}" module for ${activeAccountsWithTags.length} account(s).`);
    await processModulePromises(
      params.moduleItem.name,
      promises,
      statuses,
      params.runnerParameters.maxConcurrentExecution,
    );

    return `Module "${params.moduleItem.name}" completed successfully for ${activeAccountsWithTags.length} account(s)`;
  }
}
