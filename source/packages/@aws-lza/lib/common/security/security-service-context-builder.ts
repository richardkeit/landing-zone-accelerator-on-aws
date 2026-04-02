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
 * @fileoverview Security Service Context Builder - Builds operation context for security services
 *
 * Provides a standalone utility class for building security service operation contexts.
 * This class encapsulates all initialization logic needed to set up a security service
 * operation, making the initialization explicit and reusable without inheritance.
 *
 * Key capabilities:
 * - Organizations client setup and management account verification
 * - Organization account discovery (from DynamoDB or Organizations API)
 * - Regional boundary resolution (enabled/disabled regions)
 * - Context assembly with all necessary data for operations
 *
 * @example
 * ```typescript
 * const contextBuilder = new SecurityServiceContextBuilder(logger);
 * const context = await contextBuilder.build(props, 'macie.amazonaws.com');
 *
 * // Now you have:
 * // - context.managementAccountId
 * // - context.organizationAccounts
 * // - context.enabledRegions
 * // - context.disabledRegions
 * // - context.props
 * ```
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Account, OrganizationsClient } from '@aws-sdk/client-organizations';
import { BoundaryResolver, BoundaryType } from '../boundary-resolver';
import { DEFAULT_MAX_CONCURRENT_ENVIRONMENTS, DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS } from '../constants';
import { IModuleRequest, IRequiredBatchOperationSettings } from '../interfaces';
import { IconLogger } from '../logger';
import {
  getOrganizationAccounts,
  getOrganizationAccountsFromSourceTable,
  isManagementAccount,
} from '../organizations-functions';
import { OrderedAccountListType } from '../types';
import { setRetryStrategy, validateRegionFilters } from '../utility';

/**
 * Security service operation context
 * Contains all data needed for security service operations
 *
 * @template TRequest - Type of the module request (extends IModuleRequest)
 */
export interface SecurityServiceContext<TRequest extends IModuleRequest> {
  /** Module name (e.g., 'macie', 'guardduty') */
  moduleName: string;
  /** AWS service name for Organizations API (e.g., 'macie.amazonaws.com') */
  serviceName: string;
  /** Logging prefix for operation context */
  logPrefix: string;
  /** Management account ID */
  managementAccountId: string;
  /** List of all organization accounts */
  organizationAccounts: Account[];
  /** Regions where service should be enabled */
  enabledRegions: string[];
  /** Regions where service should be disabled */
  disabledRegions: string[];
  /** Resolved batch operation settings with defaults applied */
  batchOperationSettings: IRequiredBatchOperationSettings;
  /** Ordered accounts for enable operations (Management → DelegatedAdmin → WorkLoads) */
  enableOrderedAccounts: OrderedAccountListType[];
  /** Ordered accounts for disable operations (DelegatedAdmin → Management → WorkLoads) */
  disableOrderedAccounts: OrderedAccountListType[];
  /** Original module request properties */
  props: TRequest;
}

/**
 * Builds operation context for security service operations
 *
 * This is a standalone utility class that encapsulates all initialization logic
 * needed to set up a security service operation context. It can be instantiated
 * and used directly without inheritance.
 */
export class SecurityServiceContextBuilder {
  private readonly logger: IconLogger;

  /**
   * Creates a new SecurityServiceContextBuilder instance
   *
   * @param logger - Logger instance for operation logging
   */
  constructor(logger: IconLogger) {
    this.logger = logger;
  }

  /**
   * Builds complete security service context with all necessary data
   *
   * Performs the following operations:
   * 1. Creates Organizations client and verifies management account
   * 2. Retrieves organization accounts (from DynamoDB or Organizations API)
   * 3. Calculates regional boundaries (enabled/disabled regions)
   * 4. Resolves concurrency settings with defaults
   * 5. Sorts accounts for enable and disable operations
   * 6. Assembles and returns complete context object
   *
   * @param moduleName - Module name
   * @param props - Module request containing configuration and credentials
   * @param serviceName - AWS service name for Organizations API (e.g., 'macie.amazonaws.com')
   * @param logPrefix - Logging prefix for operation context
   * @returns Promise resolving to initialized context with all necessary data
   * @throws Error when management account verification fails, or validation fails
   */
  async build<TRequest extends IModuleRequest>(
    moduleName: string,
    props: TRequest,
    serviceName: string,
    logPrefix: string,
  ): Promise<SecurityServiceContext<TRequest>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configuration = (props as any).configuration;

    this.logger.processStart(`Starting ${moduleName} module`, logPrefix);
    this.logger.info(`Execution invoked from ${props.invokingAccountId} in ${props.region} region.`, logPrefix);

    // Step 1: Validate region filter configuration
    this.logger.info(`Validating region filter configuration`, logPrefix);
    validateRegionFilters(configuration.enable, this.logger, logPrefix, configuration.regionFilters);
    this.logger.info(`Region filter configuration validated successfully`, logPrefix);

    // Step 2: Create Organizations client
    const orgClient = new OrganizationsClient({
      region: props.globalRegion,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    // Step 3: Verify management account
    const isManagement = await isManagementAccount(orgClient, props.invokingAccountId, logPrefix);
    if (!isManagement) {
      const message = `Account ${props.invokingAccountId} is not the AWS Organizations Management Account. Security service ${props.operation} cannot be performed from non-management accounts.`;
      this.logger.error(message, logPrefix);
      throw new Error(message);
    }

    this.logger.info(`Management account verified, proceeding with security service setup`, logPrefix);
    const managementAccountId = props.invokingAccountId;

    // Step 4: Get organization accounts
    const organizationAccounts = await this.resolveOrganizationAccounts(props, configuration, orgClient, logPrefix);

    // Step 5: Calculate region boundaries
    const boundaries = await this.resolveBoundaries(props, configuration);

    this.logger.info(`Service will be enabled in regions: [${boundaries.enabled.join(', ')}]`, logPrefix);
    this.logger.info(`Service will be disabled in regions: [${boundaries.disabled.join(', ')}]`, logPrefix);

    // Step 6: Resolve batch operation settings with defaults
    const batchOperationSettings = this.resolveBatchOperationSettings(configuration, logPrefix);

    // Step 7: Sort accounts for enable and disable operations
    const enableOrderedAccounts = this.sortAccountsForEnable(
      managementAccountId,
      configuration.delegatedAdminAccountId,
      organizationAccounts,
      logPrefix,
    );

    const disableOrderedAccounts = this.sortAccountsForDisable(
      managementAccountId,
      configuration.delegatedAdminAccountId,
      organizationAccounts,
      logPrefix,
    );

    this.logger.info(`Account ordering configured for ${organizationAccounts.length} organization accounts`, logPrefix);

    // Step 8: Assemble and return context
    return {
      moduleName,
      serviceName,
      logPrefix,
      managementAccountId,
      organizationAccounts,
      enabledRegions: boundaries.enabled,
      disabledRegions: boundaries.disabled,
      batchOperationSettings,
      enableOrderedAccounts,
      disableOrderedAccounts,
      props,
    };
  }

  /**
   * Resolves organization accounts from configured source (DynamoDB table or Organizations API)
   *
   * @param props - Module request properties
   * @param configuration - Service configuration
   * @param orgClient - Organizations client instance
   * @param logPrefix - Logging prefix
   * @returns Promise resolving to list of organization accounts
   */
  private async resolveOrganizationAccounts(
    props: IModuleRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configuration: any,
    orgClient: OrganizationsClient,
    logPrefix: string,
  ): Promise<Account[]> {
    this.logger.info(`Get Organizations Accounts`, logPrefix);

    if (configuration.dataSources?.organizations) {
      this.logger.info(
        `Get Organizations Accounts from DataSource Table: ${configuration.dataSources.organizations.tableName}`,
        logPrefix,
      );

      const dynamoClient = new DynamoDBClient({
        region: props.region,
        customUserAgent: props.solutionId,
        retryStrategy: setRetryStrategy(),
        credentials: props.credentials,
      });

      return await getOrganizationAccountsFromSourceTable({
        client: dynamoClient,
        organizationsDataSource: configuration.dataSources.organizations,
        logPrefix,
      });
    }

    this.logger.info(`Get Organizations Accounts from Organizations API`, logPrefix);
    return await getOrganizationAccounts(props.region, orgClient);
  }

  /**
   * Resolves regional boundaries (enabled and disabled regions)
   *
   * @param props - Module request properties
   * @param configuration - Service configuration
   * @returns Promise resolving to enabled and disabled region lists
   */
  private async resolveBoundaries(
    props: IModuleRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configuration: any,
  ): Promise<{ enabled: string[]; disabled: string[] }> {
    const boundaries = await BoundaryResolver.calculateBoundaries(
      BoundaryType.REGIONS,
      configuration.enable,
      {
        partition: props.partition,
        region: props.region,
        solutionId: props.solutionId,
        credentials: props.credentials,
      },
      configuration.boundary?.regions,
      configuration.regionFilters,
    );

    return {
      enabled: boundaries.enabledBoundaries,
      disabled: boundaries.disabledBoundaries,
    };
  }

  /**
   * Resolves batch operation settings with defaults applied
   *
   * @param configuration - Service configuration (should have optional batchOperationSettings property)
   * @param logPrefix - Logging prefix
   * @returns Resolved batch operation settings with all required fields
   */
  private resolveBatchOperationSettings(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configuration: any,
    logPrefix: string,
  ): IRequiredBatchOperationSettings {
    const batchOperationSettings: IRequiredBatchOperationSettings = {
      maxConcurrentEnvironments:
        configuration.batchOperationSettings?.maxConcurrentEnvironments ?? DEFAULT_MAX_CONCURRENT_ENVIRONMENTS,
      operationTimeoutMs:
        configuration.batchOperationSettings?.operationTimeoutMs ?? DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS,
    };

    this.logger.info(
      `Batch operation settings resolved: maxConcurrentEnvironments=${batchOperationSettings.maxConcurrentEnvironments}, operationTimeoutMs=${batchOperationSettings.operationTimeoutMs}`,
      logPrefix,
    );

    return batchOperationSettings;
  }

  /**
   * Validates and retrieves required accounts from organization accounts list
   *
   * This helper method extracts the validation logic that was previously duplicated
   * in both sortAccountsForEnable and sortAccountsForDisable methods.
   *
   * @param managementAccountId - Management account ID
   * @param delegatedAdminAccountId - Delegated admin account ID
   * @param accounts - List of organization accounts
   * @param logPrefix - Logging prefix
   * @returns Object containing management account, delegated admin account, and workload accounts
   * @throws Error if management account is not found in organization accounts
   * @throws Error if delegated admin account is not found in organization accounts
   */
  private validateAndRetrieveAccounts(
    managementAccountId: string,
    delegatedAdminAccountId: string,
    accounts: Account[],
    logPrefix: string,
  ): {
    managementAccount: Account;
    delegatedAdminAccount: Account;
    workLoadAccounts: Account[];
  } {
    const managementAccount = accounts.find(acc => acc.Id === managementAccountId);
    if (!managementAccount) {
      const error = `Management account ${managementAccountId} not found in the list of Organizations accounts`;
      this.logger.error(error, logPrefix);
      throw new Error(error);
    }

    const delegatedAdminAccount = accounts.find(acc => acc.Id === delegatedAdminAccountId);
    if (!delegatedAdminAccount) {
      const error = `Delegated admin account ${delegatedAdminAccountId} not found in the list of Organizations accounts`;
      this.logger.error(error, logPrefix);
      throw new Error(error);
    }

    const workLoadAccounts = accounts.filter(
      acc => acc.Id !== managementAccountId && acc.Id !== delegatedAdminAccountId,
    );

    return { managementAccount, delegatedAdminAccount, workLoadAccounts };
  }

  /**
   * Sorts accounts for enable operations
   * Order: Management → DelegatedAdmin → WorkLoads
   *
   * @param managementAccountId - Management account ID
   * @param delegatedAdminAccountId - Delegated admin account ID
   * @param accounts - List of organization accounts
   * @param logPrefix - Logging prefix
   * @returns Ordered account list for enable operations
   * @throws Error if required accounts are not found
   */
  private sortAccountsForEnable(
    managementAccountId: string,
    delegatedAdminAccountId: string,
    accounts: Account[],
    logPrefix: string,
  ): OrderedAccountListType[] {
    const { managementAccount, delegatedAdminAccount, workLoadAccounts } = this.validateAndRetrieveAccounts(
      managementAccountId,
      delegatedAdminAccountId,
      accounts,
      logPrefix,
    );

    this.logger.info(
      `Enable account ordering: Management (1) → DelegatedAdmin (1) → WorkLoads (${workLoadAccounts.length})`,
      logPrefix,
    );

    return [
      { name: 'Management', order: 1, accounts: [managementAccount] },
      { name: 'DelegatedAdmin', order: 2, accounts: [delegatedAdminAccount] },
      { name: 'WorkLoads', order: 3, accounts: workLoadAccounts },
    ];
  }

  /**
   * Sorts accounts for disable operations
   * Order: DelegatedAdmin → Management → WorkLoads
   *
   * @param managementAccountId - Management account ID
   * @param delegatedAdminAccountId - Delegated admin account ID
   * @param accounts - List of organization accounts
   * @param logPrefix - Logging prefix
   * @returns Ordered account list for disable operations
   * @throws Error if required accounts are not found
   */
  private sortAccountsForDisable(
    managementAccountId: string,
    delegatedAdminAccountId: string,
    accounts: Account[],
    logPrefix: string,
  ): OrderedAccountListType[] {
    const { managementAccount, delegatedAdminAccount, workLoadAccounts } = this.validateAndRetrieveAccounts(
      managementAccountId,
      delegatedAdminAccountId,
      accounts,
      logPrefix,
    );

    this.logger.info(
      `Disable account ordering: DelegatedAdmin (1) → Management (1) → WorkLoads (${workLoadAccounts.length})`,
      logPrefix,
    );

    return [
      { name: 'DelegatedAdmin', order: 1, accounts: [delegatedAdminAccount] },
      { name: 'Management', order: 2, accounts: [managementAccount] },
      { name: 'WorkLoads', order: 3, accounts: workLoadAccounts },
    ];
  }
}
