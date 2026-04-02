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
 * @fileoverview Amazon Macie Interface Definitions - Type definitions for Macie operations
 *
 * Provides comprehensive interface definitions for Amazon Macie module operations
 * including configuration, requests, responses, and data structures. These interfaces
 * ensure type safety and consistency across all Macie-related operations.
 *
 * Key interface categories:
 * - Configuration interfaces for Macie setup
 * - Request and response interfaces for module operations
 * - S3 destination and data source configurations
 * - Organization and session management structures
 */

import { ClassificationScopeUpdateOperation, FindingPublishingFrequency } from '@aws-sdk/client-macie2';
import {
  IBatchOperationSettings,
  IModuleBoundary,
  IModuleOrganizationsDataSource,
  IModuleRegionFilters,
  IModuleRequest,
  ISecurityBaseConfig,
  ISecurityServiceModuleResponse,
} from '../common/interfaces';
import { SecurityModuleOperationType } from '../common/types';

/**
 * S3 bucket with its region for classification scope exclusion.
 * Each bucket must be excluded in the Macie region where it resides,
 * since UpdateClassificationScope only accepts buckets in the current AWS Region.
 */
export interface IClassificationScopeBucketConfig {
  /** Full name of the S3 bucket */
  readonly name: string;
  /** AWS region where the bucket resides */
  readonly region: string;
}

/**
 * S3 classification scope exclusion configuration for automated sensitive data discovery.
 * Defines which S3 buckets to exclude from automated discovery analysis.
 * Buckets are region-aware so they can be filtered per-region before calling the API.
 * Executed only on the delegated admin account.
 */
export interface IClassificationScopeExclusion {
  /** S3 buckets with their regions to exclude from automated sensitive data discovery */
  readonly buckets: readonly IClassificationScopeBucketConfig[];
  /** How to apply the changes to the exclusion list */
  readonly operation: ClassificationScopeUpdateOperation;
}

/**
 * S3 destination configuration for Macie findings and exports
 */
export interface IMacieS3Destination {
  /** S3 bucket name for storing Macie findings */
  bucketName: string;
  /** KMS key ARN for encrypting stored findings */
  kmsKeyArn: string;
  /** Optional key prefix for organizing findings in S3 */
  keyPrefix?: string;
}

/**
 * Data source configuration for Macie module operations
 */
export interface IMacieModuleDataSources {
  /** Organizations data source configuration */
  readonly organizations: IModuleOrganizationsDataSource;
}

/**
 * Complete configuration interface for Amazon Macie module operations
 */
export interface IMacieConfiguration extends ISecurityBaseConfig {
  /** Frequency for publishing policy findings */
  readonly policyFindingsPublishingFrequency: FindingPublishingFrequency;
  /** Whether to publish sensitive data findings to Security Hub */
  readonly publishSensitiveDataFindings: boolean;
  /** Whether to publish policy findings to Security Hub */
  readonly publishPolicyFindings: boolean;
  /** S3 destination configuration for findings export */
  readonly s3Destination: IMacieS3Destination;
  /** Optional regional filtering configuration */
  readonly regionFilters?: IModuleRegionFilters;
  /** Optional boundary configuration for operation scope */
  readonly boundary?: IModuleBoundary;
  /** Optional batch operation settings for concurrency and timeout */
  readonly batchOperationSettings?: IBatchOperationSettings;
  /** Optional data source configurations */
  readonly dataSources?: IMacieModuleDataSources;
  /**
   * When true, enables automated sensitive data discovery on the delegated admin account.
   * Automated discovery continuously samples and analyzes S3 objects across member accounts
   * to detect sensitive data without requiring manual job creation.
   *
   * When false, explicitly disables automated discovery on the delegated admin account.
   */
  readonly automatedDiscoveryEnabled: boolean;
  /**
   * Optional S3 classification scope exclusion settings for automated sensitive data discovery.
   * Defines which S3 buckets to exclude from automated discovery analysis.
   * Only applied on the delegated admin account.
   */
  readonly classificationScopeExclusion?: IClassificationScopeExclusion;
}

/**
 * Request interface for Macie module operations extending base module request
 */
export interface IMacieModuleRequest extends IModuleRequest {
  /** Macie-specific configuration */
  readonly configuration: IMacieConfiguration;
}

/**
 * Macie session configuration response interface
 */
export interface IMacieSessionResponse {
  /** Type of operation performed (enabled/disabled) */
  operation: SecurityModuleOperationType;
  /** List of regions where operation was performed */
  regions: string[];
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
 * Complete Macie module response interface
 * Extends base security service response with Macie-specific session configuration
 */
export interface IMacieModuleResponse extends ISecurityServiceModuleResponse {
  /** Session configuration results */
  sessionConfig: IMacieSessionResponse[];
}
