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
 * @fileoverview Common configuration extraction and loading utilities for LZA modules.
 *
 * @description
 * This module provides reusable functions for extracting and loading configuration data
 * that is commonly needed across multiple LZA modules. It includes:
 *
 * - Organization data source loading from DynamoDB
 * - Security service metadata extraction for state comparison
 * - Common organizational metadata (accounts, regions, delegated admin)
 *
 * These utilities help reduce code duplication across module actions and ensure
 * consistent patterns for configuration handling.
 */

import {
  createLogger,
  createStatusLogger,
  DynamoDBFilterOperator,
  getParametersValue,
  type IAssumeRoleCredential,
  type IDynamoDBFilter,
} from 'aws-lza';
import path from 'node:path';
import type { ModuleParams } from '../../types';
import { calculateArrayHash } from './module-state';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Status logger instance for tracking configuration loading milestones.
 *
 * @private
 * @constant
 *
 * @description
 * Provides structured logging for important configuration loading milestones that should
 * be visible regardless of LOG_LEVEL setting. Uses the filename as the logger context
 * for easy identification in log aggregation systems.
 */
const statusLogger = createStatusLogger([path.parse(path.basename(__filename)).name]);

/**
 * Security service organizational metadata.
 * Common metadata that all security services need for state comparison.
 */
export interface ISecurityServiceMetadata {
  /** Number of accounts in the organization */
  readonly accountsCount: number;

  /** Hash of sorted account IDs for detecting account replacements */
  readonly accountsHash: string;

  /** Number of enabled regions */
  readonly enabledRegionsCount: number;

  /** Hash of sorted enabled regions for detecting region replacements */
  readonly enabledRegionsHash: string;

  /** Delegated administrator account ID (typically audit account) */
  readonly delegatedAdminAccountId: string;
}

/**
 * Extract organizational metadata for security services.
 *
 * @description
 * Extracts common organizational metadata that all security services need for
 * state comparison. This includes account and region information with counts
 * and hashes for detecting changes, plus the delegated admin account.
 *
 * This function is specifically for security services (Macie, GuardDuty,
 * Security Hub, Detective) that use a delegated administrator pattern.
 * Non-security services should extract metadata manually as they may not
 * need all these fields.
 *
 * @param params - Module parameters containing account and region configuration
 * @returns Security service metadata with counts, hashes, and delegated admin
 *
 * @example
 * ```typescript
 * // In Macie action
 * private static extractMacieConfig(params: ModuleParams): IMacieConfigForState {
 *   const macieConfig = params.moduleRunnerParameters.configs.securityConfig.centralSecurityServices.macie!;
 *   const securityMetadata = extractSecurityServiceMetadata(params);
 *
 *   return {
 *     // Macie-specific fields
 *     enable: macieConfig.enable,
 *     policyFindingsPublishingFrequency: macieConfig.policyFindingsPublishingFrequency,
 *     // ... other Macie fields
 *
 *     // Common security service metadata
 *     ...securityMetadata,
 *   };
 * }
 * ```
 *
 * @example
 * ```typescript
 * // In GuardDuty action (future)
 * private static extractGuardDutyConfig(params: ModuleParams): IGuardDutyConfigForState {
 *   const guardDutyConfig = params.moduleRunnerParameters.configs.securityConfig.centralSecurityServices.guardduty!;
 *   const securityMetadata = extractSecurityServiceMetadata(params);
 *
 *   return {
 *     // GuardDuty-specific fields
 *     enable: guardDutyConfig.enable,
 *     exportConfiguration: guardDutyConfig.exportConfiguration,
 *     // ... other GuardDuty fields
 *
 *     // Common security service metadata (same as Macie)
 *     ...securityMetadata,
 *   };
 * }
 * ```
 */
export function extractSecurityServiceMetadata(params: ModuleParams): ISecurityServiceMetadata {
  const accountIds = params.moduleRunnerParameters.configs.accountsConfig.getAccountIds();
  const enabledRegions = params.moduleRunnerParameters.configs.globalConfig.enabledRegions;

  return {
    // Account information
    accountsCount: accountIds.length,
    accountsHash: calculateArrayHash(accountIds),

    // Region information
    enabledRegionsCount: enabledRegions.length,
    enabledRegionsHash: calculateArrayHash(enabledRegions),

    // Delegated admin (common for all security services)
    delegatedAdminAccountId: params.moduleRunnerParameters.configs.accountsConfig.getAuditAccountId(),
  };
}

/**
 * Get the IAM condition context key for the organization or account list.
 *
 * @description
 * Returns the appropriate IAM condition for bucket policies and KMS key policies
 * based on the deployment model:
 * - For Organizations deployments: Returns `aws:PrincipalOrgID` condition
 * - For China partition or non-Organizations: Returns `aws:PrincipalAccount` condition with account list
 *
 * This function provides the same logic as `AcceleratorStack.getPrincipalOrgIdCondition()`
 * but is available for module actions that don't extend AcceleratorStack.
 *
 * @param params - Module parameters containing partition, organization config, and account list
 * @returns Condition object with either aws:PrincipalOrgID or aws:PrincipalAccount
 * @throws {Error} When organization is enabled but organization ID is not found
 * @throws {Error} When organization is disabled but account IDs are not found
 *
 * @example
 * ```typescript
 * // In bootstrap action for S3 bucket policy
 * const principalCondition = getPrincipalOrgIdCondition(params);
 * const policy = {
 *   Version: '2012-10-17',
 *   Statement: [{
 *     Effect: 'Allow',
 *     Principal: { AWS: '*' },
 *     Action: ['s3:GetObject'],
 *     Resource: `arn:${partition}:s3:::${bucketName}/*`,
 *     Condition: {
 *       StringEquals: principalCondition,
 *     },
 *   }],
 * };
 * ```
 *
 * @example
 * ```typescript
 * // In KMS key policy
 * const principalCondition = getPrincipalOrgIdCondition(params);
 * const keyPolicy = {
 *   Statement: [{
 *     Sid: 'Enable IAM User Permissions',
 *     Effect: 'Allow',
 *     Principal: { AWS: '*' },
 *     Action: 'kms:*',
 *     Resource: '*',
 *     Condition: {
 *       StringEquals: principalCondition,
 *     },
 *   }],
 * };
 * ```
 */
export function getPrincipalOrgIdCondition(params: ModuleParams): { [key: string]: string | string[] } {
  const partition = params.runnerParameters.sessionContext.partition;
  const organizationEnabled = params.moduleRunnerParameters.configs.organizationConfig?.enable ?? false;
  const isChina = partition === 'aws-cn';

  // Use account list for China partition or when Organizations is not enabled
  if (isChina || !organizationEnabled) {
    const accountIds = params.moduleRunnerParameters.organizationAccounts
      .map(account => account.Id)
      .filter((id): id is string => id !== undefined);

    if (accountIds && accountIds.length > 0) {
      return {
        'aws:PrincipalAccount': accountIds,
      };
    }

    throw new Error('Account IDs not found but required for non-organization deployment');
  }

  // Use organization ID for standard deployments
  const orgId = params.moduleRunnerParameters.organizationDetails?.Id;
  if (orgId) {
    return {
      'aws:PrincipalOrgID': orgId,
    };
  }

  throw new Error('Organization ID not found but organization is enabled');
}

/**
 * Get the S3 bucket name for CloudFormation retention templates.
 *
 * @description
 * Returns the CDK bootstrap bucket name used to store modified CloudFormation templates
 * during resource retention operations. The CFN retention workflow uploads templates with
 * retention policies applied to this bucket before deploying stacks.
 *
 * The bucket uses the CDK bootstrap naming convention:
 * `cdk-accel-assets-{accountId}-{globalRegion}`
 *
 * Where:
 * - `accel` = CDK qualifier used by LZA (hardcoded)
 * - `accountId` = Management account ID
 * - `globalRegion` = Global region where CDK bootstrap was performed
 *
 * The function always returns the global region bucket, as CloudFormation supports
 * cross-region S3 template access. This eliminates the need for regional buckets
 * and simplifies infrastructure. The global region is used because CDK bootstrap
 * happens in the global region, not necessarily the home region.
 *
 * Templates are stored under the `cfn-retention/` prefix to separate them from CDK assets.
 *
 * @param params - Module parameters containing session context with global region
 * @returns CDK bootstrap bucket name in global region
 *
 * @example
 * ```typescript
 * // Get bucket name for CFN retention
 * const bucketName = getCfnRetentionBucketName(params);
 * // bucketName = "cdk-accel-assets-XXXXXXXXXXXX-us-east-1"
 *
 * // Upload template with cfn-retention prefix
 * const s3Key = `cfn-retention/${stackName}-${timestamp}.json`;
 * await s3.putObject({ Bucket: bucketName, Key: s3Key, Body: template });
 * ```
 *
 * @example
 * ```typescript
 * // CloudFormation can deploy from global region bucket in any region
 * const bucketName = getCfnRetentionBucketName(params);
 * const globalRegion = params.runnerParameters.sessionContext.globalRegion;
 * const templateUrl = `https://${bucketName}.s3.${globalRegion}.amazonaws.com/cfn-retention/stack.json`;
 *
 * // Deploy stack in us-west-2 using template from us-east-1 bucket
 * await cfn.createStack({
 *   StackName: 'MyStack',
 *   TemplateURL: templateUrl,
 *   Region: 'us-west-2'
 * });
 * ```
 */
export function getCfnRetentionBucketName(params: ModuleParams): string {
  const managementAccountId = params.moduleRunnerParameters.configs.accountsConfig.getManagementAccountId();
  return `cdk-accel-assets-${managementAccountId}-${params.runnerParameters.sessionContext.globalRegion}`;
}

/**
 * Load organizational data sources from DynamoDB.
 *
 * @description
 * Loads organization data from DynamoDB table for modules that need to query
 * organizational information. This is a common pattern across all LZA modules
 * (security services, network services, operations services, etc.) that need
 * to access AWS Organizations data.
 *
 * The function:
 * 1. Checks if DynamoDB loading is enabled
 * 2. Retrieves the DynamoDB table name from SSM Parameter Store
 * 3. Returns data source configuration with appropriate filters
 *
 * @param params - Module parameters containing session context and configuration
 * @param logPrefix - Logging prefix for consistent log formatting
 * @returns Data sources configuration or undefined if DynamoDB loading is disabled
 *
 * @throws {Error} When SSM parameter is not found
 * @throws {Error} When SSM parameter has no value
 *
 * @example
 * ```typescript
 * // In Macie action
 * private static async buildMacieRequest(params: ModuleParams, logPrefix: string) {
 *   const dataSources = await loadOrganizationDataSources(params, logPrefix);
 *
 *   return {
 *     operation: 'setup',
 *     configuration: {
 *       // ... Macie config
 *       dataSources,  // Include org data sources
 *     },
 *   };
 * }
 * ```
 *
 * @example
 * ```typescript
 * // In Network action (future)
 * private static async configureNetworking(params: ModuleParams, logPrefix: string) {
 *   const dataSources = await loadOrganizationDataSources(params, logPrefix);
 *
 *   // Use org data to configure networking across accounts
 *   // ...
 * }
 * ```
 */
/**
 * Retrieves the DynamoDB config table name from SSM Parameter Store.
 *
 * @description
 * Looks up the config table name created by the Prepare stack via SSM parameter.
 * Handles validation and consistent error messaging. For external deployments,
 * management account credentials must be provided since the SSM parameter
 * lives in the management account.
 *
 * @param ssmParamPrefix - SSM parameter name prefix (e.g. '/accelerator')
 * @param region - AWS region for the SSM lookup
 * @param logPrefix - Logging prefix
 * @param solutionId - Optional solution identifier for user agent
 * @param credentials - Optional management account credentials for cross-account access
 * @returns The config table name
 * @throws {Error} When the SSM parameter is not found or has no value
 */
export async function getOrganizationSourceTableName(
  ssmParamPrefix: string,
  region: string,
  logPrefix: string,
  solutionId?: string,
  credentials?: IAssumeRoleCredential,
): Promise<string> {
  const parameterName = `${ssmParamPrefix}/prepare-stack/configTable/name`;
  logger.info(`Getting Organizations data source DynamoDB table name from SSM parameter ${parameterName}`, logPrefix);

  const tableNameParameter = await getParametersValue(
    [parameterName],
    region,
    logPrefix,
    undefined,
    solutionId,
    credentials,
  );

  if (tableNameParameter.length !== 1) {
    const message = `Parameter not found: ${parameterName}`;
    logger.error(message, logPrefix);
    throw new Error(message);
  }

  if (!tableNameParameter[0].Value) {
    const message = `Parameter value not found: ${parameterName}`;
    logger.error(message, logPrefix);
    throw new Error(message);
  }

  const tableName = tableNameParameter[0].Value;
  logger.info(`Organizations data source DynamoDB table name: ${tableName}`, logPrefix);
  return tableName;
}

export async function loadOrganizationDataSources(
  params: ModuleParams,
  logPrefix: string,
): Promise<{ organizations: { tableName: string; filters: IDynamoDBFilter[] } } | undefined> {
  if (!params.runnerParameters.loadOrganizationsFromDynamoDbTable) {
    return undefined;
  }

  statusLogger.info('Loading Organizations information from DynamoDB table', logPrefix);

  const tableName = await getOrganizationSourceTableName(
    params.moduleRunnerParameters.resourcePrefixes.ssmParamName,
    params.runnerParameters.sessionContext.region,
    logPrefix,
    params.runnerParameters.solutionId,
    params.moduleRunnerParameters.managementAccountCredentials,
  );

  statusLogger.info(`Organizations data source DynamoDB table: ${tableName}`, logPrefix);

  return {
    organizations: {
      tableName,
      filters: [
        {
          name: 'commitId',
          value: process.env['CONFIG_COMMIT_ID'] ?? '',
        },
        {
          name: 'awsKey',
          operator: DynamoDBFilterOperator.ATTRIBUTE_EXISTS,
        },
      ],
    },
  };
}
