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
 * @fileoverview Amazon Macie CLI Command Handler - Processes Macie CLI commands and configuration
 *
 * Provides command handling and configuration validation for Amazon Macie CLI operations.
 * Handles parameter parsing, configuration validation, and execution coordination for
 * Macie setup and management across AWS Organizations.
 *
 * Key capabilities:
 * - CLI parameter parsing and validation
 * - Macie configuration schema validation
 * - Session context management
 * - Error handling and user feedback
 * - Integration with Macie module operations
 */

import { z } from 'zod';

import { configureMacie } from '../../../lib/amazon-macie/macie';

import { IMacieConfiguration, IMacieModuleRequest, IMacieModuleResponse } from '../../../lib/amazon-macie/interfaces';
import { IModuleResponse } from '../../common/interfaces';
import {
  CliExecutionParameterType,
  ConfigurationObjectType,
  getConfig,
  getSessionDetailsFromArgs,
  logError,
  logErrorAndExit,
} from './root';

const macieConfigSchema = z.object({
  enable: z.boolean(),
  accountAccessRoleName: z.string(),
  delegatedAdminAccountId: z.string(),
  regionFilters: z
    .object({
      ignoredRegions: z.array(z.string()).optional(),
      disabledRegions: z.array(z.string()).optional(),
    })
    .optional(),
  policyFindingsPublishingFrequency: z.string(),
  publishSensitiveDataFindings: z.boolean(),
  publishPolicyFindings: z.boolean(),
  s3Destination: z.object({
    bucketName: z.string(),
    keyPrefix: z.string(),
    kmsKeyArn: z.string(),
  }),
  automatedDiscoveryEnabled: z.boolean().optional(),
  boundary: z
    .object({
      regions: z.array(z.string()).optional(),
    })
    .optional(),
  dataSources: z
    .object({
      organizations: z
        .object({
          tableName: z.string(),
          filters: z.array(z.any()).optional(),
          filterOperator: z.enum(['AND', 'OR']).optional(),
        })
        .optional(),
    })
    .optional(),
  batchOperationSettings: z
    .object({
      maxConcurrentEnvironments: z.number().gt(0).optional(),
      operationTimeoutMs: z.number().gt(0).optional(),
    })
    .optional(),
});

/**
 * Abstract command handler class for Amazon Macie CLI operations
 */
export abstract class MacieCommand {
  /**
   * Executes the Macie configuration command with validated parameters
   * @param param - CLI execution parameters
   * @returns Promise resolving to Macie module response
   */
  public static async execute(param: CliExecutionParameterType): Promise<IModuleResponse<IMacieModuleResponse>> {
    return configureMacie(await MacieCommand.getParams(param));
  }

  /**
   * Parses and validates CLI parameters to create Macie module request
   * @param param - CLI execution parameters
   * @returns Promise resolving to validated Macie module request
   */
  public static async getParams(param: CliExecutionParameterType): Promise<IMacieModuleRequest> {
    if (typeof param.args['configuration'] !== 'string') {
      logErrorAndExit(
        'An error occurred (MissingRequiredParameters): The configuration parameter is a required string',
      );
    }

    const config = getConfig(param.args['configuration']);
    if (!MacieCommand.validConfig(config)) {
      process.exit(1);
    }

    // Get current session details
    const currentSessionDetails = await getSessionDetailsFromArgs(param);

    return {
      ...currentSessionDetails,
      moduleName: param.moduleName,
      operation: param.commandName,
      dryRun: param.args['dry-run'] as boolean,
      configuration: {
        accountAccessRoleName: config['accountAccessRoleName'],
        enable: config['enable'],
        delegatedAdminAccountId: config['delegatedAdminAccountId'],
        policyFindingsPublishingFrequency: config['policyFindingsPublishingFrequency'],
        publishSensitiveDataFindings: config['publishSensitiveDataFindings'],
        publishPolicyFindings: config['publishPolicyFindings'],
        s3Destination: config['s3Destination'],
        ...(config['regionFilters'] && { regionFilters: config['regionFilters'] }),
        ...(config['boundary'] && { boundary: config['boundary'] }),
        ...(config['dataSources'] && { dataSources: config['dataSources'] }),
        ...(config['batchOperationSettings'] && { batchOperationSettings: config['batchOperationSettings'] }),
        automatedDiscoveryEnabled: config['automatedDiscoveryEnabled'] ?? false,
      },
    };
  }

  /**
   * Validates Macie configuration object against required schema
   * @param config - Configuration object to validate
   * @returns Type guard indicating if config is valid IMacieConfiguration
   */
  public static validConfig(config: ConfigurationObjectType): config is IMacieConfiguration {
    const result = macieConfigSchema.safeParse(config);
    if (!result.success) {
      const issue = result.error.issues[0];
      logError(`(ConfigValidation): config.${issue.path.join('.')}: ${issue.message}`);
      return false;
    }
    return true;
  }
}
