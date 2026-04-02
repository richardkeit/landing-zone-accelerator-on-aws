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
 * @fileoverview Security Service Module Response Builder - Builds complete module responses
 *
 * Provides a standalone utility class for building complete module responses for security services.
 * This class handles error extraction from operation results, status determination, and assembly
 * of the final IModuleResponse wrapper with proper error handling and status messages.
 *
 * Key capabilities:
 * - Extract regional errors from operation results
 * - Build successful and failed environment lists
 * - Determine final operation status (COMPLETED/FAILED)
 * - Generate descriptive status messages with regional context
 * - Assemble complete IModuleResponse with all metadata
 *
 * @example
 * ```typescript
 * const responseBuilder = new SecurityServiceModuleResponseBuilder(logger);
 *
 * const response = responseBuilder.build(
 *   'macie',
 *   'enable',
 *   macieResponse,
 *   operationResults,
 *   cleanupResults,
 *   false
 * );
 * ```
 */

import { IModuleResponse, IRegionOperationError, ISecurityServiceModuleResponse } from '../interfaces';
import { IconLogger } from '../logger';
import { MODULE_STATE_CODE } from '../types';

/**
 * Builds complete module responses for security service operations
 *
 * This is a standalone utility class that handles the final assembly of module responses.
 * It extracts errors from operation results, determines status, builds descriptive messages,
 * and wraps everything in a complete IModuleResponse structure.
 */
export class SecurityServiceModuleResponseBuilder {
  private readonly logger: IconLogger;

  /**
   * Creates a new SecurityServiceModuleResponseBuilder instance
   *
   * @param logger - Logger instance for operation logging
   */
  constructor(logger: IconLogger) {
    this.logger = logger;
  }

  /**
   * Builds a complete module response from operation results
   *
   * Performs the following operations:
   * 1. Combines operation and cleanup results
   * 2. Extracts regional errors and builds environment lists
   * 3. Adds error information to service response if needed
   * 4. Determines final status (COMPLETED/FAILED)
   * 5. Builds descriptive status message
   * 6. Assembles complete IModuleResponse with metadata
   *
   * @param moduleName - Module name (e.g., 'macie', 'guardduty')
   * @param operation - Operation type (e.g., 'enable', 'disable')
   * @param serviceResponse - Service-specific response data
   * @param operationResults - Results from regional operations (may contain errors)
   * @param cleanupResults - Results from cleanup operations (may contain errors)
   * @param dryRun - Whether this was a dry run operation
   * @returns Complete module response with status, summary, and service data
   */
  build<TServiceResponse extends ISecurityServiceModuleResponse>(
    moduleName: string,
    operation: string,
    serviceResponse: TServiceResponse,
    operationResults: (void | IRegionOperationError)[],
    cleanupResults: (void | IRegionOperationError)[],
    dryRun: boolean,
  ): IModuleResponse<TServiceResponse> {
    this.logger.info(`Building module response for ${moduleName} ${operation}`);

    // Step 1: Combine all results
    const allResults = [...operationResults, ...cleanupResults];
    this.logger.info(`Processing ${allResults.length} total operation results`);

    // Step 2: Extract errors and build environment lists
    const { regionErrors, failedEnvs, successfulEnvs } = this.extractErrors(allResults, serviceResponse);

    this.logger.info(
      `Extracted ${regionErrors.length} errors, ${failedEnvs.length} failed environments, ${successfulEnvs.length} successful environments`,
    );

    // Step 3: Add error information to service response if needed
    const responseWithErrors = this.addErrorsToResponse(serviceResponse, regionErrors, failedEnvs, successfulEnvs);

    // Step 4: Determine final status
    const hasErrors = regionErrors.length > 0;
    const status = hasErrors ? MODULE_STATE_CODE.FAILED : MODULE_STATE_CODE.COMPLETED;

    this.logger.info(`Final status: ${status}`);

    // Step 5: Build status message
    const statusMessage = this.buildStatusMessage(
      moduleName,
      operation,
      hasErrors,
      dryRun,
      regionErrors,
      successfulEnvs,
    );

    // Step 6: Assemble complete response
    const response: IModuleResponse<TServiceResponse> = {
      status,
      summary: statusMessage,
      timestamp: new Date().toISOString(),
      moduleName,
      dryRun,
      response: responseWithErrors,
    };

    // Add error object if there are regional errors
    if (hasErrors) {
      const uniqueErrorNames = [...new Set(regionErrors.map(err => err.errorName))];
      const errorName = uniqueErrorNames.length === 1 ? uniqueErrorNames[0] : 'MultipleErrors';

      response.error = {
        name: errorName,
        message: statusMessage,
      };

      this.logger.info(`Added error object to response: ${errorName}`);
    }

    this.logger.info(`Module response built successfully`);

    return response;
  }

  /**
   * Builds an error response for top-level module errors
   *
   * Used when an error occurs before operation results are available.
   * Creates a complete error response with the service response data.
   *
   * @param error - The error that occurred
   * @param moduleName - Module name
   * @param operation - Operation type
   * @param dryRun - Whether this was a dry run
   * @param serviceResponse - Service-specific response data
   * @returns Complete error response
   */
  buildErrorResponse<TServiceResponse extends ISecurityServiceModuleResponse>(
    error: unknown,
    moduleName: string,
    operation: string,
    dryRun: boolean,
    serviceResponse: TServiceResponse,
  ): IModuleResponse<TServiceResponse> {
    let errorMessage = String(error);
    let errorName = 'UnknownError';

    if (error instanceof Error) {
      errorMessage = error.message;
      errorName = error.name;
    }

    this.logger.error(`Building error response: ${errorName} - ${errorMessage}`);

    // Check if service response has regional errors
    const hasRegionalErrors = serviceResponse.environmentErrors && serviceResponse.environmentErrors.length > 0;
    let finalErrorName = errorName;

    if (hasRegionalErrors) {
      const regionErrors = serviceResponse.environmentErrors as IRegionOperationError[];
      const uniqueErrorNames = [...new Set(regionErrors.map(err => err.errorName))];
      finalErrorName = uniqueErrorNames.length === 1 ? uniqueErrorNames[0] : 'MultipleErrors';
    }

    const summary = `${moduleName} ${operation} failed with error: ${errorMessage}`;

    return {
      error: {
        name: finalErrorName,
        message: errorMessage,
      },
      status: MODULE_STATE_CODE.FAILED,
      summary,
      timestamp: new Date().toISOString(),
      moduleName,
      dryRun,
      response: serviceResponse,
    };
  }

  /**
   * Extracts regional errors from operation results
   *
   * Processes all operation results to separate errors from successes.
   * Builds lists of failed and successful environments.
   *
   * @param results - Combined operation and cleanup results
   * @param serviceResponse - Service response to extract successful environments from
   * @returns Object containing regionErrors, failedEnvs, and successfulEnvs arrays
   */
  private extractErrors<TServiceResponse extends ISecurityServiceModuleResponse>(
    results: (void | IRegionOperationError)[],
    serviceResponse: TServiceResponse,
  ): {
    regionErrors: IRegionOperationError[];
    failedEnvs: string[];
    successfulEnvs: string[];
  } {
    const regionErrors: IRegionOperationError[] = [];
    const failedEnvs: string[] = [];
    const successfulEnvs: string[] = [];

    // Extract errors from results
    for (const result of results) {
      if (result && typeof result === 'object' && 'errorName' in result) {
        const error = result as IRegionOperationError;
        regionErrors.push({
          region: error.region,
          accountId: error.accountId,
          accountName: error.accountName,
          errorName: error.errorName,
          errorMessage: error.errorMessage,
        });

        const failedEnv = `${error.accountId}:${error.region}`;
        if (!failedEnvs.includes(failedEnv)) {
          failedEnvs.push(failedEnv);
        }
      }
    }

    // Build successful environments from service response
    this.buildSuccessfulEnvironments(serviceResponse, failedEnvs, successfulEnvs);

    return { regionErrors, failedEnvs, successfulEnvs };
  }

  /**
   * Builds successful environments list from service response data
   *
   * Extracts account-region combinations from the service response configuration
   * and excludes any that appear in the failed environments list.
   *
   * @param serviceResponse - Service-specific response data
   * @param failedEnvs - List of failed environments to exclude
   * @param successfulEnvs - List to populate with successful environments
   */
  private buildSuccessfulEnvironments<TServiceResponse extends ISecurityServiceModuleResponse>(
    serviceResponse: TServiceResponse,
    failedEnvs: string[],
    successfulEnvs: string[],
  ): void {
    // Extract successful environments from organizationAdminConfig
    if (serviceResponse.organizationAdminConfig) {
      for (const config of serviceResponse.organizationAdminConfig) {
        for (const region of config.regions) {
          const env = `${config.managementAccountId}:${region}`;
          if (!failedEnvs.includes(env) && !successfulEnvs.includes(env)) {
            successfulEnvs.push(env);
          }
        }
      }
    }

    // Extract successful environments from delegatedAdminAccountConfig
    if (serviceResponse.delegatedAdminAccountConfig) {
      for (const config of serviceResponse.delegatedAdminAccountConfig) {
        for (const region of config.regions) {
          for (const accountId of config.memberAccountIds) {
            const env = `${accountId}:${region}`;
            if (!failedEnvs.includes(env) && !successfulEnvs.includes(env)) {
              successfulEnvs.push(env);
            }
          }
        }
      }
    }

    this.logger.info(`Built ${successfulEnvs.length} successful environments from service response`);
  }

  /**
   * Adds regional error information to the service response
   *
   * If there are errors, adds regionErrors, failedEnvs, and successfulEnvs
   * properties to the service response object.
   *
   * @param serviceResponse - Service-specific response data
   * @param regionErrors - List of regional errors
   * @param failedEnvs - List of failed environments
   * @param successfulEnvs - List of successful environments
   * @returns Response with error information added (if applicable)
   */
  private addErrorsToResponse<TServiceResponse extends ISecurityServiceModuleResponse>(
    serviceResponse: TServiceResponse,
    regionErrors: IRegionOperationError[],
    failedEnvs: string[],
    successfulEnvs: string[],
  ): TServiceResponse {
    if (regionErrors.length > 0) {
      this.logger.info(`Adding ${regionErrors.length} regional errors to response`);

      // Add error information to response
      serviceResponse.environmentErrors = regionErrors;
      serviceResponse.failedEnvironments = failedEnvs;

      if (successfulEnvs.length > 0) {
        serviceResponse.successfulEnvs = successfulEnvs;
      }
    }

    return serviceResponse;
  }

  /**
   * Builds the status message for the module response
   *
   * Creates a descriptive message that includes:
   * - Module name and operation
   * - Dry-run indicator (if applicable)
   * - Success/failure status
   * - Regional error details (if applicable)
   * - Successful regions summary (if there are partial failures)
   *
   * @param moduleName - Module name
   * @param operation - Operation type
   * @param hasErrors - Whether there are errors
   * @param dryRun - Whether this was a dry run
   * @param regionErrors - List of regional errors
   * @param successfulEnvs - List of successful environments
   * @returns Descriptive status message
   */
  private buildStatusMessage(
    moduleName: string,
    operation: string,
    hasErrors: boolean,
    dryRun: boolean,
    regionErrors: IRegionOperationError[],
    successfulEnvs: string[],
  ): string {
    let statusMessage: string;

    // Build base message
    if (dryRun) {
      statusMessage = hasErrors
        ? `${moduleName} ${operation} (dry-run) failed`
        : `${moduleName} ${operation} (dry-run) completed`;
    } else {
      statusMessage = hasErrors ? `${moduleName} ${operation} failed` : `${moduleName} ${operation} completed`;
    }

    // Add regional context if there are errors
    if (hasErrors) {
      // Group errors by region and error type
      const regionErrorMap = new Map<string, Set<string>>();

      for (const error of regionErrors) {
        if (!regionErrorMap.has(error.region)) {
          regionErrorMap.set(error.region, new Set());
        }
        regionErrorMap.get(error.region)!.add(error.errorName);
      }

      // Build error details string
      const errorDetails = Array.from(regionErrorMap.entries())
        .map(([region, errorTypes]) => {
          const types = Array.from(errorTypes);
          if (types.length === 1) {
            return `${region} (${types[0]})`;
          } else {
            return `${region} (MultipleErrors)`;
          }
        })
        .join(', ');

      statusMessage += ` in ${errorDetails}`;

      // Add successful regions summary if there are partial failures
      if (successfulEnvs.length > 0) {
        const successfulRegions = [...new Set(successfulEnvs.map(env => env.split(':')[1]))];
        statusMessage += `. Successfully completed in ${successfulRegions.join(', ')}`;
      }
    }

    this.logger.info(`Built status message: ${statusMessage}`);

    return statusMessage;
  }
}
