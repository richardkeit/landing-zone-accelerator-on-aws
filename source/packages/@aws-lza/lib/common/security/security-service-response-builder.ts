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
 * @fileoverview Security Service Response Builder - Centralized response creation and management
 *
 * Provides a generic, type-safe builder pattern for creating and managing response objects
 * across AWS security services in the Landing Zone Accelerator. Eliminates code duplication
 * by providing consistent response creation, deduplication, merging, and validation.
 *
 * Key features:
 * - Generic builder class supporting any security service response type
 * - Automatic deduplication and merging of responses
 * - Service-specific customization through response handlers
 * - Comprehensive logging and error handling
 * - Type-safe operations with TypeScript generics
 *
 * @example
 * ```typescript
 * import { SecurityServiceResponseBuilder, OrganizationAdminResponseHandler } from './common';
 *
 * // Create builder for organization admin responses
 * const logger = createLogger(['macie']);
 * const builder = new SecurityServiceResponseBuilder<IOrganizationAdminResponse>(logger);
 * const handler = new OrganizationAdminResponseHandler();
 *
 * // Add responses with automatic deduplication
 * builder.addResponse('enabled', 'us-east-1', handler, {
 *   managementAccountId: 'XXXXXXXXXXXX',
 *   delegatedAdminAccountId: 'YYYYYYYYYYYY'
 * }, logPrefix);
 *
 * builder.addResponse('enabled', 'us-west-2', handler, {
 *   managementAccountId: 'XXXXXXXXXXXX',
 *   delegatedAdminAccountId: 'YYYYYYYYYYYY'
 * }, logPrefix);
 *
 * // Get merged responses (single response with both regions)
 * const responses = builder.getResponses();
 * responses[0].regions // ['us-east-1', 'us-west-2']
 * ```
 */

import { IconLogger } from '../logger';
import { SecurityModuleOperationType } from '../types';

/**
 * Base interface for all security service response objects.
 * Defines the minimum required fields that all security service responses must implement.
 */
export interface BaseSecurityResponse {
  /** Type of operation performed (enabled/disabled) */
  operation: SecurityModuleOperationType;
  /** List of regions where operation was performed */
  regions: string[];
}

/**
 * Custom error class for response builder operations.
 * Provides structured error information with error codes for different failure scenarios.
 */
export class ResponseBuilderError extends Error {
  /**
   * Creates a new ResponseBuilderError with a message and error code.
   *
   * @param message - Descriptive error message
   * @param code - Error code from ErrorCodes enum
   */
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ResponseBuilderError';
  }
}

/**
 * Enumeration of error codes for response builder operations.
 * Used to categorize different types of failures for proper error handling.
 */
export const ErrorCodes = {
  /** Invalid operation type provided (not 'enabled' or 'disabled') */
  INVALID_OPERATION: 'INVALID_OPERATION',
  /** Required field missing from response data */
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  /** Error occurred in response factory during creation */
  FACTORY_ERROR: 'FACTORY_ERROR',
  /** Error occurred during response merging */
  MERGE_ERROR: 'MERGE_ERROR',
  /** Invalid input parameters provided */
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

/**
 * Type definition for error code values.
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// Import common interfaces instead of defining duplicates
import { IDelegatedAccountResponse, IOrganizationAdminResponse } from '../interfaces';

/**
 * Type alias for organization-level security service responses.
 * Uses the common interface from interfaces.ts to avoid duplication.
 */
export type OrganizationAdminResponse = IOrganizationAdminResponse;

/**
 * Type alias for delegated account-level security service responses.
 * Uses the common interface from interfaces.ts to avoid duplication.
 */
export type DelegatedAccountResponse = IDelegatedAccountResponse;

/**
 * Combined factory and merge handler for organization admin responses.
 * Handles both creation and merging in a single class.
 * Used by ALL security services (Macie, GuardDuty, SecurityHub, Detective, etc.)
 */
export class OrganizationAdminResponseHandler {
  /**
   * Creates a new organization admin response from data
   */
  create(
    operation: SecurityModuleOperationType,
    region: string,
    data: Record<string, unknown>,
  ): IOrganizationAdminResponse {
    if (!data['managementAccountId'] || typeof data['managementAccountId'] !== 'string') {
      throw new ResponseBuilderError(
        'managementAccountId is required and must be a string',
        ErrorCodes.MISSING_REQUIRED_FIELD,
      );
    }

    if (!data['delegatedAdminAccountId'] || typeof data['delegatedAdminAccountId'] !== 'string') {
      throw new ResponseBuilderError(
        'delegatedAdminAccountId is required and must be a string',
        ErrorCodes.MISSING_REQUIRED_FIELD,
      );
    }

    return {
      operation,
      regions: [region],
      managementAccountId: data['managementAccountId'] as string,
      delegatedAdminAccountId: data['delegatedAdminAccountId'] as string,
    };
  }

  /**
   * Gets unique identifier for grouping responses
   */
  getIdentifier(response: IOrganizationAdminResponse): string {
    return `${response.operation}-${response.managementAccountId}-${response.delegatedAdminAccountId}`;
  }

  /**
   * Checks if two responses can be merged
   */
  canMerge(existing: IOrganizationAdminResponse, newResponse: IOrganizationAdminResponse): boolean {
    return (
      existing.operation === newResponse.operation &&
      existing.managementAccountId === newResponse.managementAccountId &&
      existing.delegatedAdminAccountId === newResponse.delegatedAdminAccountId
    );
  }

  /**
   * Merges two responses by combining regions
   */
  merge(existing: IOrganizationAdminResponse, newResponse: IOrganizationAdminResponse): IOrganizationAdminResponse {
    return {
      ...existing,
      regions: [...new Set([...existing.regions, ...newResponse.regions])],
    };
  }
}

/**
 * Combined factory and merge handler for delegated account responses.
 * Handles both creation and merging in a single class.
 * Used by ALL security services (Macie, GuardDuty, SecurityHub, Detective, etc.)
 */
export class DelegatedAccountResponseHandler {
  /**
   * Creates a new delegated account response from data
   */
  create(
    operation: SecurityModuleOperationType,
    region: string,
    data: Record<string, unknown>,
  ): IDelegatedAccountResponse {
    if (!data['adminAccountId'] || typeof data['adminAccountId'] !== 'string') {
      throw new ResponseBuilderError(
        'adminAccountId is required and must be a string',
        ErrorCodes.MISSING_REQUIRED_FIELD,
      );
    }

    const memberAccountIds = (data['memberAccountIds'] as string[]) || [];
    if (!Array.isArray(memberAccountIds)) {
      throw new ResponseBuilderError('memberAccountIds must be an array of strings', ErrorCodes.MISSING_REQUIRED_FIELD);
    }

    return {
      operation,
      regions: [region],
      adminAccountId: data['adminAccountId'] as string,
      memberAccountIds,
    };
  }

  /**
   * Gets unique identifier for grouping responses
   */
  getIdentifier(response: IDelegatedAccountResponse): string {
    return `${response.operation}-${response.adminAccountId}`;
  }

  /**
   * Checks if two responses can be merged
   */
  canMerge(existing: IDelegatedAccountResponse, newResponse: IDelegatedAccountResponse): boolean {
    return existing.operation === newResponse.operation && existing.adminAccountId === newResponse.adminAccountId;
  }

  /**
   * Merges two responses by combining regions and member accounts
   */
  merge(existing: IDelegatedAccountResponse, newResponse: IDelegatedAccountResponse): IDelegatedAccountResponse {
    return {
      ...existing,
      regions: [...new Set([...existing.regions, ...newResponse.regions])],
      memberAccountIds: [...new Set([...existing.memberAccountIds, ...newResponse.memberAccountIds])],
    };
  }
}

/**
 * Generic response builder for AWS security services.
 * Provides centralized response creation, deduplication, merging, and management.
 *
 * @template T - The response type that extends BaseSecurityResponse
 *
 * @example
 * ```typescript
 * // Create builder for Macie session responses
 * const logger = createLogger(['macie']);
 * const builder = new SecurityServiceResponseBuilder<IMacieSessionResponse>(logger);
 *
 * // Create handler
 * const handler = new MacieSessionResponseHandler();
 *
 * // Add responses - duplicates will be automatically merged
 * builder.addResponse('enabled', 'us-east-1', handler, {
 *   accountIds: ['XXXXXXXXXXXX'],
 *   configuration: macieConfig
 * });
 *
 * builder.addResponse('enabled', 'us-west-2', handler, {
 *   accountIds: ['XXXXXXXXXXXX', 'YYYYYYYYYYYY']
 * });
 *
 * // Get consolidated responses
 * const responses = builder.getResponses();
 * // Result: Single response with regions ['us-east-1', 'us-west-2']
 * //         and accountIds ['XXXXXXXXXXXX', 'YYYYYYYYYYYY']
 * ```
 */
export class SecurityServiceResponseBuilder<T extends BaseSecurityResponse> {
  private responses: T[] = [];
  private logger: IconLogger;

  /**
   * Creates a new SecurityServiceResponseBuilder instance.
   *
   * @param logger - Logger instance for operation logging
   */
  constructor(logger: IconLogger) {
    this.logger = logger;
  }

  /**
   * Adds a response to the builder, automatically handling deduplication and merging.
   * If a response with the same identifier already exists, the new response will be merged.
   * Otherwise, a new response will be created and added to the collection.
   *
   * @param operation - The operation type (enabled/disabled)
   * @param region - The AWS region for this response
   * @param handler - Combined handler for creating and merging responses
   * @param data - Service-specific data for response creation
   * @param logPrefix - Optional logging prefix for context
   * @throws ResponseBuilderError when operation fails due to invalid input or handler errors
   */
  addResponse<
    H extends {
      create: (op: SecurityModuleOperationType, region: string, data: Record<string, unknown>) => T;
      getIdentifier: (response: T) => string;
      canMerge: (existing: T, newResponse: T) => boolean;
      merge: (existing: T, newResponse: T) => T;
    },
  >(
    operation: SecurityModuleOperationType,
    region: string,
    handler: H,
    data: Record<string, unknown>,
    logPrefix?: string,
  ): void {
    try {
      // Validate inputs
      this.logger.info(`Validating inputs for addResponse: operation='${operation}', region='${region}'`, logPrefix);
      this.validateInputs(operation, region, handler);
      this.validateData(data);
      this.logger.info(`Input validation completed successfully`, logPrefix);

      // Create new response using handler
      this.logger.info(`Creating response for operation '${operation}' in region '${region}'`, logPrefix);
      const newResponse = handler.create(operation, region, data);

      // Validate the created response
      this.validateResponse(newResponse);
      this.logger.info(`Response created and validated successfully`, logPrefix);

      // Find existing response with same identifier
      const identifier = handler.getIdentifier(newResponse);
      this.logger.info(`Generated response identifier: '${identifier}'`, logPrefix);
      const existingResponse = this.findExistingResponse(identifier, handler);

      if (existingResponse) {
        // Merge with existing response
        this.logger.info(`Found existing response with identifier '${identifier}', merging responses`, logPrefix);
        this.logger.info(`Existing response regions: [${existingResponse.regions.join(', ')}]`, logPrefix);
        this.logger.info(`New response regions: [${newResponse.regions.join(', ')}]`, logPrefix);

        const mergedResponse = this.mergeResponses(existingResponse, newResponse, handler);

        // Replace existing response with merged version
        const index = this.responses.indexOf(existingResponse);
        this.responses[index] = mergedResponse;

        this.logger.info(`Successfully merged response for operation '${operation}' in region '${region}'`, logPrefix);
        this.logger.info(`Final merged regions: [${mergedResponse.regions.join(', ')}]`, logPrefix);
      } else {
        // Add new response to collection
        this.responses.push(newResponse);
        this.logger.info(`Added new response for operation '${operation}' in region '${region}'`, logPrefix);
        this.logger.info(`Total responses in builder: ${this.responses.length}`, logPrefix);
      }
    } catch (error) {
      if (error instanceof ResponseBuilderError) {
        this.logger.error(`Response builder error [${error.code}]: ${error.message}`, logPrefix);
        throw error;
      } else {
        const message = `Unexpected error adding response: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.error(`Unexpected error: ${message}`);
        throw new ResponseBuilderError(message, ErrorCodes.FACTORY_ERROR);
      }
    }
  }

  /**
   * Retrieves all responses currently managed by the builder.
   *
   * @returns Array of all response objects
   */
  getResponses(): T[] {
    return [...this.responses]; // Return copy to prevent external modification
  }

  /**
   * Clears all responses from the builder.
   * Useful for resetting the builder state between operations.
   */
  clear(): void {
    const count = this.responses.length;
    this.responses = [];
    this.logger.info(`Cleared ${count} responses from builder`);
  }

  /**
   * Validates input parameters for the addResponse method.
   *
   * @param operation - The operation type to validate
   * @param region - The region to validate
   * @param handler - The handler to validate
   * @throws ResponseBuilderError when validation fails
   */
  private validateInputs<
    H extends {
      create: (op: SecurityModuleOperationType, region: string, data: Record<string, unknown>) => T;
      getIdentifier: (response: T) => string;
      canMerge: (existing: T, newResponse: T) => boolean;
      merge: (existing: T, newResponse: T) => T;
    },
  >(operation: SecurityModuleOperationType, region: string, handler: H): void {
    // Validate operation type
    if (!operation || (operation !== 'enabled' && operation !== 'disabled')) {
      throw new ResponseBuilderError(
        `Invalid operation type: '${operation}'. Must be 'enabled' or 'disabled'`,
        ErrorCodes.INVALID_OPERATION,
      );
    }

    // Validate region
    if (!region || typeof region !== 'string') {
      throw new ResponseBuilderError(
        `Region must be a non-empty string, received: ${typeof region}`,
        ErrorCodes.INVALID_INPUT,
      );
    }

    const trimmedRegion = region.trim();
    if (trimmedRegion.length === 0) {
      throw new ResponseBuilderError('Region cannot be empty or contain only whitespace', ErrorCodes.INVALID_INPUT);
    }

    // Basic AWS region format validation (optional but helpful)
    const regionPattern = /^[a-z0-9-]+$/;
    if (!regionPattern.test(trimmedRegion)) {
      throw new ResponseBuilderError(
        `Region '${trimmedRegion}' contains invalid characters. AWS regions should only contain lowercase letters, numbers, and hyphens`,
        ErrorCodes.INVALID_INPUT,
      );
    }

    // Validate handler
    if (!handler) {
      throw new ResponseBuilderError('Handler cannot be null or undefined', ErrorCodes.INVALID_INPUT);
    }

    if (typeof handler !== 'object') {
      throw new ResponseBuilderError(
        `Handler must be an object, received: ${typeof handler}`,
        ErrorCodes.INVALID_INPUT,
      );
    }

    const requiredMethods = ['create', 'getIdentifier', 'canMerge', 'merge'] as const;
    for (const method of requiredMethods) {
      if (typeof handler[method] !== 'function') {
        throw new ResponseBuilderError(
          `Handler must have a ${method} method that is a function`,
          ErrorCodes.INVALID_INPUT,
        );
      }
    }
  }

  /**
   * Finds an existing response with the specified identifier.
   *
   * @param identifier - The identifier to search for
   * @param handler - Handler to get identifiers from existing responses
   * @returns The existing response if found, undefined otherwise
   */
  private findExistingResponse<H extends { getIdentifier: (response: T) => string }>(
    identifier: string,
    handler: H,
  ): T | undefined {
    return this.responses.find(response => handler.getIdentifier(response) === identifier);
  }

  /**
   * Merges two responses using the provided handler.
   *
   * @param existing - The existing response
   * @param newResponse - The new response to merge
   * @param handler - Handler for merging the responses
   * @returns The merged response
   * @throws ResponseBuilderError when merge operation fails
   */
  private mergeResponses<
    H extends {
      canMerge: (existing: T, newResponse: T) => boolean;
      merge: (existing: T, newResponse: T) => T;
    },
  >(existing: T, newResponse: T, handler: H): T {
    try {
      // Validate that responses can be merged
      if (!handler.canMerge(existing, newResponse)) {
        throw new ResponseBuilderError(`Cannot merge responses: incompatible response objects`, ErrorCodes.MERGE_ERROR);
      }

      // Perform merge
      const mergedResponse = handler.merge(existing, newResponse);

      // Validate the merged response
      this.validateResponse(mergedResponse);

      // Log merge details
      this.logger.info(
        `Merged responses: regions [${existing.regions.join(', ')}] + [${newResponse.regions.join(', ')}] = [${mergedResponse.regions.join(', ')}]`,
      );

      return mergedResponse;
    } catch (error) {
      if (error instanceof ResponseBuilderError) {
        throw error;
      } else {
        const message = `Failed to merge responses: ${error instanceof Error ? error.message : String(error)}`;
        throw new ResponseBuilderError(message, ErrorCodes.MERGE_ERROR);
      }
    }
  }

  /**
   * Validates that a response object has the required base fields.
   *
   * @param response - The response object to validate
   * @throws ResponseBuilderError when validation fails
   */
  private validateResponse(response: T): void {
    if (!response) {
      const error = 'Response object cannot be null or undefined';
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    if (typeof response !== 'object') {
      const error = `Response must be an object, received: ${typeof response}`;
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    // Validate operation field
    if (!response.operation || (response.operation !== 'enabled' && response.operation !== 'disabled')) {
      const error = `Response must have a valid operation field ('enabled' or 'disabled'), received: '${response.operation}'`;
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    // Validate regions field
    if (!response.regions) {
      const error = 'Response must have a regions field';
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    if (!Array.isArray(response.regions)) {
      const error = `Response regions must be an array, received: ${typeof response.regions}`;
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    if (response.regions.length === 0) {
      const error = 'Response regions array cannot be empty';
      this.logger.error(`Validation failed: ${error}`);
      throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
    }

    // Validate each region in the array
    for (let i = 0; i < response.regions.length; i++) {
      const region = response.regions[i];
      if (!region || typeof region !== 'string' || region.trim().length === 0) {
        const error = `Response regions[${i}] must be a non-empty string, received: ${typeof region}`;
        this.logger.error(`Validation failed: ${error}`);
        throw new ResponseBuilderError(error, ErrorCodes.FACTORY_ERROR);
      }
    }

    this.logger.info(
      `Response validation passed: operation='${response.operation}', regions=[${response.regions.join(', ')}]`,
    );
  }

  /**
   * Validates data object for common issues and edge cases.
   *
   * @param data - The data object to validate
   */
  private validateData(data: Record<string, unknown>): void {
    if (data === null) {
      throw new ResponseBuilderError(
        'Data cannot be null. Use an empty object {} if no data is needed',
        ErrorCodes.INVALID_INPUT,
      );
    }

    if (data === undefined) {
      throw new ResponseBuilderError(
        'Data cannot be undefined. Use an empty object {} if no data is needed',
        ErrorCodes.INVALID_INPUT,
      );
    }

    if (typeof data !== 'object') {
      throw new ResponseBuilderError(`Data must be an object, received: ${typeof data}`, ErrorCodes.INVALID_INPUT);
    }

    // Check for common problematic values
    if (Array.isArray(data)) {
      throw new ResponseBuilderError(
        'Data cannot be an array. Use an object with named properties',
        ErrorCodes.INVALID_INPUT,
      );
    }
  }
}
