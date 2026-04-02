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
 * @fileoverview Amazon Macie Session Configuration - Account-level Macie settings management
 *
 * Provides comprehensive session-level configuration management for Amazon Macie including
 * findings publication settings, classification export configuration, and Security Hub integration.
 * Handles account-specific Macie settings with proper validation and error handling.
 *
 * Key capabilities:
 * - Macie session configuration and updates
 * - Findings publication to Security Hub configuration
 * - Classification export to S3 setup
 * - Finding frequency and publication settings
 * - Account-specific S3 destination management
 */

import {
  AutoEnableMode,
  AutomatedDiscoveryStatus,
  ClassificationScopeUpdateOperation,
  FindingPublishingFrequency,
  ListClassificationScopesCommand,
  Macie2Client,
  MacieStatus,
  PutClassificationExportConfigurationCommand,
  PutFindingsPublicationConfigurationCommand,
  UpdateAutomatedDiscoveryConfigurationCommand,
  UpdateClassificationScopeCommand,
  UpdateMacieSessionCommand,
} from '@aws-sdk/client-macie2';
import path from 'node:path';
import { IAcceleratorEnvironment } from '../common/interfaces';
import { createLogger } from '../common/logger';
import { delay, executeApi } from '../common/utility';
import { IClassificationScopeBucketConfig, IMacieS3Destination } from './interfaces';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Abstract class for managing Amazon Macie session configurations
 */
export abstract class MacieSession {
  /**
   * Configures comprehensive Macie session settings for an account
   * @param props - Configuration properties object
   * @param props.env - Accelerator environment (account and region)
   * @param props.client - Macie2 client instance
   * @param props.s3Destination - S3 destination configuration for findings export
   * @param props.policyFindingsPublishingFrequency - Frequency for publishing policy findings
   * @param props.publishSensitiveDataFindings - Whether to publish sensitive data findings
   * @param props.publishPolicyFindings - Whether to publish policy findings
   * @param props.skipClassificationExport - When true, skips classification export configuration (used for non-delegated-admin accounts)
   * @param props.dryRun - Whether to perform dry run without making changes
   * @param props.logPrefix - Prefix for logging messages
   * @returns Promise that resolves when session is configured
   */
  public static async configure(props: {
    env: IAcceleratorEnvironment;
    client: Macie2Client;
    s3Destination: IMacieS3Destination;
    policyFindingsPublishingFrequency: FindingPublishingFrequency;
    publishSensitiveDataFindings: boolean;
    publishPolicyFindings: boolean;
    skipClassificationExport: boolean;
    dryRun: boolean;
    logPrefix: string;
  }): Promise<void> {
    await this.updateMacieSession(props.client, props.policyFindingsPublishingFrequency, props.dryRun, props.logPrefix);

    await this.configureFindingsPublication(
      props.client,
      props.publishSensitiveDataFindings,
      props.publishPolicyFindings,
      props.dryRun,
      props.logPrefix,
    );

    if (props.skipClassificationExport) {
      logger.info(`Skipping classification export configuration (delegated admin only)`, props.logPrefix);
    } else {
      logger.info(`Classification export configuration enabled for this account`, props.logPrefix);
      await this.configureClassificationExport(
        props.client,
        props.env,
        props.s3Destination,
        props.dryRun,
        props.logPrefix,
      );
    }
  }

  /**
   * Updates Macie session with findings publishing frequency
   * @param client - Macie2 client instance
   * @param findingPublishingFrequency - Frequency for publishing findings
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when session is updated
   */
  private static async updateMacieSession(
    client: Macie2Client,
    findingPublishingFrequency: FindingPublishingFrequency,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    if (dryRun) {
      logger.dryRun('UpdateMacieSessionCommand', { findingPublishingFrequency }, logPrefix);
    } else {
      await executeApi(
        'UpdateMacieSessionCommand',
        { findingPublishingFrequency },
        () =>
          client.send(
            new UpdateMacieSessionCommand({
              findingPublishingFrequency,
              status: MacieStatus.ENABLED,
            }),
          ),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Configures findings publication to Security Hub
   * @param client - Macie2 client instance
   * @param publishSensitiveDataFindings - Whether to publish sensitive data findings
   * @param publishPolicyFindings - Whether to publish policy findings
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when publication is configured
   */
  private static async configureFindingsPublication(
    client: Macie2Client,
    publishSensitiveDataFindings: boolean,
    publishPolicyFindings: boolean,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    if (dryRun) {
      logger.dryRun(
        'PutFindingsPublicationConfigurationCommand',
        { publishSensitiveDataFindings, publishPolicyFindings },
        logPrefix,
      );
    } else {
      await executeApi(
        'PutFindingsPublicationConfigurationCommand',
        { publishSensitiveDataFindings, publishPolicyFindings },
        () =>
          client.send(
            new PutFindingsPublicationConfigurationCommand({
              securityHubConfiguration: {
                publishClassificationFindings: publishSensitiveDataFindings,
                publishPolicyFindings: publishPolicyFindings,
              },
            }),
          ),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Configures classification export to S3
   * @param client - Macie2 client instance
   * @param env - Accelerator environment (account and region)
   * @param s3Destination - S3 destination configuration for findings export
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise that resolves when export is configured
   */
  private static async configureClassificationExport(
    client: Macie2Client,
    env: IAcceleratorEnvironment,
    s3Destination: IMacieS3Destination,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<void> {
    const destination: IMacieS3Destination = {
      bucketName: s3Destination.bucketName,
      kmsKeyArn: s3Destination.kmsKeyArn,
      keyPrefix: s3Destination.keyPrefix ?? 'macie/' + env.accountId,
    };

    if (dryRun) {
      logger.dryRun(
        'PutClassificationExportConfigurationCommand',
        {
          configuration: {
            destination,
          },
        },
        logPrefix,
      );
    } else {
      await executeApi(
        'PutClassificationExportConfigurationCommand',
        {
          configuration: {
            destination,
          },
        },
        () =>
          client.send(
            new PutClassificationExportConfigurationCommand({
              configuration: {
                s3Destination: destination,
              },
            }),
          ),
        logger,
        logPrefix,
      );
    }
  }

  /**
   * Configures automated sensitive data discovery on the delegated admin account
   * @param props - Configuration properties object
   * @param props.client - Macie2 client instance
   * @param props.enabled - Whether to enable or disable automated discovery
   * @param props.autoEnableOrganizationMembers - Whether to auto-enable discovery for member accounts
   * @param props.dryRun - Whether to perform dry run without making changes
   * @param props.logPrefix - Prefix for logging messages
   * @returns Promise that resolves when automated discovery is configured
   */
  public static async configureAutomatedDiscovery(props: {
    client: Macie2Client;
    enabled: boolean;
    autoEnableOrganizationMembers: AutoEnableMode;
    dryRun: boolean;
    logPrefix: string;
  }): Promise<void> {
    const status = props.enabled ? AutomatedDiscoveryStatus.ENABLED : AutomatedDiscoveryStatus.DISABLED;

    logger.info(
      `Configuring automated sensitive data discovery: ${status}, autoEnableOrganizationMembers: ${props.autoEnableOrganizationMembers}`,
      props.logPrefix,
    );

    const commandName = 'UpdateAutomatedDiscoveryConfigurationCommand';
    const parameters = { status, autoEnableOrganizationMembers: props.autoEnableOrganizationMembers };

    if (props.dryRun) {
      logger.dryRun(commandName, parameters, props.logPrefix);
    } else {
      await executeApi(
        commandName,
        parameters,
        () => props.client.send(new UpdateAutomatedDiscoveryConfigurationCommand(parameters)),
        logger,
        props.logPrefix,
      );
    }
  }

  /**
   * Updates the classification scope to exclude specific S3 buckets from automated sensitive data discovery.
   * Retrieves the classification scope ID first, then updates the exclusion list.
   * Executed only on the delegated admin account.
   *
   * The Macie UpdateClassificationScope API is regional — it only accepts buckets that exist
   * in the current AWS Region. This method filters the provided bucket list by `targetRegion`
   * so only region-local buckets are sent to the API. If no buckets match the target region,
   * the update is skipped entirely.
   *
   * Retries on ValidationException with exponential backoff to handle eventual consistency
   * after member account creation — Macie needs time to inventory cross-account buckets
   * before they can be referenced in classification scope exclusions.
   *
   * Retry schedule: 5s, 10s, 20s, 40s, 80s (5 attempts, ~2.5 minutes total).
   * If all retries are exhausted, the original ValidationException is thrown.
   *
   * @param props - Configuration properties object
   * @param props.client - Macie2 client instance (must be configured for the target region)
   * @param props.buckets - S3 buckets with their regions to exclude from automated discovery
   * @param props.operation - How to apply the changes (ADD, REMOVE, or REPLACE)
   * @param props.targetRegion - AWS region to filter buckets for and execute the API call against
   * @param props.dryRun - Whether to perform dry run without making changes
   * @param props.logPrefix - Prefix for logging messages
   * @returns Promise that resolves when classification scope is updated
   * @throws {ValidationException} After 5 retries if bucket still not found in Macie inventory
   */
  public static async updateClassificationScope(props: {
    client: Macie2Client;
    buckets: readonly IClassificationScopeBucketConfig[];
    operation: ClassificationScopeUpdateOperation;
    targetRegion: string;
    dryRun: boolean;
    logPrefix: string;
  }): Promise<void> {
    // Filter buckets to only those in the target region.
    // UpdateClassificationScope only accepts buckets that exist in the current AWS Region.
    const regionalBucketNames = props.buckets
      .filter(bucket => bucket.region === props.targetRegion)
      .map(bucket => bucket.name);

    if (regionalBucketNames.length === 0) {
      logger.info(
        `No buckets to exclude in region ${props.targetRegion} — skipping classification scope update`,
        props.logPrefix,
      );
      return;
    }

    logger.info(
      `Updating classification scope: ${props.operation} ${regionalBucketNames.length} bucket(s) in ${props.targetRegion}`,
      props.logPrefix,
    );

    // Retrieve the classification scope ID
    const listResponse = await executeApi(
      'ListClassificationScopesCommand',
      {},
      () => props.client.send(new ListClassificationScopesCommand({})),
      logger,
      props.logPrefix,
    );

    const scopeId = listResponse?.classificationScopes?.[0]?.id;
    if (!scopeId) {
      logger.info('No classification scope found — skipping update', props.logPrefix);
      return;
    }

    const commandName = 'UpdateClassificationScopeCommand';
    const parameters = {
      id: scopeId,
      s3: {
        excludes: {
          bucketNames: regionalBucketNames,
          operation: props.operation,
        },
      },
    };

    if (props.dryRun) {
      logger.dryRun(commandName, parameters, props.logPrefix);
      return;
    }

    // Retry with exponential backoff for eventual consistency after member creation.
    // Macie inventories cross-account buckets asynchronously — the bucket may not be
    // visible to UpdateClassificationScope immediately after CreateMember completes.
    const maxRetries = 6;
    const baseDelayMs = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await executeApi(
          commandName,
          parameters,
          () => props.client.send(new UpdateClassificationScopeCommand(parameters)),
          logger,
          props.logPrefix,
        );
        return;
      } catch (error: unknown) {
        const isValidationException = error instanceof Error && error.name === 'ValidationException';
        if (!isValidationException || attempt === maxRetries) {
          if (isValidationException && attempt === maxRetries) {
            const enrichedError = new Error(
              `${(error as Error).message}. ` +
                `Macie S3 bucket inventory may not have finished indexing bucket(s) [${regionalBucketNames.join(', ')}] in ${props.targetRegion}. ` +
                `This can happen when Macie is first enabled in a region or after member accounts are added. ` +
                `Please verify the buckets appear in the Macie S3 bucket inventory in the AWS Console, then re-run the pipeline.`,
            );
            enrichedError.name = (error as Error).name;
            throw enrichedError;
          }
          throw error;
        }
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        logger.info(
          `UpdateClassificationScope attempt ${attempt}/${maxRetries} failed (ValidationException). ` +
            `Bucket inventory may not be ready yet. Retrying in ${delayMs / 1000}s...`,
          props.logPrefix,
        );
        await delay(delayMs / 60000);
      }
    }
  }
}
