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
 * @fileoverview Amazon Macie Main Module - Orchestrates complete Macie setup across AWS Organizations
 *
 * Provides the main orchestration logic for Amazon Macie deployment and configuration across
 * AWS Organizations. Handles multi-account, multi-region operations with proper dependency
 * management, boundary resolution, and comprehensive error handling.
 *
 * Key capabilities:
 * - Complete Macie organization setup and teardown
 * - Multi-account batch processing with dependency ordering
 * - Regional boundary resolution and filtering
 * - Delegated administrator account management
 * - Member account lifecycle management
 * - Session configuration across all accounts
 * - Comprehensive response tracking and reporting
 */

import { AutoEnableMode, Macie2Client } from '@aws-sdk/client-macie2';
import { Account, OrganizationsClient } from '@aws-sdk/client-organizations';
import path from 'node:path';
import {
  AccountSetupHandler,
  ServiceOperationHandler,
  processDisableOperations,
  processEnableOperations,
} from '../common/batch-processor';
import {
  AcceleratorModuleName,
  IDelegatedAccountData,
  IDelegatedAccountResponse,
  IModuleResponse,
  IOrganizationAdminData,
  IOrganizationAdminResponse,
  IRegionOperationError,
} from '../common/interfaces';
import { createLogger } from '../common/logger';
import {
  DelegatedAdminManager,
  DelegatedAdminOperations,
  manageOrganizationsApiDelegatedAdmin,
} from '../common/security/delegated-admin-manager';
import { SecurityServiceContextBuilder } from '../common/security/security-service-context-builder';
import { SecurityServiceModuleResponseBuilder } from '../common/security/security-service-module-response-builder';
import {
  DelegatedAccountResponseHandler,
  OrganizationAdminResponseHandler,
  SecurityServiceResponseBuilder,
} from '../common/security/security-service-response-builder';
import { getCredentials } from '../common/sts-functions';
import { SecurityModuleOperationAction, SecurityModuleOperationType } from '../common/types';
import { setRetryStrategy } from '../common/utility';
import { disableMacie, enableMacie, isMacieEnabled } from './functions';
import { IMacieModuleRequest, IMacieModuleResponse, IMacieS3Destination, IMacieSessionResponse } from './interfaces';
import { MacieMembers } from './macie-members';
import { MacieSession } from './macie-session';
import { OrganizationsDelegatedAdminAccount } from './organizations-delegated-admin-account';
import { MacieSessionResponseHandler } from './response-factories';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Macie service name constant used for Organizations API calls
 */
const MACIE_SERVICE_NAME = 'macie.amazonaws.com';

/**
 * Macie session configuration data
 * Used by handlers to return session setup information (data only, no operation/regions)
 */
interface IMacieSessionData extends Record<string, unknown> {
  /** List of account IDs affected by the operation */
  accountIds: string[];
  /** Whether sensitive data findings are published */
  publishSensitiveDataFindings?: boolean;
  /** Frequency of finding publication */
  findingPublishingFrequency?: string;
  /** S3 destination configuration */
  s3Destination?: IMacieS3Destination;
}

/**
 * Handler operation response
 * Contains data returned by a single handler execution (one account-region)
 */
interface MacieOperationResponse {
  /** Organization admin configuration data */
  organizationAdmin?: IOrganizationAdminData;
  /** Delegated admin configuration data */
  delegatedAdmin?: IDelegatedAccountData;
  /** Session configuration data */
  session?: IMacieSessionData;
}

/**
 * Collected response with region and account context
 */
interface CollectedMacieResponse {
  region: string;
  accountId: string;
  response: MacieOperationResponse;
  operation: SecurityModuleOperationAction; // Track which operation this response came from
}

/**
 * Builds module-specific response from collected handler responses
 * Uses SecurityServiceResponseBuilder to merge responses across regions
 *
 * @param operation - Operation type (enabled/disabled)
 * @param collectedResponses - All responses collected from handlers
 * @param logPrefix - Logging prefix for the operation
 * @returns Module response with configuration results
 */
function buildModuleResponse(
  operation: SecurityModuleOperationType,
  collectedResponses: CollectedMacieResponse[],
  logPrefix: string,
): IMacieModuleResponse {
  // Create response builders for each response type
  const orgAdminBuilder = new SecurityServiceResponseBuilder<IOrganizationAdminResponse>(logger);
  const delegatedAdminBuilder = new SecurityServiceResponseBuilder<IDelegatedAccountResponse>(logger);
  const sessionBuilder = new SecurityServiceResponseBuilder<IMacieSessionResponse>(logger);

  // Create response handlers (combined factory + merge strategy)
  const orgAdminHandler = new OrganizationAdminResponseHandler();
  const delegatedAdminHandler = new DelegatedAccountResponseHandler();
  const sessionHandler = new MacieSessionResponseHandler();

  // Process all collected responses
  for (const { region, response } of collectedResponses) {
    // Add organization admin responses
    if (response.organizationAdmin) {
      orgAdminBuilder.addResponse(operation, region, orgAdminHandler, response.organizationAdmin, logPrefix);
    }

    // Add delegated admin responses
    if (response.delegatedAdmin) {
      delegatedAdminBuilder.addResponse(operation, region, delegatedAdminHandler, response.delegatedAdmin, logPrefix);
    }

    // Add session responses
    if (response.session) {
      sessionBuilder.addResponse(operation, region, sessionHandler, response.session, logPrefix);
    }
  }

  return {
    organizationAdminConfig: orgAdminBuilder.getResponses(),
    delegatedAdminAccountConfig: delegatedAdminBuilder.getResponses(),
    sessionConfig: sessionBuilder.getResponses(),
  };
}

/**
 * Delegated admin operations for the security service
 * Implements the DelegatedAdminOperations interface
 */
const delegatedAdminOps: DelegatedAdminOperations<Macie2Client> = {
  enable: async (client: Macie2Client, accountId: string, dryRun: boolean, logPrefix: string) => {
    await OrganizationsDelegatedAdminAccount.enableOrganizationAdminAccount(client, dryRun, accountId, logPrefix);
  },
  disable: async (client: Macie2Client, accountId: string, dryRun: boolean, logPrefix: string) => {
    await OrganizationsDelegatedAdminAccount.disableOrganizationAdminAccount(client, dryRun, accountId, logPrefix);
  },
  getCurrent: async (client: Macie2Client, logPrefix: string) => {
    return await OrganizationsDelegatedAdminAccount.getOrganizationAdminAccountId(client, logPrefix);
  },
};

/**
 * Main entry point for configuring Amazon Macie across AWS Organizations
 * @param props - Macie module request containing configuration and context
 * @returns Promise resolving to module response with operation results
 */
export async function configureMacie(props: IMacieModuleRequest): Promise<IModuleResponse<IMacieModuleResponse>> {
  const logPrefix = `${props.invokingAccountId}:${props.region}`;
  const moduleName = props.moduleName ?? AcceleratorModuleName.AMAZON_MACIE;
  const dryRun = props.dryRun ?? false;

  // Create response collection array
  const collectedResponses: CollectedMacieResponse[] = [];

  try {
    logger.processStart(`Starting ${moduleName} module`, logPrefix);
    // Build security service context
    const contextBuilder = new SecurityServiceContextBuilder(logger);
    const context = await contextBuilder.build(moduleName, props, MACIE_SERVICE_NAME, logPrefix);

    logger.info(
      `Macie configuration initialized: ${context.enabledRegions.length} enabled regions, ${context.disabledRegions.length} disabled regions`,
      logPrefix,
    );

    // Manage Organizations API delegated admin globally (once per execution)
    // This must be done BEFORE regional operations to avoid race conditions
    const organizationsClient = new OrganizationsClient({
      region: props.region, // Use home region for Organizations API
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: props.credentials,
    });

    await manageOrganizationsApiDelegatedAdmin(
      organizationsClient,
      MACIE_SERVICE_NAME,
      props.configuration.delegatedAdminAccountId,
      context.enabledRegions,
      context.disabledRegions,
      dryRun,
      logPrefix,
      logger,
    );

    // Pass response collection array through props
    const propsWithResponses = { ...props, collectedResponses };

    // Update context with props that include collectedResponses
    const contextWithResponses = { ...context, props: propsWithResponses };

    // Execute regional operations in parallel (enable and disable target different environments)
    const [enableResults, disableResults] = await Promise.all([
      processEnableOperations({
        service: context.moduleName,
        managementAccountId: context.managementAccountId,
        orderedTargetAccounts: context.enableOrderedAccounts,
        targetRegions: context.enabledRegions,
        props: contextWithResponses.props,
        dryRun,
        serviceHandler: macieEnableHandler,
        batchOperationSettings: context.batchOperationSettings,
        accountSetupHandler: macieAccountSetup,
        organizationAccounts: context.organizationAccounts,
      }),
      processDisableOperations({
        service: context.moduleName,
        managementAccountId: context.managementAccountId,
        orderedTargetAccounts: context.disableOrderedAccounts,
        targetRegions: context.disabledRegions,
        props: contextWithResponses.props,
        dryRun,
        serviceHandler: macieDisableHandler,
        batchOperationSettings: context.batchOperationSettings,
        accountSetupHandler: macieAccountSetup,
        organizationAccounts: context.organizationAccounts,
      }),
    ]);

    logger.info(
      `Regional operations completed: ${enableResults.length} enable results, ${disableResults.length} disable results`,
      logPrefix,
    );

    // Perform final cleanup (if needed)
    let cleanupResults: (void | IRegionOperationError)[] = [];

    if (context.disabledRegions.length > 0) {
      const cleanupAccounts = [
        context.organizationAccounts.find(acc => acc.Id === props.configuration.delegatedAdminAccountId),
        context.organizationAccounts.find(acc => acc.Id === context.managementAccountId),
      ].filter(Boolean) as Account[];

      if (cleanupAccounts.length > 0) {
        logger.info(
          `Performing final cleanup for ${cleanupAccounts.length} accounts in ${context.disabledRegions.length} disabled regions`,
          logPrefix,
        );

        cleanupResults = await processDisableOperations({
          service: context.moduleName,
          managementAccountId: context.managementAccountId,
          orderedTargetAccounts: [{ name: 'WorkLoads', order: 1, accounts: cleanupAccounts }],
          targetRegions: context.disabledRegions,
          props: contextWithResponses.props,
          dryRun,
          serviceHandler: macieFinalCleanupHandler,
          batchOperationSettings: context.batchOperationSettings,
          accountSetupHandler: macieAccountSetup,
          organizationAccounts: cleanupAccounts,
        });

        logger.info(`Final cleanup completed`, logPrefix);
      }
    }

    // Build module-specific response from collected responses
    // Separate responses by operation type
    const enableResponses = collectedResponses.filter(r => r.operation === 'enable');
    const disableResponses = collectedResponses.filter(r => r.operation === 'disable');

    // Build responses for each operation type
    const enableModuleResponse =
      enableResponses.length > 0
        ? buildModuleResponse('enabled', enableResponses, logPrefix)
        : { organizationAdminConfig: [], delegatedAdminAccountConfig: [], sessionConfig: [] };

    const disableModuleResponse =
      disableResponses.length > 0
        ? buildModuleResponse('disabled', disableResponses, logPrefix)
        : { organizationAdminConfig: [], delegatedAdminAccountConfig: [], sessionConfig: [] };

    // Merge both responses
    const macieResponse: IMacieModuleResponse = {
      organizationAdminConfig: [
        ...enableModuleResponse.organizationAdminConfig,
        ...disableModuleResponse.organizationAdminConfig,
      ],
      delegatedAdminAccountConfig: [
        ...enableModuleResponse.delegatedAdminAccountConfig,
        ...disableModuleResponse.delegatedAdminAccountConfig,
      ],
      sessionConfig: [...enableModuleResponse.sessionConfig, ...disableModuleResponse.sessionConfig],
    };

    // Build final module response
    const responseBuilder = new SecurityServiceModuleResponseBuilder(logger);

    const response = responseBuilder.build(
      'macie',
      props.operation,
      macieResponse,
      [...enableResults, ...disableResults],
      cleanupResults,
      dryRun,
    );
    logger.processEnd(`Successfully completed ${moduleName} module`, logPrefix);

    return response;
  } catch (error) {
    // Handle top-level errors
    logger.error(`Error in configureMacie: ${error}`, logPrefix);

    const responseBuilder = new SecurityServiceModuleResponseBuilder(logger);

    const emptyResponse: IMacieModuleResponse = {
      organizationAdminConfig: [],
      delegatedAdminAccountConfig: [],
      sessionConfig: [],
    };

    const response = responseBuilder.buildErrorResponse(error, 'macie', props.operation, dryRun, emptyResponse);
    logger.processEnd(`${moduleName} module failed`, logPrefix);
    return response;
  }
}

/**
 * Account setup handler for cross-account credential management
 * @param targetAccount - Target AWS account for operations
 * @param managementAccountId - Management account ID
 * @param props - Macie module request properties
 * @returns Promise resolving to updated props with appropriate credentials
 */
export const macieAccountSetup: AccountSetupHandler<IMacieModuleRequest> = async (
  targetAccount: Account,
  managementAccountId: string,
  props: IMacieModuleRequest,
): Promise<IMacieModuleRequest> => {
  // Use original credentials for management account
  if (targetAccount.Id === managementAccountId) {
    return props;
  }

  // Assume role for target accounts (called only once per account)
  const credentials = await getCredentials({
    partition: props.partition,
    accountId: targetAccount.Id!,
    region: props.region,
    logPrefix: `Invoker:${props.region}`,
    solutionId: props.solutionId,
    assumeRoleName: props.configuration.accountAccessRoleName,
    credentials: props.credentials,
  });

  return { ...props, credentials }; // Return props with target account credentials
};

/**
 * Service operation handler for enabling Macie across accounts and regions
 * @param managementAccountId - Management account ID
 * @param targetAccount - Target account for the operation
 * @param targetRegion - Target region for the operation
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix for the operation
 * @param props - Macie module request properties
 * @param organizationAccounts - Optional list of organization accounts
 * @returns Promise that resolves when enable operation completes
 */
export const macieEnableHandler: ServiceOperationHandler<IMacieModuleRequest, void> = async (
  managementAccountId: string,
  targetAccount: Account,
  targetRegion: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
  organizationAccounts?: Account[],
): Promise<void> => {
  const response = await enableService(
    targetAccount,
    targetRegion,
    managementAccountId,
    dryRun,
    logPrefix,
    props,
    organizationAccounts ?? [],
  );

  // Add response to collection array if available
  const propsWithResponses = props as IMacieModuleRequest & { collectedResponses?: CollectedMacieResponse[] };
  if (propsWithResponses.collectedResponses) {
    propsWithResponses.collectedResponses.push({
      region: targetRegion,
      accountId: targetAccount.Id!,
      response,
      operation: 'enable', // Mark as enable operation
    });
  }
};

/**
 * Service operation handler for disabling Macie across accounts and regions
 * @param managementAccountId - Management account ID
 * @param targetAccount - Target account for the operation
 * @param targetRegion - Target region for the operation
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix for the operation
 * @param props - Macie module request properties
 * @param organizationAccounts - Optional list of organization accounts
 * @returns Promise that resolves when disable operation completes
 */
export const macieDisableHandler: ServiceOperationHandler<IMacieModuleRequest, void> = async (
  managementAccountId: string,
  targetAccount: Account,
  targetRegion: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
  organizationAccounts?: Account[],
): Promise<void> => {
  const response = await disableService(
    targetAccount,
    targetRegion,
    managementAccountId,
    dryRun,
    logPrefix,
    props,
    organizationAccounts ?? [],
  );

  // Add response to collection array if available
  const propsWithResponses = props as IMacieModuleRequest & { collectedResponses?: CollectedMacieResponse[] };
  if (propsWithResponses.collectedResponses) {
    propsWithResponses.collectedResponses.push({
      region: targetRegion,
      accountId: targetAccount.Id!,
      response,
      operation: 'disable', // Mark as disable operation
    });
  }
};

/**
 * Final cleanup handler for disabling Macie in management and delegated admin accounts
 * @param _managementAccountId - Management account ID (unused)
 * @param targetAccount - Target account for cleanup
 * @param targetRegion - Target region for cleanup
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix for the operation
 * @param props - Macie module request properties
 * @returns Promise that resolves when cleanup completes
 */
export const macieFinalCleanupHandler: ServiceOperationHandler<IMacieModuleRequest, void> = async (
  _managementAccountId: string,
  targetAccount: Account,
  targetRegion: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
): Promise<void> => {
  const client = new Macie2Client({
    region: targetRegion,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  const macieEnabled = await isMacieEnabled(client, logPrefix);

  if (macieEnabled) {
    if (!dryRun) {
      logger.info(`Disabling Macie in ${targetRegion} for ${targetAccount.Name} account (final cleanup).`, logPrefix);
    }
    await disableMacie(client, dryRun, logPrefix);
  } else {
    logger.info(`Macie is already disabled in ${targetRegion}.`, logPrefix);
  }
};

/**
 * Enables Macie service for a specific account and region with role-based configuration
 * @param targetAccount - Target account for enablement
 * @param targetRegion - Target region for enablement
 * @param managementAccountId - Management account ID
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix
 * @param props - Macie module request properties
 * @param organizationAccounts - List of organization accounts
 * @returns Promise that resolves with operation response data
 */
async function enableService(
  targetAccount: Account,
  targetRegion: string,
  managementAccountId: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
  organizationAccounts: Account[],
): Promise<MacieOperationResponse> {
  const response: MacieOperationResponse = {};

  const client = new Macie2Client({
    region: targetRegion,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  const macieEnabled = await isMacieEnabled(client, logPrefix);
  if (!macieEnabled) {
    await enableMacie(client, dryRun, logPrefix);
  }

  // Process Management Account
  if (targetAccount.Id === managementAccountId) {
    await enableDelegatedAdminAccount(props, targetRegion, client, MACIE_SERVICE_NAME, dryRun, logPrefix);
    response.organizationAdmin = {
      managementAccountId,
      delegatedAdminAccountId: props.configuration.delegatedAdminAccountId,
    };
  }

  // Process Delegated Admin Account
  if (targetAccount.Id === props.configuration.delegatedAdminAccountId) {
    await MacieMembers.enable(client, organizationAccounts, targetAccount.Id, dryRun, logPrefix);
    response.delegatedAdmin = {
      adminAccountId: targetAccount.Id,
      memberAccountIds: organizationAccounts.map(acc => acc.Id!).filter(id => id !== targetAccount.Id),
    };
  }

  // Classification export is only configured on the delegated admin account (central model)
  const isDelegatedAdmin = targetAccount.Id === props.configuration.delegatedAdminAccountId;
  const skipClassificationExport = !isDelegatedAdmin;

  // Configure Macie session
  await MacieSession.configure({
    env: { accountId: targetAccount.Id!, region: targetRegion },
    client,
    s3Destination: props.configuration.s3Destination,
    policyFindingsPublishingFrequency: props.configuration.policyFindingsPublishingFrequency,
    publishSensitiveDataFindings: props.configuration.publishSensitiveDataFindings,
    publishPolicyFindings: props.configuration.publishPolicyFindings,
    skipClassificationExport,
    dryRun,
    logPrefix,
  });
  response.session = {
    accountIds: [targetAccount.Id!],
    publishSensitiveDataFindings: props.configuration.publishSensitiveDataFindings,
    findingPublishingFrequency: props.configuration.policyFindingsPublishingFrequency,
    s3Destination: props.configuration.s3Destination,
  };

  // Enable automated discovery on delegated admin account
  if (isDelegatedAdmin) {
    const autoEnableMembers: AutoEnableMode = props.configuration.automatedDiscoveryEnabled
      ? AutoEnableMode.ALL
      : AutoEnableMode.NONE;
    await MacieSession.configureAutomatedDiscovery({
      client,
      enabled: props.configuration.automatedDiscoveryEnabled,
      autoEnableOrganizationMembers: autoEnableMembers,
      dryRun,
      logPrefix,
    });

    // Update classification scope exclusions on delegated admin account
    if (props.configuration.automatedDiscoveryEnabled && props.configuration.classificationScopeExclusion) {
      await MacieSession.updateClassificationScope({
        client,
        buckets: props.configuration.classificationScopeExclusion.buckets,
        operation: props.configuration.classificationScopeExclusion.operation,
        targetRegion,
        dryRun,
        logPrefix,
      });
    }
  }

  return response;
}

/**
 * Cleans up existing delegated administrator accounts that don't match the target
 * Checks both Organizations API and Macie API to ensure complete cleanup
 * Creates Organizations client internally using provided props and credentials
 * @param targetRegion - Target AWS Region name (used for logging context)
 * @param props - Macie module request containing configuration and credentials
 * @param macieClient - Macie2 client instance
 * @param dryRun - Whether to perform dry run without making changes
 * @param logPrefix - Prefix for logging messages
 * @param currentMacieAdmin - Optional current Macie delegated admin account ID (avoids duplicate API call)
 * @returns Promise that resolves when cleanup is complete
 * @throws Error if cleanup validation fails
 */
/**
 * Enables delegated administrator account for Macie organization management
 * @param props - Macie module request properties
 * @param targetRegion - Target region for the operation
 * @param client - Macie2 client instance
 * @param serviceName - AWS service name for Organizations API
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix
 * @returns Promise that resolves when delegated admin is configured
 */
async function enableDelegatedAdminAccount(
  props: IMacieModuleRequest,
  targetRegion: string,
  client: Macie2Client,
  serviceName: string,
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  // Create Organizations client for delegated admin management
  const organizationsClient = new OrganizationsClient({
    region: targetRegion,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  // Create delegated admin manager
  const adminManager = new DelegatedAdminManager<Macie2Client>(serviceName, organizationsClient, logger);

  // Enable delegated admin using the simplified interface
  await adminManager.enable(props.configuration.delegatedAdminAccountId, client, delegatedAdminOps, dryRun, logPrefix);
}

/**
 * Disables Macie service for a specific account and region with proper cleanup
 * @param targetAccount - Target account for disablement
 * @param targetRegion - Target region for disablement
 * @param managementAccountId - Management account ID
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix
 * @param props - Macie module request properties
 * @param organizationAccounts - List of organization accounts
 * @returns Promise that resolves with operation response data
 */
async function disableService(
  targetAccount: Account,
  targetRegion: string,
  managementAccountId: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
  organizationAccounts: Account[],
): Promise<MacieOperationResponse> {
  const response: MacieOperationResponse = {};

  const client = new Macie2Client({
    region: targetRegion,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  const macieEnabled = await isMacieEnabled(client, logPrefix);

  if (!macieEnabled) {
    logger.info(`Macie is already disabled in ${targetRegion}.`, logPrefix);
    return response;
  }

  // Process Delegated Admin Account
  if (targetAccount.Id === props.configuration.delegatedAdminAccountId) {
    await MacieMembers.disable(client, organizationAccounts, targetAccount.Id, dryRun, logPrefix);
    response.delegatedAdmin = {
      adminAccountId: targetAccount.Id,
      memberAccountIds: organizationAccounts.map(acc => acc.Id!).filter(id => id !== targetAccount.Id),
    };
  }

  // Process Management Account
  if (targetAccount.Id === managementAccountId) {
    await disableDelegatedAdminAccount(client, MACIE_SERVICE_NAME, dryRun, logPrefix, props, targetRegion);
    response.organizationAdmin = {
      managementAccountId,
      delegatedAdminAccountId: props.configuration.delegatedAdminAccountId,
    };
  }

  // Process Workload Accounts except Management and Audit
  if (![managementAccountId, props.configuration.delegatedAdminAccountId].includes(targetAccount.Id!)) {
    logger.info(`Disabling Macie in ${targetRegion} for ${targetAccount.Name} account.`, logPrefix);
    await disableMacie(client, dryRun, logPrefix);
    response.session = {
      accountIds: [targetAccount.Id!],
    };
  }

  return response;
}

/**
 * Disables the current delegated administrator account for Macie
 * @param client - Macie2 client instance
 * @param serviceName - AWS service name for Organizations API
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Logging prefix
 * @param props - Macie module request properties (needed for Organizations client)
 * @param targetRegion - Target region (needed for Organizations client)
 * @returns Promise that resolves when delegated admin is disabled
 */
async function disableDelegatedAdminAccount(
  client: Macie2Client,
  serviceName: string,
  dryRun: boolean,
  logPrefix: string,
  props: IMacieModuleRequest,
  targetRegion: string,
): Promise<void> {
  // Create Organizations client for delegated admin management
  const organizationsClient = new OrganizationsClient({
    region: targetRegion,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials: props.credentials,
  });

  // Create delegated admin manager
  const adminManager = new DelegatedAdminManager<Macie2Client>(serviceName, organizationsClient, logger);

  // Disable delegated admin using the simplified interface
  await adminManager.disable(client, delegatedAdminOps, dryRun, logPrefix);
}
