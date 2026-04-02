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
 * @fileoverview Common Type Definitions - Shared types and enums for AWS LZA operations
 *
 * Provides comprehensive type definitions, enums, and type aliases used across
 * AWS Landing Zone Accelerator modules. Includes module state management,
 * account categorization, operation types, and DynamoDB query operators.
 *
 * Key type categories:
 * - Module exception and state management
 * - Account type classification and ordering
 * - Security module operation types
 * - DynamoDB query and filter operators
 */

import { Account } from '@aws-sdk/client-organizations';
import { IAssumeRoleCredential } from './interfaces';

/**
 * Enumeration of module exception types for error handling
 */
export enum MODULE_EXCEPTIONS {
  /** General service exception */
  SERVICE_EXCEPTION = 'ServiceException',
  /** Invalid input parameter exception */
  INVALID_INPUT = 'InvalidInputException',
}

/**
 * Enumeration of module operation state codes
 */
export enum MODULE_STATE_CODE {
  /** Operation completed successfully */
  SUCCESS = 'success',
  /** Operation failed with error */
  FAILED = 'failed',
  /** Operation completed (general completion) */
  COMPLETED = 'completed',
  /** Operation was skipped */
  SKIPPED = 'skipped',
}

/**
 * Type definition for ordered account lists with dependency management
 */
export type OrderedAccountListType = {
  /** Account group name indicating role in organization */
  name: 'Management' | 'DelegatedAdmin' | 'WorkLoads';
  /** Processing order for dependency resolution */
  order: number;
  /** Array of AWS accounts in this group */
  accounts: Account[];
};

/**
 * Type definition for security module operation actions (verb form)
 * Used to specify which operation to perform
 */
export type SecurityModuleOperationAction = 'enable' | 'disable';

/**
 * Type definition for security module operation states (past tense)
 * Used in responses to indicate what operation was performed
 */
export type SecurityModuleOperationType = 'enabled' | 'disabled';

/**
 * Type definition for accelerator account classifications
 */
export type AcceleratorAccountType = 'management' | 'delegatedAdmin' | 'workload';

/**
 * Type definition for DynamoDB logical operators in filter expressions
 */
export type DynamoDBLogicalOperator = 'AND' | 'OR';

/**
 * Enumeration of DynamoDB filter operators for query and scan operations
 */
export enum DynamoDBFilterOperator {
  /** Equality comparison */
  EQUALS = '=',
  /** Inequality comparison */
  NOT_EQUALS = '<>',
  /** Less than comparison */
  LESS_THAN = '<',
  /** Less than or equal comparison */
  LESS_THAN_OR_EQUAL = '<=',
  /** Greater than comparison */
  GREATER_THAN = '>',
  /** Greater than or equal comparison */
  GREATER_THAN_OR_EQUAL = '>=',
  /** String prefix matching */
  BEGINS_WITH = 'begins_with',
  /** String contains matching */
  CONTAINS = 'contains',
  /** Attribute existence check */
  ATTRIBUTE_EXISTS = 'attribute_exists',
  /** Attribute non-existence check */
  ATTRIBUTE_NOT_EXISTS = 'attribute_not_exists',
  /** Attribute type validation */
  ATTRIBUTE_TYPE = 'attribute_type',
  /** Attribute size comparison */
  SIZE = 'size',
  /** Range comparison */
  BETWEEN = 'between',
  /** Value list membership */
  IN = 'in',
}

/**
 * Configuration properties for AWS SDK client initialization.
 *
 * @description
 * Provides standardized configuration options for creating AWS SDK clients across
 * the LZA modules. This type ensures consistent client configuration patterns
 * and supports cross-account operations through credential management.
 *
 * @example
 * ```typescript
 * // Basic client configuration
 * const clientProps: SdkClientPropsType = {
 *   region: 'us-east-1',
 *   customUserAgent: 'AwsSolution/SO0199/1.0.0'
 * };
 *
 * // Cross-account client configuration
 * const crossAccountProps: SdkClientPropsType = {
 *   region: 'us-west-2',
 *   customUserAgent: 'AwsSolution/SO0199/1.0.0',
 *   credentials: {
 *     accessKeyId: 'AKIA...',
 *     secretAccessKey: 'secret...',
 *     sessionToken: 'token...'
 *   }
 * };
 *
 * // Usage with Organizations client
 * const accounts = await getOrganizationAccounts(logPrefix, undefined, clientProps);
 * ```
 *
 * @see {@link IAssumeRoleCredential} For credential structure details
 */
export type SdkClientPropsType = {
  /**
   * AWS region for SDK client operations.
   *
   * @example 'us-east-1', 'eu-west-1', 'ap-southeast-2'
   */
  region?: string;

  /**
   * Custom user agent string for AWS API calls.
   * Used for tracking and identifying LZA operations in AWS CloudTrail logs.
   *
   * @example 'AwsSolution/SO0199/1.0.0'
   */
  customUserAgent?: string;

  /**
   * Cross-account credentials for assume role operations.
   * When provided, the SDK client will use these credentials instead of
   * the default credential chain for cross-account access.
   *
   * @see {@link IAssumeRoleCredential}
   */
  credentials?: IAssumeRoleCredential;
};
