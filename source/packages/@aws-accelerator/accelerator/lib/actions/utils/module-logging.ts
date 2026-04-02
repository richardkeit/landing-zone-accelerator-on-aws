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
 * @fileoverview Common logging utilities for module execution results.
 *
 * @description
 * This module provides standardized logging functions for module execution results across
 * all LZA modules (Macie, GuardDuty, StackResources, etc.). It ensures consistent logging
 * format, error handling, and status reporting across the entire codebase.
 *
 * **Key Features:**
 * - Consistent logging format across all modules
 * - Detailed error logging with environment-specific failures
 * - Success/failure status reporting
 * - JSON serialization of complete status for debugging
 *
 * @example
 * ```typescript
 * import { logModuleExecutionResult } from '../utils/module-logging';
 *
 * // In your module
 * const result = await someModule.execute(params);
 * logModuleExecutionResult(
 *   result,
 *   'macie',
 *   logPrefix,
 *   logger,
 *   statusLogger
 * );
 * ```
 */

import type { IconLogger, IModuleResponse } from 'aws-lza';

/**
 * Logs the execution result of a module with consistent formatting.
 *
 * @description
 * This function provides standardized logging for module execution results. It handles
 * both success and failure cases, logging appropriate details for each scenario.
 *
 * **Success Case Logs:**
 * - Module completion status
 * - Summary message
 * - Complete status JSON (for debugging)
 *
 * **Failure Case Logs:**
 * - Error name and message
 * - Module failure status
 * - Summary message
 * - Failed environments (if applicable)
 * - Regional errors with details (if applicable)
 * - Complete status JSON (for debugging)
 *
 * @template T - Type of the module-specific response data (optional)
 *
 * @param {IModuleResponse<T>} status - Module execution result containing status, summary, and optional response data
 * @param {string} moduleName - Name of the module (e.g., 'macie', 'guardduty', 'stack-resources-retention')
 * @param {string} logPrefix - Log prefix for consistent log formatting (format: accountId:region)
 * @param {Logger} logger - Logger instance for detailed logging
 * @param {StatusLogger} statusLogger - Status logger instance for high-level status updates
 *
 * @returns {void}
 *
 * @example
 * ```typescript
 * // Example 1: Logging Macie configuration result
 * const macieResult = await configureMacie(params);
 * logModuleExecutionResult(
 *   macieResult,
 *   'macie',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 *
 * // Example 2: Logging stack resources retention result
 * const retentionResult = await StackResources.retain(params);
 * logModuleExecutionResult(
 *   retentionResult,
 *   'stack-resources-retention',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 *
 * // Example 3: Logging with module-specific response data
 * interface ICustomResponse {
 *   processedItems: number;
 *   failedItems: string[];
 * }
 *
 * const result: IModuleResponse<ICustomResponse> = {
 *   status: 'COMPLETED',
 *   summary: 'Processed 10 items',
 *   response: {
 *     processedItems: 10,
 *     failedItems: []
 *   }
 * };
 *
 * logModuleExecutionResult(
 *   result,
 *   'custom-module',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 * ```
 */

/**
 * Helper function to log failed environments from module response.
 * Reduces cognitive complexity by extracting nested conditional logic.
 *
 * @template T - Type of the module response object
 * @param {T} response - Module response object
 * @param {IconLogger} logger - Logger instance
 * @returns {void}
 *
 * @private
 */
function logFailedEnvironments<T>(response: T, logger: IconLogger): void {
  if (!response || typeof response !== 'object' || !('failedEnvironments' in response)) {
    return;
  }

  const failedEnvironments = (response as { failedEnvironments?: string[] }).failedEnvironments;
  if (failedEnvironments && Array.isArray(failedEnvironments) && failedEnvironments.length > 0) {
    logger.error(`Failed Environments: ${failedEnvironments.join(', ')}`);
  }
}

/**
 * Helper function to log environment errors from module response.
 * Reduces cognitive complexity by extracting nested conditional logic.
 *
 * @template T - Type of the module response object
 * @param {T} response - Module response object
 * @param {IconLogger} logger - Logger instance
 * @returns {void}
 *
 * @private
 */
function logEnvironmentErrors<T>(response: T, logger: IconLogger): void {
  if (!response || typeof response !== 'object' || !('environmentErrors' in response)) {
    return;
  }

  const environmentErrors = (response as { environmentErrors?: unknown[] }).environmentErrors;
  if (environmentErrors && Array.isArray(environmentErrors) && environmentErrors.length > 0) {
    logger.error(`Regional Errors: ${JSON.stringify(environmentErrors, null, 2)}`);
  }
}

/**
 * Helper function to log error details from module execution.
 * Reduces cognitive complexity by extracting error logging logic.
 *
 * @template T - Type of the module-specific response data
 * @param {IModuleResponse<T>} status - Module execution response
 * @param {string} moduleName - Name of the module
 * @param {string} logPrefix - Log prefix for consistent formatting
 * @param {IconLogger} logger - Logger instance
 * @returns {void}
 *
 * @private
 */
function logErrorDetails<T>(
  status: IModuleResponse<T>,
  moduleName: string,
  logPrefix: string,
  logger: IconLogger,
): void {
  logger.error(`Error in module ${moduleName}. Error: ${status.error!.name} - ${status.error!.message}`, logPrefix);
  logger.error(`Failed module ${moduleName} with status ${status.status}`);
  logger.error(`Summary: ${status.summary}`);

  logFailedEnvironments(status.response, logger);
  logEnvironmentErrors(status.response, logger);
}

/**
 * Helper function to log success details from module execution.
 * Reduces cognitive complexity by extracting success logging logic.
 *
 * @template T - Type of the module-specific response data
 * @param {IModuleResponse<T>} status - Module execution response
 * @param {string} moduleName - Name of the module
 * @param {IconLogger} logger - Logger instance
 * @returns {void}
 *
 * @private
 */
function logSuccessDetails<T>(status: IModuleResponse<T>, moduleName: string, logger: IconLogger): void {
  logger.info(`Status Summary: ${status.summary}`);
  logger.processEnd(`Completed module ${moduleName} with status ${status.status}`);
}

/**
 * Logs the execution result of a module with consistent formatting.
 *
 * @description
 * This function provides standardized logging for module execution results. It handles
 * both success and failure cases, logging appropriate details for each scenario.
 *
 * **Success Case Logs:**
 * - Module completion status
 * - Summary message
 * - Complete status JSON (for debugging)
 *
 * **Failure Case Logs:**
 * - Error name and message
 * - Module failure status
 * - Summary message
 * - Failed environments (if applicable)
 * - Regional errors with details (if applicable)
 * - Complete status JSON (for debugging)
 *
 * @template T - Type of the module-specific response data (optional)
 *
 * @param {IModuleResponse<T>} status - Module execution result containing status, summary, and optional response data
 * @param {string} moduleName - Name of the module (e.g., 'macie', 'guardduty', 'stack-resources-retention')
 * @param {string} logPrefix - Log prefix for consistent log formatting (format: accountId:region)
 * @param {IconLogger} logger - Logger instance for detailed logging
 * @param {IconLogger} statusLogger - Status logger instance for high-level status updates
 *
 * @returns {void}
 *
 * @example
 * ```typescript
 * // Example 1: Logging Macie configuration result
 * const macieResult = await configureMacie(params);
 * logModuleExecutionResult(
 *   macieResult,
 *   'macie',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 *
 * // Example 2: Logging stack resources retention result
 * const retentionResult = await StackResources.retain(params);
 * logModuleExecutionResult(
 *   retentionResult,
 *   'stack-resources-retention',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 *
 * // Example 3: Logging with module-specific response data
 * interface ICustomResponse {
 *   processedItems: number;
 *   failedItems: string[];
 * }
 *
 * const result: IModuleResponse<ICustomResponse> = {
 *   status: 'COMPLETED',
 *   summary: 'Processed 10 items',
 *   response: {
 *     processedItems: 10,
 *     failedItems: []
 *   }
 * };
 *
 * logModuleExecutionResult(
 *   result,
 *   'custom-module',
 *   '123456789012:us-east-1',
 *   logger,
 *   statusLogger
 * );
 * ```
 */
export function logModuleExecutionResult<T = unknown>(
  status: IModuleResponse<T>,
  moduleName: string,
  logPrefix: string,
  logger: IconLogger,
  statusLogger: IconLogger,
): void {
  if (status.error) {
    logErrorDetails(status, moduleName, logPrefix, logger);
    statusLogger.error(`Module ${moduleName} failed (${status.error!.name}): ${status.summary}`, logPrefix);
    logFailedEnvironments(status.response, statusLogger);
    logEnvironmentErrors(status.response, statusLogger);
  } else {
    logSuccessDetails(status, moduleName, logger);
  }

  // Always log complete status for debugging
  logger.info(`Complete Status: ${JSON.stringify(status)}`, logPrefix);

  // Log high-level completion status
  statusLogger.processEnd(`Completed module ${moduleName}`, logPrefix);
}
