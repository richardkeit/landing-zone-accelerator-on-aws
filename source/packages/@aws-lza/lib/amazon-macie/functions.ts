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
 * @fileoverview Amazon Macie Core Functions - Basic Macie service operations
 *
 * Provides core Amazon Macie service operations including enabling, disabling,
 * status checking, and administrative account management. These functions handle
 * the fundamental Macie API operations with proper error handling and validation.
 *
 * Key capabilities:
 * - Macie service enablement and disablement
 * - Service status validation and monitoring
 * - Organization admin account listing
 * - Asynchronous operation completion waiting
 * - Comprehensive error handling for Macie operations
 */

import {
  AccessDeniedException,
  AdminAccount,
  ConflictException,
  DisableMacieCommand,
  EnableMacieCommand,
  GetMacieSessionCommand,
  Macie2Client,
  MacieStatus,
  paginateListOrganizationAdminAccounts,
} from '@aws-sdk/client-macie2';
import { InvalidInputException, OrganizationsClient } from '@aws-sdk/client-organizations';
import { AssumeRoleCredentialType } from '../common/interfaces';
import { getDelegatedAdministratorAccountId } from '../common/organizations-functions';
import { executeApi, setRetryStrategy, waitUntil } from '../common/utility';

import path from 'node:path';
import { createLogger } from '../common/logger';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Enables Amazon Macie service in the current account and region
 * @param client - Macie2 client instance
 * @param dryRun - Whether to perform dry run without making changes
 * @param logPrefix - Prefix for logging messages
 * @returns Promise that resolves when Macie is enabled
 */
export async function enableMacie(client: Macie2Client, dryRun: boolean, logPrefix: string): Promise<void> {
  const commandName = 'EnableMacieCommand';
  const parameters = { status: MacieStatus.ENABLED };
  if (dryRun) {
    logger.dryRun(commandName, parameters, logPrefix);
    return;
  }

  try {
    await executeApi(
      commandName,
      parameters,
      () => client.send(new EnableMacieCommand(parameters)),
      logger,
      logPrefix,
      [ConflictException],
    );
  } catch (error: unknown) {
    // Macie is enabled per-region both as a standalone target and via organization auto-enable, so concurrent
    // environments can race to enable the same account/region. A ConflictException means Macie is already
    // enabled (the desired state), so treat it as success and skip the post-enable confirmation poll.
    if (error instanceof ConflictException) {
      logger.warn(`${error.name}: ${error.message} - Macie is already enabled, treating as success`, logPrefix);
      return;
    }
    throw error;
  }

  logger.info(`Waiting for Macie to be enabled`, logPrefix);

  await waitUntil(
    () => {
      return isMacieEnabled(client, logPrefix);
    },
    'Could not get confirmation that macie was enabled',
    logger,
    logPrefix,
  );
}

/**
 * Checks if Amazon Macie is enabled in the current account and region
 * @param client - Macie2 client instance
 * @param logPrefix - Prefix for logging messages
 * @returns Promise resolving to true if Macie is enabled
 */
export async function isMacieEnabled(client: Macie2Client, logPrefix: string): Promise<boolean> {
  try {
    const response = await executeApi(
      'GetMacieSessionCommand',
      {},
      () => client.send(new GetMacieSessionCommand({})),
      logger,
      logPrefix,
      [AccessDeniedException],
    );
    return response.status === MacieStatus.ENABLED;
  } catch (error: unknown) {
    // When Macie is not enabled, throws an AccessDeniedException
    if (error instanceof AccessDeniedException) {
      return false;
    }
    throw error;
  }
}

/**
 * Disables Amazon Macie service in the current account and region
 * @param client - Macie2 client instance
 * @param dryRun - Whether to perform dry run without making changes
 * @param logPrefix - Prefix for logging messages
 * @returns Promise that resolves when Macie is disabled
 */
export async function disableMacie(client: Macie2Client, dryRun: boolean, logPrefix: string): Promise<void> {
  const commandName = 'DisableMacieCommand';
  const parameters = {};
  if (dryRun) {
    logger.dryRun(commandName, parameters, logPrefix);
    return;
  }

  await executeApi(commandName, parameters, () => client.send(new DisableMacieCommand(parameters)), logger, logPrefix);
}

/**
 * Lists all organization admin accounts for Amazon Macie
 * @param client - Macie2 client instance
 * @param logPrefix - Prefix for logging messages
 * @returns Promise resolving to array of admin accounts
 */
export async function listAdminAccounts(client: Macie2Client, logPrefix: string): Promise<AdminAccount[]> {
  const adminAccounts: AdminAccount[] = [];
  const commandName = 'paginateListOrganizationAdminAccounts';
  const parameters = {};
  logger.commandExecution(commandName, parameters, logPrefix);
  const paginator = paginateListOrganizationAdminAccounts({ client }, {});
  for await (const page of paginator) {
    for (const account of page.adminAccounts ?? []) {
      adminAccounts.push(account);
    }
  }
  logger.commandSuccess(commandName, parameters, logPrefix);
  return adminAccounts;
}

/**
 * Macie service principal used for Organizations API calls
 */
export const MACIE_SERVICE_NAME = 'macie.amazonaws.com';

/**
 * Checks if Amazon Macie is available in the current partition by attempting
 * to query the Organizations API with the Macie service principal.
 *
 * In partitions where Macie is not available (e.g., GovCloud), the Organizations API
 * throws InvalidInputException with "You specified an unrecognized service principal"
 * when attempting to list delegated administrators for macie.amazonaws.com.
 *
 * @param props - Properties for the availability check
 * @param props.region - AWS region for the Organizations API call (should be global region)
 * @param props.solutionId - Solution identifier for user agent
 * @param props.credentials - AWS credentials for the API call
 * @param logPrefix - Prefix for logging messages
 * @returns Promise resolving to true if Macie is available in the partition, false otherwise
 */
export async function isMacieAvailableInPartition(
  props: {
    region: string;
    solutionId?: string;
    credentials?: AssumeRoleCredentialType;
  },
  logPrefix: string,
): Promise<boolean> {
  const client = new OrganizationsClient({
    region: props.region,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  try {
    await getDelegatedAdministratorAccountId(client, MACIE_SERVICE_NAME, logPrefix);
    return true;
  } catch (error: unknown) {
    if (error instanceof InvalidInputException && error.message?.includes('unrecognized service principal')) {
      logger.info(`Macie is not available in this partition: ${error.message}`, logPrefix);
      return false;
    }
    throw error;
  }
}
