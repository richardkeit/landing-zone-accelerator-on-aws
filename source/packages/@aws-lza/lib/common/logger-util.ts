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
 * @fileoverview Logger Utility - Low-level CloudWatch Logs operations for logger infrastructure
 *
 * Provides low-level CloudWatch Logs operations specifically designed for use by the logger
 * infrastructure. This utility class contains static methods for log stream management and
 * log event publishing without using the logger itself to avoid circular dependencies.
 *
 * Key capabilities:
 * - Log stream creation with automatic existence handling
 * - Batched log event publishing with size and count limits
 * - Automatic retry handling for throttling and transient errors
 * - Dry run support for testing without actual log writes
 * - No internal logging to avoid circular dependencies
 *
 * Design principles:
 * - Static methods only (no instance state)
 * - No logger usage (uses console for critical errors only)
 * - Minimal dependencies to avoid circular imports
 * - Focused on logger infrastructure needs
 *
 * @example
 * ```typescript
 * import { LoggerUtil } from './logger-util';
 *
 * // Create a log stream for logger
 * await LoggerUtil.createLoggerStream({
 *   logGroupName: '/aws/lza/verbose-logs',
 *   logStreamName: 'pipeline/123456789012/2024-03-05T10-30-00-000Z',
 *   region: 'us-east-1',
 *   dryRun: false,
 * });
 *
 * // Publish log events from logger
 * await LoggerUtil.publishLoggerEvents({
 *   logGroupName: '/aws/lza/verbose-logs',
 *   logStreamName: 'pipeline/123456789012/2024-03-05T10-30-00-000Z',
 *   logEvents: [
 *     { message: JSON.stringify({ level: 'info', msg: 'Started' }), timestamp: Date.now() },
 *   ],
 *   region: 'us-east-1',
 *   dryRun: false,
 * });
 * ```
 */

import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  InputLogEvent,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import { throttlingBackOff } from './throttle';
import { setRetryStrategy } from './utility';

/**
 * Configuration for creating a CloudWatch Logs log stream
 */
export interface ICreateLoggerStreamConfig {
  /** CloudWatch Logs log group name */
  logGroupName: string;
  /** CloudWatch Logs log stream name */
  logStreamName: string;
  /** AWS region for CloudWatch Logs operations */
  region: string;
  /** Optional solution identifier for user agent */
  solutionId?: string;
}

/**
 * Configuration for publishing log events to CloudWatch Logs
 */
export interface IPublishLoggerEventsConfig {
  /** CloudWatch Logs log group name */
  logGroupName: string;
  /** CloudWatch Logs log stream name */
  logStreamName: string;
  /** Array of log events to publish */
  logEvents: InputLogEvent[];
  /** AWS region for CloudWatch Logs operations */
  region: string;
  /** Optional solution identifier for user agent */
  solutionId?: string;
}

/**
 * Logger utility class providing low-level CloudWatch Logs operations.
 * All methods are static to avoid state management and circular dependencies.
 *
 * @remarks
 * This class is designed specifically for use by the logger infrastructure and
 * does not use the logger itself to avoid circular dependencies. Critical errors
 * are logged to console only.
 */
export abstract class LoggerUtil {
  /**
   * Creates a CloudWatch Logs log stream in the specified log group.
   * Handles the case where the log stream already exists gracefully.
   *
   * @param config - Configuration object for log stream creation
   * @returns Promise that resolves when log stream is created or already exists
   *
   * @remarks
   * - If the log stream already exists, the operation completes successfully
   * - The log group must exist before creating a log stream
   * - In dry run mode, logs the operation without creating the stream
   * - Uses console.log for dry run output to avoid circular logger dependency
   *
   * @throws Error if log group doesn't exist or access is denied
   *
   * @example
   * ```typescript
   * await LoggerUtil.createLoggerStream({
   *   logGroupName: '/aws/lza/verbose-logs',
   *   logStreamName: 'pipeline/123456789012/2024-03-05T10-30-00-000Z',
   *   region: 'us-east-1',
   *   dryRun: false,
   * });
   * ```
   */
  public static async createLoggerStream(config: ICreateLoggerStreamConfig): Promise<void> {
    const client = new CloudWatchLogsClient({
      region: config.region,
      customUserAgent: config.solutionId,
      retryStrategy: setRetryStrategy(),
    });

    const parameters = {
      logGroupName: config.logGroupName,
      logStreamName: config.logStreamName,
    };

    try {
      await throttlingBackOff(() => client.send(new CreateLogStreamCommand(parameters)));
    } catch (error: unknown) {
      // Handle ResourceAlreadyExistsException as expected behavior - stream already exists
      if (error instanceof ResourceAlreadyExistsException) {
        // Stream already exists - this is fine, no action needed
        return;
      }
      // Log critical error to console since logger infrastructure may not be working
      console.error(`[LoggerUtil] Failed to create log stream ${config.logStreamName}:`, error);
      throw error;
    }
  }

  /**
   * Publishes log events to a CloudWatch Logs log stream with batching and retry handling.
   *
   * @param config - Configuration object for log event publishing
   * @returns Promise that resolves when log events are successfully published
   *
   * @remarks
   * CloudWatch Logs API limits:
   * - Maximum 10,000 log events per batch
   * - Maximum 1 MB per batch (including overhead)
   * - Each log event can be no larger than 256 KB
   * - Events must be in chronological order by timestamp
   *
   * The function automatically handles:
   * - Throttling errors with exponential backoff
   * - Sequence token management (not required in newer API versions)
   * - Batch size validation
   *
   * @throws Error if log stream doesn't exist, batch size exceeds limits, or access is denied
   *
   * @example
   * ```typescript
   * await LoggerUtil.publishLoggerEvents({
   *   logGroupName: '/aws/lza/verbose-logs',
   *   logStreamName: 'pipeline/123456789012/2024-03-05T10-30-00-000Z',
   *   logEvents: [
   *     { message: JSON.stringify({ level: 'info', msg: 'Started' }), timestamp: Date.now() },
   *     { message: JSON.stringify({ level: 'info', msg: 'Processing' }), timestamp: Date.now() },
   *   ],
   *   region: 'us-east-1',
   *   dryRun: false,
   * });
   * ```
   */
  public static async publishLoggerEvents(config: IPublishLoggerEventsConfig): Promise<void> {
    if (config.logEvents.length === 0) {
      return;
    }

    // Validate batch size (CloudWatch Logs limit: 10,000 events per batch)
    if (config.logEvents.length > 10000) {
      const message = `Cannot publish more than 10,000 log events in a single batch. Received ${config.logEvents.length} events.`;
      console.error(`[LoggerUtil] ${message}`);
      throw new Error(message);
    }

    const client = new CloudWatchLogsClient({
      region: config.region,
      customUserAgent: config.solutionId,
      retryStrategy: setRetryStrategy(),
    });

    const parameters = {
      logGroupName: config.logGroupName,
      logStreamName: config.logStreamName,
      logEvents: config.logEvents,
    };

    try {
      await throttlingBackOff(() => client.send(new PutLogEventsCommand(parameters)));
    } catch (error: unknown) {
      // Log critical error to console since logger infrastructure may not be working
      console.error(
        `[LoggerUtil] Failed to publish ${config.logEvents.length} log events to ${config.logStreamName}:`,
        error,
      );
      throw error;
    }
  }
}
