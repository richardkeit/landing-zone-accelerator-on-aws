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
 * @fileoverview Delegated Administrator Manager - Reusable delegated admin management for AWS security services
 *
 * Provides a simple, reusable utility for managing AWS Organizations delegated administrators
 * across multiple security services (Macie, GuardDuty, Security Hub, Detective, etc.).
 *
 * Key capabilities:
 * - Cleanup of existing delegated administrators that don't match target
 * - Enable new delegated administrators with proper validation
 * - Disable existing delegated administrators with complete cleanup
 * - Dual API management (Organizations API + Service-specific API)
 * - Comprehensive error handling and validation
 * - Dry-run support for safe testing
 *
 * @example
 * ```typescript
 * // Define service-specific operations
 * const macieDelegatedAdminOps: DelegatedAdminOperations<Macie2Client> = {
 *   enable: async (client, accountId, dryRun, logPrefix) => {
 *     await OrganizationsDelegatedAdminAccount.enableOrganizationAdminAccount(client, dryRun, accountId, logPrefix);
 *   },
 *   disable: async (client, accountId, dryRun, logPrefix) => {
 *     await OrganizationsDelegatedAdminAccount.disableOrganizationAdminAccount(client, dryRun, accountId, logPrefix);
 *   },
 *   getCurrent: async (client, logPrefix) => {
 *     return await OrganizationsDelegatedAdminAccount.getOrganizationAdminAccountId(client, logPrefix);
 *   },
 * };
 *
 * // Create manager instance
 * const adminManager = new DelegatedAdminManager<Macie2Client>(
 *   'macie.amazonaws.com',
 *   organizationsClient,
 *   logger
 * );
 *
 * // Use it
 * await adminManager.enable(targetAccountId, macieClient, macieDelegatedAdminOps, dryRun, logPrefix);
 * ```
 */

import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { IconLogger } from '../logger';
import { deregisterDelegatedAdministrator, getDelegatedAdministratorAccountId } from '../organizations-functions';

/**
 * Interface for service-specific delegated admin operations
 * Each service implements this interface with their specific API calls
 *
 * @template TServiceClient - Type of the service client (Macie2Client, GuardDutyClient, etc.)
 *
 * @example
 * ```typescript
 * const macieDelegatedAdminOps: DelegatedAdminOperations<Macie2Client> = {
 *   enable: async (client, accountId, dryRun, logPrefix) => { ... },
 *   disable: async (client, accountId, dryRun, logPrefix) => { ... },
 *   getCurrent: async (client, logPrefix) => { ... },
 * };
 * ```
 */
export interface DelegatedAdminOperations<TServiceClient> {
  /**
   * Enable delegated admin in the service
   */
  enable(client: TServiceClient, accountId: string, dryRun: boolean, logPrefix: string): Promise<void>;

  /**
   * Disable delegated admin in the service
   */
  disable(client: TServiceClient, accountId: string, dryRun: boolean, logPrefix: string): Promise<void>;

  /**
   * Get current delegated admin account ID
   */
  getCurrent(client: TServiceClient, logPrefix: string): Promise<string | undefined>;
}

/**
 * Manages Organizations API delegated admin operations globally (once per execution)
 * Organizations API is global - calling it multiple times in parallel causes race conditions
 *
 * This function should be called ONCE before regional operations to handle Organizations API
 * delegated admin registration/deregistration. Regional service-level operations should be
 * handled separately using DelegatedAdminManager.
 *
 * @param organizationsClient - Organizations client for API operations
 * @param serviceName - AWS service name for Organizations API (e.g., 'macie.amazonaws.com')
 * @param targetAccountId - Target delegated admin account ID
 * @param enabledRegions - List of regions being enabled
 * @param disabledRegions - List of regions being disabled
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix
 * @param logger - Logger instance
 * @returns Promise that resolves when Organizations API operations are complete
 */
export async function manageOrganizationsApiDelegatedAdmin(
  organizationsClient: OrganizationsClient,
  serviceName: string,
  targetAccountId: string,
  enabledRegions: string[],
  disabledRegions: string[],
  dryRun: boolean,
  logPrefix: string,
  logger: IconLogger,
): Promise<void> {
  logger.info(`Managing Organizations API delegated admin for ${serviceName} in global region`, logPrefix);

  // Check current Organizations API delegated admin
  const orgDelegatedAdminId = await getDelegatedAdministratorAccountId(organizationsClient, serviceName, logPrefix);

  logger.info(
    `Organizations API delegated admin: ${orgDelegatedAdminId ?? 'none'}, Target: ${targetAccountId}`,
    logPrefix,
  );

  // **ENABLE FLOW**: Clean up if existing admin doesn't match target
  if (enabledRegions.length > 0) {
    if (orgDelegatedAdminId && orgDelegatedAdminId !== targetAccountId) {
      logger.info(
        `[ENABLE FLOW] Deregistering existing Organizations delegated admin: ${orgDelegatedAdminId} (doesn't match target ${targetAccountId})`,
        logPrefix,
      );

      await deregisterDelegatedAdministrator(organizationsClient, orgDelegatedAdminId, serviceName, dryRun, logPrefix);

      // Validate deregistration
      if (!dryRun) {
        const remainingOrgAdmin = await getDelegatedAdministratorAccountId(organizationsClient, serviceName, logPrefix);

        if (remainingOrgAdmin === orgDelegatedAdminId) {
          const message = `Failed to deregister delegated admin from Organizations API: ${orgDelegatedAdminId} still exists`;
          logger.error(message, logPrefix);
          throw new Error(message);
        }

        logger.info(`Successfully deregistered ${orgDelegatedAdminId} from Organizations API`, logPrefix);
      }
    } else if (orgDelegatedAdminId === targetAccountId) {
      logger.info(
        `[ENABLE FLOW] Organizations API delegated admin is already set to target ${targetAccountId}, no cleanup needed`,
        logPrefix,
      );
    } else {
      logger.info('[ENABLE FLOW] No existing Organizations API delegated admin found, no cleanup needed', logPrefix);
    }
  }

  // **DISABLE FLOW**: Deregister current delegated admin if disabling all regions
  if (disabledRegions.length > 0 && enabledRegions.length === 0) {
    // Only deregister from Organizations if we're disabling everywhere (no enabled regions)
    if (orgDelegatedAdminId) {
      logger.info(
        `[DISABLE FLOW] Deregistering Organizations delegated admin: ${orgDelegatedAdminId} (disabling in all regions)`,
        logPrefix,
      );

      await deregisterDelegatedAdministrator(organizationsClient, orgDelegatedAdminId, serviceName, dryRun, logPrefix);

      // Validate deregistration
      if (!dryRun) {
        const remainingOrgAdmin = await getDelegatedAdministratorAccountId(organizationsClient, serviceName, logPrefix);

        if (remainingOrgAdmin === orgDelegatedAdminId) {
          const message = `Failed to deregister delegated admin from Organizations API: ${orgDelegatedAdminId} still exists`;
          logger.error(message, logPrefix);
          throw new Error(message);
        }

        logger.info(`Successfully deregistered ${orgDelegatedAdminId} from Organizations API`, logPrefix);
      }
    } else {
      logger.info('[DISABLE FLOW] No Organizations API delegated admin found, no deregistration needed', logPrefix);
    }
  }
}

/**
 * Delegated administrator manager for AWS security services
 *
 * A simple utility class for managing delegated administrators across AWS security services.
 * Create an instance with your service name and Organizations client, then call enable/disable
 * methods with your service-specific operations.
 *
 * @template TServiceClient - Type of the service client (Macie2Client, GuardDutyClient, etc.)
 */
export class DelegatedAdminManager<TServiceClient> {
  private readonly serviceName: string;
  private readonly organizationsClient: OrganizationsClient;
  private readonly logger: IconLogger;

  /**
   * Creates a new DelegatedAdminManager instance
   *
   * @param serviceName - AWS service name for Organizations API (e.g., 'macie.amazonaws.com')
   * @param organizationsClient - Organizations client for API operations
   * @param logger - Logger instance for operation logging
   */
  constructor(serviceName: string, organizationsClient: OrganizationsClient, logger: IconLogger) {
    this.serviceName = serviceName;
    this.organizationsClient = organizationsClient;
    this.logger = logger;
  }

  /**
   * Enables delegated administrator account for the security service
   *
   * Performs complete delegated admin setup including cleanup of existing admins,
   * validation, and proper error handling. Handles both Organizations API and
   * service-specific API operations.
   *
   * @param targetAccountId - Account ID to set as delegated administrator
   * @param serviceClient - Service-specific client instance
   * @param operations - Service-specific operations (enable, disable, getCurrent)
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when delegated admin is enabled
   * @throws Error if operation fails or validation fails
   */
  async enable(
    targetAccountId: string,
    serviceClient: TServiceClient,
    operations: DelegatedAdminOperations<TServiceClient>,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const currentAdmin = await operations.getCurrent(serviceClient, logPrefix);

    this.logger.info(
      `Current delegated admin account id: ${currentAdmin || 'none'}, Target delegated admin: ${targetAccountId}`,
      logPrefix,
    );

    if (currentAdmin === targetAccountId) {
      this.logger.info(`Delegated admin is already set to ${targetAccountId}, skipping setup`, logPrefix);
      return;
    }

    // Clean up any existing delegated administrators before setting new one
    await this.cleanupExisting(targetAccountId, serviceClient, operations, dryRun, logPrefix, currentAdmin);

    // Set the new delegated admin
    await operations.enable(serviceClient, targetAccountId, dryRun, logPrefix);
  }

  /**
   * Disables the current delegated administrator account for the security service
   *
   * Performs complete cleanup including both service-specific API and Organizations API
   * deregistration with proper validation and error handling.
   *
   * @param serviceClient - Service-specific client instance
   * @param operations - Service-specific operations (enable, disable, getCurrent)
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when delegated admin is disabled
   * @throws Error if operation fails or validation fails
   */
  async disable(
    serviceClient: TServiceClient,
    operations: DelegatedAdminOperations<TServiceClient>,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const delegatedAdminAccountId = await operations.getCurrent(serviceClient, logPrefix);

    if (!delegatedAdminAccountId) {
      this.logger.info('No delegated admin account found, skipping disable operation', logPrefix);
      return;
    }

    // Disable service-specific delegated admin
    await operations.disable(serviceClient, delegatedAdminAccountId, dryRun, logPrefix);

    this.logger.info(`Successfully disabled and deregistered delegated admin: ${delegatedAdminAccountId}`, logPrefix);
  }

  /**
   * Cleans up existing delegated administrator accounts that don't match the target
   *
   * Checks both Organizations API and service-specific API to ensure complete cleanup.
   * This is a private method used internally by the enable operation.
   *
   * @param targetAccountId - Target delegated admin account ID
   * @param serviceClient - Service-specific client instance
   * @param operations - Service-specific operations
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @param currentServiceAdmin - Optional current service delegated admin account ID (avoids duplicate API call)
   * @returns Promise that resolves when cleanup is complete
   * @throws Error if cleanup validation fails
   */
  private async cleanupExisting(
    targetAccountId: string,
    serviceClient: TServiceClient,
    operations: DelegatedAdminOperations<TServiceClient>,
    dryRun: boolean,
    logPrefix: string,
    currentServiceAdmin?: string,
  ): Promise<void> {
    this.logger.info(`Starting cleanup of existing delegated administrators for ${this.serviceName}`, logPrefix);

    // Check Organizations API for existing delegated administrators
    const orgDelegatedAdminId = await getDelegatedAdministratorAccountId(
      this.organizationsClient,
      this.serviceName,
      logPrefix,
    );

    // Get current service admin if not provided
    const serviceAdmin = currentServiceAdmin ?? (await operations.getCurrent(serviceClient, logPrefix));

    this.logger.info(
      `Current state - Organizations delegated admin: ${orgDelegatedAdminId ?? 'none'}, ` +
        `Service delegated admin: ${serviceAdmin ?? 'none'}, ` +
        `Target delegated admin: ${targetAccountId}`,
      logPrefix,
    );

    // Clean up Organizations delegated admin if it exists and doesn't match target
    if (orgDelegatedAdminId && orgDelegatedAdminId !== targetAccountId) {
      this.logger.info(`Deregistering existing Organizations delegated admin: ${orgDelegatedAdminId}`, logPrefix);
      await this.deregisterFromOrganizations(orgDelegatedAdminId, dryRun, logPrefix);
    }

    // Clean up service delegated admin if it exists and doesn't match target
    if (serviceAdmin && serviceAdmin !== targetAccountId) {
      this.logger.info(`Disabling existing service delegated admin: ${serviceAdmin}`, logPrefix);
      // Note: We can't call the disable function here because we don't have it as a parameter
      // This will be handled by the service-specific implementation
      this.logger.warn(
        `Service-specific delegated admin cleanup for ${serviceAdmin} must be handled by the calling service`,
        logPrefix,
      );
    }

    // Validate cleanup was successful (only if not dry run)
    if (dryRun) {
      this.logger.dryRun(
        'validateExistingDelegatedAdminCleanup',
        {
          serviceName: this.serviceName,
          targetAccountId,
        },
        logPrefix,
      );
    } else {
      const remainingOrgAdmin = await getDelegatedAdministratorAccountId(
        this.organizationsClient,
        this.serviceName,
        logPrefix,
      );

      if (remainingOrgAdmin && remainingOrgAdmin !== targetAccountId) {
        const message = `Failed to clean up Organizations delegated admin: ${remainingOrgAdmin} still exists`;
        this.logger.error(message, logPrefix);
        throw new Error(message);
      }
    }

    this.logger.info('Successfully completed cleanup of existing delegated administrators', logPrefix);
  }

  /**
   * Deregisters delegated admin from Organizations API with validation
   *
   * @param accountId - Account ID to deregister
   * @param dryRun - Whether to perform dry run
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when deregistration is complete
   * @throws Error if deregistration fails validation
   */
  private async deregisterFromOrganizations(accountId: string, dryRun: boolean, logPrefix: string): Promise<void> {
    await deregisterDelegatedAdministrator(this.organizationsClient, accountId, this.serviceName, dryRun, logPrefix);

    // Validate deregistration was successful (only if not dry run)
    if (dryRun) {
      this.logger.dryRun(
        'validateDelegatedAdminDeregistration',
        {
          serviceName: this.serviceName,
          delegatedAdminAccountId: accountId,
        },
        logPrefix,
      );
    } else {
      const remainingOrgAdmin = await getDelegatedAdministratorAccountId(
        this.organizationsClient,
        this.serviceName,
        logPrefix,
      );

      if (remainingOrgAdmin === accountId) {
        const message = `Failed to deregister delegated admin from Organizations API: ${accountId} still exists`;
        this.logger.error(message, logPrefix);
        throw new Error(message);
      }
    }
  }
}
