/**
 * @fileoverview Shared type definitions for resource retention and module state management.
 *
 * @description
 * This module provides comprehensive type definitions used across LZA security service actions
 * and resource retention operations. It includes:
 *
 * **Retention Types:**
 * - RetentionStatus enum - Lifecycle states for retention operations
 * - IStackRetentionConfig - Configuration for stack resource retention
 * - IRetentionResult - Results from retention operations
 * - IResourceRetentionState - DynamoDB state tracking for retention
 *
 * **Module State Types:**
 * - IModuleExecutionState - DynamoDB state tracking for module executions
 * - IModuleStateConfig - Configuration for state change detection
 *
 * **Builder Types:**
 * - IStackConfigBuilderInput - Input for stack configuration builders
 *
 * These types are shared across multiple modules (Macie, GuardDuty, Security Hub, Detective)
 * to ensure consistent patterns and type safety throughout the codebase.
 *
 * @example
 * ```typescript
 * // Using retention types
 * const config: IStackRetentionConfig = {
 *   accountId: 'XXXXXXXXXXXX',
 *   region: 'us-east-1',
 *   stackName: 'AWSAccelerator-SecurityStack-XXXXXXXXXXXX-us-east-1',
 *   resourceTypes: ['Custom::MaciePutClassificationExportConfiguration'],
 *   accountAccessRoleName: 'AWSControlTowerExecution',
 *   s3BucketName: 'cdk-accel-assets-XXXXXXXXXXXX-us-east-1'
 * };
 *
 * // Using module state types
 * const stateConfig: IModuleStateConfig<IMacieConfig> = {
 *   serviceName: 'macie',
 *   currentConfig: { enable: true, accountsCount: 5 },
 *   overrideExisting: false
 * };
 * ```
 *
 * @see {@link resource-retention} - Resource retention orchestration
 * @see {@link retention-state} - Retention state management
 * @see {@link module-state} - Module state management
 */

/**
 * Shared types for resource retention and module state management utilities.
 * These interfaces are used across security service actions (Macie, GuardDuty, Security Hub, Detective).
 */

/**
 * Retention status enumeration for CloudFormation stack resource retention.
 * Tracks the lifecycle of retention operations from pending to completion.
 *
 * @enum {string}
 */
export enum RetentionStatus {
  /**
   * Retention has not been attempted yet.
   * Initial state when a stack is first identified for retention.
   */
  PENDING = 'PENDING',

  /**
   * Retention operation is currently in progress.
   * CloudFormation UpdateStack is being executed.
   */
  IN_PROGRESS = 'IN_PROGRESS',

  /**
   * Retention successfully completed.
   * Resources now have DeletionPolicy: Retain set.
   */
  COMPLETED = 'COMPLETED',

  /**
   * Retention operation failed.
   * Will be retried on next execution.
   */
  FAILED = 'FAILED',

  /**
   * CloudFormation stack was not found.
   * Treated as completed (nothing to retain).
   */
  NOT_FOUND = 'NOT_FOUND',
}

/**
 * Stack configuration for resource retention.
 * Defines which CloudFormation stack to retain resources from and what resource types to target.
 */
export interface IStackRetentionConfig {
  /**
   * AWS account ID where the stack exists
   */
  readonly accountId: string;

  /**
   * AWS region where the stack exists
   */
  readonly region: string;

  /**
   * CloudFormation stack name
   * @example 'AWSAccelerator-OrganizationsStack-XXXXXXXXXXXX-us-east-1'
   */
  readonly stackName: string;

  /**
   * Array of resource types to retain from the stack
   * @example ['Custom::MacieEnableOrganizationAdminAccount', 'AWS::S3::Bucket']
   */
  readonly resourceTypes: string[];

  /**
   * Optional array of specific resource logical IDs to retain
   * When provided, only these specific resources will be retained (selective retention)
   * When omitted or empty, ALL resources matching resourceTypes will be retained
   * @example ['ReportBucket', 'AccessLogsBucket']
   */
  readonly resourceLogicalIds?: string[];

  /**
   * Optional IAM role name for cross-account access
   * Used when the stack is in a different account than the execution account
   */
  readonly accountAccessRoleName?: string;

  /**
   * S3 bucket name for uploading modified CloudFormation templates
   * Regional bucket in management account for template retention
   * @example 'awsaccelerator-cfn-retention-us-east-1'
   */
  readonly s3BucketName: string;

  /**
   * AWS region where the S3 bucket exists
   * This is typically the home region where the CDK bootstrap bucket is located
   * Used to create the S3 client with the correct regional endpoint
   * @example 'us-east-1'
   */
  readonly bucketRegion: string;
}

/**
 * Result of retention operation for a single stack.
 * Returned after attempting to retain resources from a CloudFormation stack.
 */
export interface IRetentionResult {
  /**
   * CloudFormation stack name that was processed
   */
  readonly stackName: string;

  /**
   * AWS account ID where the stack exists
   */
  readonly accountId: string;

  /**
   * AWS region where the stack exists
   */
  readonly region: string;

  /**
   * Status of the retention operation
   * - COMPLETED: Resources successfully retained
   * - FAILED: Retention operation failed
   * - SKIPPED: Retention was skipped (already completed or not needed)
   * - NOT_FOUND: Stack or resources not found
   */
  readonly status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'NOT_FOUND';

  /**
   * Human-readable message describing the result
   */
  readonly message: string;

  /**
   * Number of resources that were retained (if applicable)
   */
  readonly resourcesRetained?: number;

  /**
   * Error message if the operation failed
   */
  readonly error?: string;
}

/**
 * Module execution state stored in DynamoDB.
 * Tracks the last execution of a module to enable config change detection.
 */
export interface IModuleExecutionState {
  /**
   * Service name (e.g., 'MACIE', 'GUARDDUTY', 'SECURITYHUB', 'DETECTIVE')
   */
  readonly serviceName: string;

  /**
   * ISO timestamp of the last execution
   * @example '2024-01-15T10:30:00.000Z'
   */
  readonly lastExecutionTime: string;

  /**
   * JSON stringified configuration from the last execution
   * Used for comparison with current configuration
   */
  readonly lastConfig: string;

  /**
   * SHA256 hash of the last configuration
   * Used for efficient comparison without parsing JSON
   */
  readonly configHash: string;

  /**
   * Status of the last execution
   * @example 'COMPLETED', 'FAILED', 'SKIPPED'
   */
  readonly lastStatus: string;

  /**
   * JSON stringified response from the last execution
   * Contains the full module response for reference
   */
  readonly lastResponse: string;
}

/**
 * Resource retention state stored in DynamoDB.
 * Tracks the retention status of CloudFormation stacks to avoid redundant operations.
 */
export interface IResourceRetentionState {
  /**
   * Service name (e.g., 'MACIE', 'GUARDDUTY', 'SECURITYHUB', 'DETECTIVE', 'S3')
   */
  readonly serviceName: string;

  /**
   * AWS account ID where the stack exists
   */
  readonly accountId: string;

  /**
   * AWS region where the stack exists
   */
  readonly region: string;

  /**
   * CloudFormation stack name
   */
  readonly stackName: string;

  /**
   * Array of resource types that were targeted for retention
   * @example ['Custom::MacieCreateMember', 'AWS::S3::Bucket']
   */
  readonly resourceTypes: string[];

  /**
   * Optional array of specific resource logical IDs that were retained
   * Tracks which specific resources have been retained for incremental migration support
   * When empty or undefined, indicates all resources of the specified types were retained
   * @example ['ReportBucket', 'AccessLogsBucket']
   */
  readonly resourceLogicalIds?: string[];

  /**
   * Current retention status
   * Uses RetentionStatus enum for type safety and autocomplete support
   */
  readonly retentionStatus: RetentionStatus;

  /**
   * ISO timestamp when retention was completed (if applicable)
   * @example '2024-01-15T10:30:00.000Z'
   */
  readonly retentionTime?: string;

  /**
   * Number of retention attempts made
   * Incremented on each retry
   */
  readonly retentionAttempts: number;

  /**
   * Error message from the last failed attempt (if applicable)
   */
  readonly lastError?: string;

  /**
   * Flag indicating if resources have been successfully retained
   * When true, DeletionPolicy: Retain has been applied and retention will be skipped on subsequent executions
   */
  readonly resourcesRetained: boolean;
}

/**
 * Configuration for module state management.
 * Used to check if module configuration has changed since last execution.
 *
 * @typeParam T - Type of the configuration object (defaults to unknown for flexibility)
 *
 * @example
 * ```typescript
 * // Without type parameter (flexible)
 * const config: IModuleStateConfig = {
 *   serviceName: 'MACIE',
 *   currentConfig: { enable: true },
 *   overrideExisting: false
 * };
 *
 * // With type parameter (type-safe)
 * interface IMacieConfigForState {
 *   enable: boolean;
 *   accountsCount: number;
 * }
 *
 * const config: IModuleStateConfig<IMacieConfigForState> = {
 *   serviceName: 'MACIE',
 *   currentConfig: { enable: true, accountsCount: 5 },  // Type-checked!
 *   overrideExisting: false
 * };
 * ```
 */
export interface IModuleStateConfig<T = unknown> {
  /**
   * Service name (e.g., 'MACIE', 'GUARDDUTY', 'SECURITYHUB', 'DETECTIVE')
   */
  readonly serviceName: string;

  /**
   * Current module configuration object
   * Will be compared with last execution configuration
   *
   * @remarks
   * Each service should define their own config type for state comparison.
   * The type should include only fields relevant for change detection
   * (e.g., enable flags, counts, IDs, but not full nested objects).
   */
  readonly currentConfig: T;

  /**
   * Override existing state check flag
   * When true, module will execute even if configuration hasn't changed
   * This corresponds to the overrideExisting field in service configs
   */
  readonly overrideExisting: boolean;
}

/**
 * Configuration for building stack retention configurations.
 * Generic interface that works for any stack type and migration scenario.
 */
export interface IStackConfigBuilderInput {
  /** Stack name prefix (e.g., 'AWSAccelerator-OrganizationsStack', 'AWSAccelerator-NetworkVpcStack') */
  readonly stackPrefix: string;
  /** List of AWS account IDs to create stack configs for */
  readonly accounts: string[];
  /** List of AWS regions to create stack configs for */
  readonly regions: string[];
  /** Custom resource types to retain from these stacks */
  readonly resourceTypes: string[];
  /** Optional account access role name for cross-account operations */
  readonly accountAccessRoleName?: string;
  /**
   * S3 bucket name for uploading modified CloudFormation templates.
   * Always uses the CDK bootstrap bucket in the home region.
   * @example 'cdk-accel-assets-XXXXXXXXXXXX-us-east-1'
   */
  readonly s3BucketName: string;
  /**
   * AWS region where the S3 bucket exists.
   * This is typically the home region where the CDK bootstrap bucket is located.
   * Used to create the S3 client with the correct regional endpoint.
   * @example 'us-east-1'
   */
  readonly bucketRegion: string;
}
