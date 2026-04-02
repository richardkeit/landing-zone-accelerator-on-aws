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
 * @fileoverview Amazon Macie Member Management - Organization member account operations
 *
 * Provides comprehensive member account management for Amazon Macie in AWS Organizations.
 * Handles member account creation, deletion, association, and organization-wide auto-enablement
 * configuration with proper state management and error handling.
 *
 * Key capabilities:
 * - Organization member account enablement and disablement
 * - Member account lifecycle management (create, delete, associate)
 * - Organization auto-enablement configuration
 * - Member relationship status handling
 * - Bulk member operations with proper sequencing
 */

import {
  AccessDeniedException,
  CreateMemberCommand,
  DeleteMemberCommand,
  DescribeOrganizationConfigurationCommand,
  DisassociateMemberCommand,
  Macie2Client,
  Member,
  paginateListMembers,
  RelationshipStatus,
  UpdateOrganizationConfigurationCommand,
} from '@aws-sdk/client-macie2';
import { Account } from '@aws-sdk/client-organizations';
import path from 'node:path';
import { DEFAULT_MEMBER_BATCH_SIZE } from '../common/constants';
import { createLogger } from '../common/logger';
import { executeApi, processInBatches } from '../common/utility';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Abstract class for managing Amazon Macie member accounts in AWS Organizations
 */
export abstract class MacieMembers {
  /**
   * Enables Macie for all organization accounts and configures auto-enablement
   * @param client - Macie2 client instance
   * @param organizationAccounts - List of organization accounts to enable
   * @param adminAccountId - Administrator account ID
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when all accounts are enabled
   */
  public static async enable(
    client: Macie2Client,
    organizationAccounts: Account[],
    adminAccountId: string,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const existingMembers = await this.listMembers(client, logPrefix, dryRun);

    await this.processOrganizationAccounts(
      client,
      organizationAccounts,
      adminAccountId,
      existingMembers,
      dryRun,
      logPrefix,
    );

    await this.enableOrganizationAutoEnable(client, dryRun, logPrefix);
  }

  /**
   * Processes all organization accounts for Macie member enablement
   * @param client - Macie2 client instance
   * @param organizationAccounts - List of organization accounts to process
   * @param adminAccountId - Administrator account ID
   * @param existingMembers - List of existing Macie members
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when all accounts are processed
   */
  private static async processOrganizationAccounts(
    client: Macie2Client,
    organizationAccounts: Account[],
    adminAccountId: string,
    existingMembers: Member[],
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const accountsToProcess = organizationAccounts.filter(account => account.Id && account.Id !== adminAccountId);

    const batchSize = process.env['MAX_MEMBER_BATCH_SIZE']
      ? Number(process.env['MAX_MEMBER_BATCH_SIZE'])
      : DEFAULT_MEMBER_BATCH_SIZE;

    logger.info(`Processing ${accountsToProcess.length} organization accounts in batches of ${batchSize}`, logPrefix);

    await processInBatches(
      accountsToProcess,
      batchSize,
      async account => {
        const existingMember = existingMembers.find(member => member.accountId === account.Id);
        await this.handleMemberAccount(client, account, existingMember, dryRun, logPrefix);
      },
      logger,
      logPrefix,
    );
  }

  /**
   * Handles individual member account enablement including cleanup and creation
   * @param client - Macie2 client instance
   * @param account - Organization account to process
   * @param existingMember - Existing member record if any
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when account is handled
   */
  private static async handleMemberAccount(
    client: Macie2Client,
    account: Account,
    existingMember: Member | undefined,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    // Delete removed members before recreating
    if (existingMember?.relationshipStatus === RelationshipStatus.Removed) {
      await this.deleteMember(client, account.Id!, dryRun, logPrefix);
    }

    // Create member if it doesn't exist or was removed
    if (!existingMember || existingMember.relationshipStatus === RelationshipStatus.Removed) {
      await this.createMember(client, account.Id!, account.Email!, dryRun, logPrefix);
    }
  }

  /**
   * Deletes a Macie member account
   * @param client - Macie2 client instance
   * @param accountId - Account ID to delete
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when member is deleted
   */
  private static async deleteMember(
    client: Macie2Client,
    accountId: string,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    if (dryRun) {
      logger.dryRun('DeleteMemberCommand', { id: accountId }, logPrefix);
    } else {
      await executeApi(
        'DeleteMemberCommand',
        { id: accountId },
        () => client.send(new DeleteMemberCommand({ id: accountId })),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Creates a new Macie member account
   * @param client - Macie2 client instance
   * @param accountId - Account ID to create
   * @param email - Account email address
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when member is created
   */
  private static async createMember(
    client: Macie2Client,
    accountId: string,
    email: string,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    if (dryRun) {
      logger.dryRun('CreateMemberCommand', { accountId, email }, logPrefix);
    } else {
      await executeApi(
        'CreateMemberCommand',
        { accountId, email },
        () =>
          client.send(
            new CreateMemberCommand({
              account: { accountId, email },
            }),
          ),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Enables organization-wide auto-enablement for Macie if not already enabled
   * @param client - Macie2 client instance
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when auto-enablement is configured
   */
  private static async enableOrganizationAutoEnable(
    client: Macie2Client,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const autoEnabled = await this.isOrganizationAutoEnabled(client, logPrefix);
    if (autoEnabled) {
      return;
    }

    if (dryRun) {
      logger.dryRun('UpdateOrganizationConfigurationCommand', { autoEnable: true }, logPrefix);
    } else {
      await executeApi(
        'UpdateOrganizationConfigurationCommand',
        { autoEnable: true },
        () => client.send(new UpdateOrganizationConfigurationCommand({ autoEnable: true })),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Disables Macie for all organization members and disables auto-enablement
   * @param client - Macie2 client instance
   * @param organizationAccounts - List of organization accounts
   * @param adminAccountId - Administrator account ID
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when all members are disabled
   */
  public static async disable(
    client: Macie2Client,
    organizationAccounts: Account[],
    adminAccountId: string,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const existingMembers = await this.listMembers(client, logPrefix, dryRun);
    const orgAccountCount = organizationAccounts.filter(acc => acc.Id !== adminAccountId).length;

    const membersToRemove = existingMembers.filter(member => member.accountId && member.accountId !== adminAccountId);

    const batchSize = process.env['MAX_MEMBER_BATCH_SIZE']
      ? Number(process.env['MAX_MEMBER_BATCH_SIZE'])
      : DEFAULT_MEMBER_BATCH_SIZE;

    logger.info(
      `Found ${membersToRemove.length} existing Macie members and ${orgAccountCount} organization accounts (excluding admin). Removing members in batches of ${batchSize}.`,
      logPrefix,
    );

    await processInBatches(
      membersToRemove,
      batchSize,
      async member => {
        if (dryRun) {
          logger.dryRun('DisassociateMemberCommand', { id: member.accountId }, logPrefix);
          logger.dryRun('DeleteMemberCommand', { id: member.accountId }, logPrefix);
        } else {
          await executeApi(
            'DisassociateMemberCommand',
            { id: member.accountId },
            () => client.send(new DisassociateMemberCommand({ id: member.accountId })),
            logger,
            logPrefix,
          );

          await executeApi(
            'DeleteMemberCommand',
            { id: member.accountId },
            () => client.send(new DeleteMemberCommand({ id: member.accountId })),
            logger,
            logPrefix,
          );
        }
      },
      logger,
      logPrefix,
    );

    const autoEnabled = await this.isOrganizationAutoEnabled(client, logPrefix);
    if (autoEnabled) {
      if (dryRun) {
        logger.dryRun('UpdateOrganizationConfigurationCommand', { autoEnable: false }, logPrefix);
      } else {
        await executeApi(
          'UpdateOrganizationConfigurationCommand',
          { autoEnable: false },
          () => client.send(new UpdateOrganizationConfigurationCommand({ autoEnable: false })),
          logger,
          logPrefix,
        );
      }
    }
  }

  /**
   * Lists all Macie members including associated and disassociated accounts
   * @param client - Macie2 client instance
   * @param logPrefix - Prefix for logging messages
   * @param dryRun - Whether this is a dry run operation
   * @returns Promise resolving to array of member accounts
   */
  private static async listMembers(client: Macie2Client, logPrefix: string, dryRun: boolean): Promise<Member[]> {
    const members: Member[] = [];
    const commandName = 'paginateListMembers';
    const parameters = { onlyAssociated: 'false' };

    if (dryRun) {
      logger.dryRun(commandName, parameters, logPrefix);
      return members;
    }

    logger.commandExecution(commandName, parameters, logPrefix);
    const paginator = paginateListMembers({ client }, { onlyAssociated: 'false' });
    for await (const page of paginator) {
      for (const member of page.members ?? []) {
        members.push(member);
      }
    }
    logger.commandSuccess(commandName, parameters, logPrefix);

    return members;
  }

  /**
   * Checks if organization auto-enablement is configured for Macie
   * @param client - Macie2 client instance
   * @param logPrefix - Prefix for logging messages
   * @returns Promise resolving to true if auto-enablement is active
   */
  private static async isOrganizationAutoEnabled(client: Macie2Client, logPrefix: string): Promise<boolean> {
    try {
      const response = await executeApi(
        'DescribeOrganizationConfigurationCommand',
        {},
        () => client.send(new DescribeOrganizationConfigurationCommand({})),
        logger,
        logPrefix,
        [AccessDeniedException],
      );
      return response.autoEnable ?? false;
    } catch (error: unknown) {
      if (error instanceof AccessDeniedException) {
        return false;
      }
      throw error;
    }
  }
}
