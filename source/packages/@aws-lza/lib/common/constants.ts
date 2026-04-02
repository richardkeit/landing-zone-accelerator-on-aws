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
 * @fileoverview AWS LZA Common Constants - Default configuration values for multi-account operations
 *
 * Provides centralized constant definitions for concurrency control, timeout management,
 * and operational parameters used across AWS Landing Zone Accelerator modules. These
 * constants ensure consistent behavior and performance characteristics for multi-account,
 * multi-region AWS service operations.
 *
 * The constants are designed for large-scale enterprise deployments with hundreds of
 * accounts across multiple regions, providing balanced performance while respecting
 * AWS API rate limits and operational constraints.
 *
 * @example Basic usage in batch operations
 * ```typescript
 * import {
 *   DEFAULT_MAX_CONCURRENT_ENVIRONMENTS,
 *   DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS
 * } from './constants';
 *
 * // Configure batch processor with default settings
 * const batchConfig = {
 *   maxConcurrentEnvironments: DEFAULT_MAX_CONCURRENT_ENVIRONMENTS,
 *   operationTimeoutMs: DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS
 * };
 * ```
 *
 * @example Custom configuration with constants as baseline
 * ```typescript
 * // Scale up for high-performance environments
 * const highPerformanceConfig = {
 *   maxConcurrentEnvironments: DEFAULT_MAX_CONCURRENT_ENVIRONMENTS * 2,
 *   operationTimeoutMs: DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS * 5
 * };
 * ```
 *
 * @author AWS Solutions Team
 * @since 1.0.0
 */

/**
 * Default maximum number of concurrent account-region environments to process simultaneously.
 *
 * @description
 * Controls the parallel processing limit for multi-account operations across AWS regions.
 * This value balances throughput optimization with AWS API rate limit compliance.
 * Suitable for large enterprise deployments with hundreds of accounts.
 *
 * @remarks
 * This constant is used by:
 * - Batch processors for account operations
 * - Multi-region service enablement
 * - Concurrent AWS API operations
 *
 * Consider reducing this value if encountering AWS API throttling errors.
 * Consider increasing for smaller deployments or higher API limits.
 *
 * @example
 * ```typescript
 * // Use in batch operation settings
 * const settings: IBatchOperationSettings = {
 *   maxConcurrentEnvironments: DEFAULT_MAX_CONCURRENT_ENVIRONMENTS
 * };
 *
 * // Scale for specific use cases
 * const conservativeLimit = DEFAULT_MAX_CONCURRENT_ENVIRONMENTS / 2; // 25
 * const aggressiveLimit = DEFAULT_MAX_CONCURRENT_ENVIRONMENTS * 1.5; // 75
 * ```
 *
 * @see {@link IBatchOperationSettings.maxConcurrentEnvironments}
 * @constant
 * @default 50
 */
export const DEFAULT_MAX_CONCURRENT_ENVIRONMENTS = 50;

/**
 * Default timeout in milliseconds for security module operations per account-region environment.
 *
 * @description
 * Maximum time limit for security module operations to complete within a single account-region
 * environment. This is a hard timeout - if any operation within an environment does not
 * complete within this timeframe, the process will fail for that environment.
 *
 * @remarks
 * This timeout applies per environment (account-region combination):
 * - AWS security service enablement (GuardDuty, Macie, Security Hub, etc.)
 * - IAM role and policy operations
 * - Cross-account credential operations
 * - Service configuration updates
 *
 * **Important**: This is NOT a retry mechanism or throttle handling timeout.
 * Operations that exceed this limit will fail permanently for that environment.
 * No retries are performed - this is the absolute upper limit for completion.
 *
 * @example
 * ```typescript
 * // Use in environment operation configuration
 * const environmentConfig = {
 *   timeoutMs: DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS  // Must complete in 1 minute or fail
 * };
 *
 * // Scale timeout for complex environments
 * const complexEnvironmentTimeout = DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS * 5; // 5 minutes max
 * ```
 *
 * @see {@link IBatchOperationSettings.operationTimeoutMs}
 * @constant
 * @default 60000 (5 minute)
 */
export const DEFAULT_SECURITY_OPERATION_TIMEOUTS_MS = 5 * 60000;

/**
 * Default batch size for parallel member operations within a single region.
 *
 * @description
 * Controls how many member account API calls (e.g., CreateMember, DeleteMember)
 * are executed concurrently within a single region. Batches are processed
 * sequentially, with each batch running its items in parallel via Promise.allSettled.
 *
 * This value balances throughput with per-region API rate limits for services
 * like Macie, GuardDuty, and Security Hub that have relatively low TPS limits
 * for member management operations.
 *
 * @constant
 * @default 10
 */
export const DEFAULT_MEMBER_BATCH_SIZE = 10;
