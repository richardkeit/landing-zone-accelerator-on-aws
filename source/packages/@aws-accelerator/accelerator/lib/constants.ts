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
 * @fileoverview System constants for Landing Zone Accelerator on AWS (LZA).
 *
 * Defines default thresholds and limits for LZA prerequisite validation.
 */

/**
 * Default minimum CodeBuild concurrency threshold for LZA prerequisite validation.
 *
 * Minimum number of concurrent CodeBuild projects required for LZA pipeline execution.
 *
 * @default 3
 */
export const DefaultMinimumCodeBuildConcurrencyThreshold = '3';

/**
 * Default minimum Lambda concurrency threshold for LZA prerequisite validation.
 *
 * Minimum number of concurrent Lambda function executions required for LZA operations.
 *
 * @default 100
 */
export const DefaultMinimumLambdaConcurrencyThreshold = '100';

/**
 * Default CloudFormation retention batch size for concurrent stack processing.
 *
 * Number of CloudFormation stacks to process concurrently during retention operations.
 * This limit prevents CloudFormation API throttling (UpdateStack: 5 TPS, GetTemplate: 10 TPS).
 * Can be overridden via CFN_RETENTION_BATCH_SIZE environment variable.
 *
 * @default 10
 */
export const DefaultCfnRetentionBatchSize = 10;
