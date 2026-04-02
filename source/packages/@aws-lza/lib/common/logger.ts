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
 * @fileoverview Logging Infrastructure - Winston-based logging with icons and structured output
 *
 * Provides comprehensive logging infrastructure for AWS Landing Zone Accelerator operations
 * with visual icons, structured formatting, and multiple logger types. The logging system
 * supports both general application logging and high-priority status messages with
 * consistent formatting and configurable log levels.
 *
 * Key features:
 * - Icon-enhanced log messages for visual clarity
 * - Structured logging with timestamps and labels
 * - Configurable log levels via environment variables
 * - Specialized loggers for different message types
 * - AWS API operation logging with parameter tracking
 * - Dry run operation logging for testing scenarios
 *
 * @example
 * ```typescript
 * import { createLogger, createStatusLogger } from './logger';
 *
 * // Create module-specific logger
 * const logger = createLogger(['macie', 'enable']);
 *
 * // Log different message types with icons
 * logger.info('Starting Macie configuration', 'Account1:us-east-1');
 * logger.processStart('Beginning account setup');
 * logger.processEnd('Account setup completed successfully');
 * logger.warn('Rate limiting detected, retrying');
 * logger.error('Failed to enable Macie', 'Account2:us-west-2');
 *
 * // Log AWS API operations
 * logger.commandExecution('EnableMacieCommand', { findingFrequency: 'FIFTEEN_MINUTES' });
 * logger.dryRun('EnableMacieCommand', { findingFrequency: 'FIFTEEN_MINUTES' });
 *
 * // Create status logger for high-priority messages
 * const statusLogger = createStatusLogger(['deployment']);
 * statusLogger.info('Deployment phase completed');
 * ```
 */

import { InputLogEvent } from '@aws-sdk/client-cloudwatch-logs';
import * as winston from 'winston';
import TransportStream from 'winston-transport';
import { LoggerUtil } from './logger-util';

// ─── Log Sanitization ───────────────────────────────────────────────────────
// Patterns and utility for sanitizing sensitive data and preventing log injection (CWE-117).
// Applied at the Winston format level so ALL transports (Console, CloudWatch) are covered.

const SENSITIVE_JSON_KEYS =
  /"(secretAccessKey|sessionToken|password|secret|accessToken|authorization|credential|privateKey|apiKey)":\s*"[^"]*"/gi;
const AWS_SESSION_TOKEN_PATTERN = /(?:FwoGZXIvYXdzE|IQoJb3JpZ2luX2Vj)[A-Za-z0-9/+=]{200,1200}/g;

/**
 * Sanitize a log message by masking sensitive data and neutralizing control characters.
 *
 * Covers:
 * - Known sensitive JSON key-value pairs (secretAccessKey, sessionToken, password, etc.)
 * - AWS STS session tokens (by known prefix patterns)
 * - Log injection via control characters (CWE-117): newlines and tabs replaced with visible symbols
 */
function sanitizeLogMessage(message: string): string {
  let sanitized = message;
  sanitized = sanitized.replace(SENSITIVE_JSON_KEYS, '"$1":"[REDACTED]"');
  sanitized = sanitized.replace(AWS_SESSION_TOKEN_PATTERN, '[REDACTED_SESSION_TOKEN]');
  sanitized = sanitized.replace(/[\r\n]/g, '⏎').replace(/\t/g, '⇥');
  return sanitized;
}

/**
 * Winston format that sanitizes the message field before it reaches any transport.
 * This ensures both Console and CloudWatch transports receive sanitized output.
 */
const sanitizeFormat = winston.format(info => {
  if (typeof info.message === 'string') {
    info.message = sanitizeLogMessage(info.message);
  }
  return info;
});

/**
 * Custom Winston transport that batches logs and publishes to CloudWatch Logs using LoggerUtil.
 * Buffers log events in memory and flushes them periodically to optimize API calls.
 *
 * @remarks
 * Retry and Fallback Strategy:
 *
 * This transport implements a resilient retry mechanism with automatic fallback to console logging
 * when CloudWatch Logs becomes unavailable. This ensures that logging failures never crash the
 * application and that log messages are never lost.
 *
 * Retry Behavior:
 * - Attempt 1 fails → Logs re-queued to buffer, retry in 2 seconds
 * - Attempt 2 fails → Logs re-queued to buffer, retry in 2 seconds
 * - Attempt 3 fails → Fallback mode activated
 *
 * Fallback Mode Activation (after 3 consecutive failures):
 * 1. Sets fallbackToConsole flag to true
 * 2. Logs clear warning message to console with ⚠️ [CLOUDWATCH FALLBACK] prefix
 * 3. Dumps all buffered logs to console with clean output (no additional prefixes)
 * 4. Clears buffer to free memory
 * 5. All future logs go directly to console with clean output (no additional prefixes)
 * 6. CloudWatch API calls are skipped entirely
 *
 * Normal Operation:
 * - Logs are buffered in memory
 * - Buffer is flushed every 2 seconds (configurable via uploadRate)
 * - Maximum 10,000 events per batch (CloudWatch Logs API limit)
 * - Successful flush resets the consecutive failure counter
 *
 * Process Exit Handling:
 * - Registers 'beforeExit' handler to flush pending logs
 * - Best-effort flush on process termination
 * - Prevents log loss during graceful shutdown
 *
 * Memory Management:
 * - Buffer is cleared when fallback mode is activated
 * - Failed logs are re-queued only during retry phase (not in fallback mode)
 * - No unbounded buffer growth
 *
 * Error Handling:
 * - All CloudWatch API errors are caught and handled gracefully
 * - Process never crashes due to logging failures
 * - Errors are logged to console for operator visibility
 *
 * @example
 * ```typescript
 * // Create transport for CloudWatch Logs
 * const transport = new CloudWatchLogsTransport({
 *   logGroupName: '/aws/lza/verbose-logs',
 *   logStreamName: 'pipeline/123456789012/2024-03-05T10-30-00-000Z',
 *   region: 'us-east-1',
 *   uploadRate: 2000, // Flush every 2 seconds
 * });
 *
 * // Add to Winston logger
 * logger.add(transport);
 *
 * // Logs will be batched and sent to CloudWatch
 * // If CloudWatch fails 3 times, logs automatically go to console
 * ```
 */
/** @internal Exported for unit testing only */
export class CloudWatchLogsTransport extends TransportStream {
  private logBuffer: InputLogEvent[] = [];
  private flushInterval: NodeJS.Timeout;
  private logGroupName: string;
  private logStreamName: string;
  private region: string;
  private isFlushing = false;
  private consecutiveFailures = 0;
  private readonly MAX_RETRIES = 3;
  private readonly MAX_BUFFER_SIZE = 50000; // Prevent unbounded memory growth
  private readonly MAX_MESSAGE_SIZE = 256 * 1024; // 256 KB CloudWatch limit
  private readonly MAX_BATCH_BYTES = 1048576; // 1MB CloudWatch PutLogEvents limit
  private readonly EVENT_OVERHEAD_BYTES = 26; // Per-event overhead (timestamp + message length metadata)
  private fallbackToConsole = false;
  private bufferSizeWarningLogged = false;
  private isClosed = false;

  constructor(options: { logGroupName: string; logStreamName: string; region: string; uploadRate?: number }) {
    super();
    this.logGroupName = options.logGroupName;
    this.logStreamName = options.logStreamName;
    this.region = options.region;

    // Flush logs periodically (default: every 2 seconds)
    const uploadRate = options.uploadRate || 2000;
    this.flushInterval = setInterval(() => this.flush(), uploadRate);

    // Ensure logs are flushed on process exit (use once to avoid multiple handlers)
    process.once('beforeExit', () => this.flushSync());
  }

  /**
   * Sanitize sensitive data from log messages (defense-in-depth).
   * Primary sanitization happens at the Winston format level; this is a safety net
   * for the CloudWatch transport's console fallback path.
   */
  private sanitizeMessage(message: string): string {
    return sanitizeLogMessage(message);
  }

  /**
   * Winston transport log method - called for each log message
   */
  log(info: { message: string; level: string; [key: string]: unknown }, callback: () => void): void {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // Use the fully formatted message (includes timestamp, level, label)
    // Falls back to info.message if formatted string is not available
    const formattedMessage = (info[Symbol.for('message') as unknown as string] as string) || info.message;

    // Sanitize sensitive data before logging anywhere (CloudWatch or console fallback)
    const sanitizedMessage = this.sanitizeMessage(formattedMessage);

    // If transport is closed or in fallback mode, log to console instead of buffering
    if (this.isClosed || this.fallbackToConsole) {
      console.log(sanitizedMessage);
      callback();
      return;
    }

    // Validate and truncate message size if needed (CloudWatch 256 KB limit)
    let message = sanitizedMessage;
    if (message.length > this.MAX_MESSAGE_SIZE) {
      message = message.substring(0, this.MAX_MESSAGE_SIZE - 100) + '... [TRUNCATED: message exceeded 256 KB]';
    }

    // Check buffer size limit to prevent OOM
    if (this.logBuffer.length >= this.MAX_BUFFER_SIZE) {
      // Drop oldest log to prevent unbounded growth
      this.logBuffer.shift();

      // Log warning once (avoid spam)
      if (!this.bufferSizeWarningLogged) {
        console.warn(
          `⚠️  [CLOUDWATCH] Log buffer reached maximum size (${this.MAX_BUFFER_SIZE}). Dropping oldest logs.`,
        );
        this.bufferSizeWarningLogged = true;
      }
    }

    // Add log event to buffer for CloudWatch
    this.logBuffer.push({
      message: message,
      timestamp: Date.now(),
    });

    callback();
  }

  /**
   * Calculate the byte size of a log event including CloudWatch overhead.
   * CloudWatch adds 26 bytes per event for timestamp encoding and message length metadata.
   */
  private calculateEventBytes(event: InputLogEvent): number {
    return Buffer.byteLength(event.message ?? '', 'utf8') + this.EVENT_OVERHEAD_BYTES;
  }

  /**
   * Split events into chunks that each fit within the 1MB CloudWatch PutLogEvents limit.
   * Preserves chronological order of events.
   */
  private chunkEventsBySize(events: InputLogEvent[]): InputLogEvent[][] {
    const chunks: InputLogEvent[][] = [];
    let currentChunk: InputLogEvent[] = [];
    let currentChunkBytes = 0;

    for (const event of events) {
      const eventBytes = this.calculateEventBytes(event);

      // If adding this event would exceed the limit, start a new chunk
      if (currentChunkBytes + eventBytes > this.MAX_BATCH_BYTES && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkBytes = 0;
      }

      currentChunk.push(event);
      currentChunkBytes += eventBytes;
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Flush buffered logs to CloudWatch Logs asynchronously
   */
  private async flush(): Promise<void> {
    // Skip flush if transport is closed or in fallback mode
    if (this.isClosed || this.fallbackToConsole) {
      return;
    }

    // Atomic check-and-set to prevent concurrent flushes
    if (this.isFlushing || this.logBuffer.length === 0) {
      return;
    }
    this.isFlushing = true;

    const eventsToPublish = this.logBuffer.splice(0, 10000); // Max 10k events per batch

    // Split into chunks that each fit within the 1MB CloudWatch limit
    const chunks = this.chunkEventsBySize(eventsToPublish);
    const failedChunks: InputLogEvent[] = [];

    try {
      for (const chunk of chunks) {
        try {
          await LoggerUtil.publishLoggerEvents({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
            logEvents: chunk,
            region: this.region,
          });
        } catch (chunkError) {
          // Collect failed chunk events for re-buffering
          failedChunks.push(...chunk);
          console.error(`[CloudWatchLogsTransport] Failed to publish chunk of ${chunk.length} events:`, chunkError);
        }
      }

      if (failedChunks.length === 0) {
        // All chunks succeeded - reset failure counter
        this.consecutiveFailures = 0;
      } else {
        // Some chunks failed
        this.consecutiveFailures++;

        if (this.consecutiveFailures >= this.MAX_RETRIES) {
          // Max retries exceeded - activate fallback mode
          this.fallbackToConsole = true;
          console.error(
            `⚠️  [CLOUDWATCH FALLBACK] CloudWatch Logs unavailable after ${this.MAX_RETRIES} attempts. ` +
              `Switching to console logging.`,
          );

          // Dump buffered logs to console so they're not lost
          const totalBuffered = this.logBuffer.length + failedChunks.length;
          if (totalBuffered > 0) {
            console.warn(`⚠️  [CLOUDWATCH FALLBACK] Dumping ${totalBuffered} buffered logs to console...`);
            failedChunks.forEach(event => {
              console.log(event.message);
            });
            this.logBuffer.forEach(event => {
              console.log(event.message);
            });
          }

          // Clear buffer to free memory
          this.logBuffer = [];
        } else {
          // Still retrying - put only failed events back in buffer
          this.logBuffer.unshift(...failedChunks);
          console.error(
            `[CloudWatchLogsTransport] Failed to publish ${failedChunks.length} events (attempt ${this.consecutiveFailures}/${this.MAX_RETRIES}), will retry.`,
          );
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Synchronous flush for process exit - best effort
   */
  private flushSync(): void {
    if (this.logBuffer.length > 0) {
      // Attempt to flush remaining logs (fire and forget)
      this.flush().catch(err => {
        console.error('[CloudWatchLogsTransport] Failed to flush logs on exit:', err);
      });
    }
  }

  /**
   * Close the transport and clean up resources
   * Called by Winston when transport is removed or on process exit
   */
  close(): void {
    if (this.isClosed) {
      return; // Already closed
    }

    this.isClosed = true;
    clearInterval(this.flushInterval);
    this.flushSync();
  }

  /**
   * Override Winston's finish method to ensure cleanup
   * This is called when the stream is being closed
   */
  finish(callback?: () => void): void {
    this.close();
    if (callback) {
      callback();
    }
  }

  /**
   * Public async flush for explicit flush before process exit.
   * Unlike flushSync(), this properly awaits the CloudWatch API call.
   * Stops the periodic flush timer, waits for any in-flight flush to complete,
   * then drains remaining buffered logs to CloudWatch.
   *
   * @returns Promise that resolves when all buffered logs are sent to CloudWatch
   */
  async flushAsync(): Promise<void> {
    // Stop periodic flush to prevent race conditions during final drain
    clearInterval(this.flushInterval);

    // Wait for any in-flight flush to complete
    while (this.isFlushing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Drain any remaining buffered logs
    while (this.logBuffer.length > 0 && !this.fallbackToConsole && !this.isClosed) {
      await this.flush();
    }
  }
}

/**
 * Main Winston logger instance for general application logging.
 * Configured with timestamps and environment-based log levels.
 * Colorization is applied per-transport to avoid color codes in CloudWatch logs.
 */
const Logger = winston.createLogger({
  defaultMeta: { mainLabel: 'accelerator' },
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(
    sanitizeFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ message, timestamp, level, mainLabel, childLabel }) => {
      return `${timestamp} | ${level} | ${childLabel || mainLabel} | ${message}`;
    }),
    winston.format.align(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.colorize({ all: true }),
    }),
  ],
});

winston.add(Logger);

/**
 * Status logger for high-priority messages that bypass log level filtering.
 * Always logs at info level regardless of LOG_LEVEL environment variable.
 * Colorization is applied per-transport to avoid color codes in CloudWatch logs.
 */
const StatusLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    sanitizeFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ message, timestamp, childLabel }) => {
      return `${timestamp} | status | ${childLabel} | ${message}`;
    }),
    winston.format.align(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.colorize({ all: true }),
    }),
  ],
});

winston.add(StatusLogger);

/**
 * Buffered log entry for early logs before CloudWatch is ready
 */
interface BufferedLogEntry {
  message: string;
  level: 'info' | 'warn' | 'error';
  logger: winston.Logger;
  prefix?: string;
}

/**
 * Buffer for logs that occur before CloudWatch initialization completes
 */
let earlyLogBuffer: BufferedLogEntry[] = [];

/**
 * Flag indicating whether CloudWatch logging is ready
 */
let cloudWatchReady = false;

/**
 * Flush early log buffer to the appropriate logger (CloudWatch or console).
 * Called after CloudWatch initialization completes (success or failure).
 */
function flushEarlyLogBuffer(): void {
  if (earlyLogBuffer.length > 0) {
    earlyLogBuffer.forEach(({ message, level, logger, prefix }) => {
      const formattedMessage = prefix ? `[${prefix}] ${message}` : message;
      logger[level](formattedMessage);
    });
    earlyLogBuffer = [];
  }
}

// CloudWatch Logging Configuration
// Context detection: If VERBOSE_LOG_GROUP_NAME is set, use CloudWatch logging
const verboseLogGroupName = process.env['VERBOSE_LOG_GROUP_NAME'];

// Store initialization promise to allow waiting for CloudWatch setup
let cloudWatchInitPromise: Promise<void> | undefined;

if (verboseLogGroupName) {
  // CloudWatch mode - validate all required environment variables
  const stage = process.env['ACCELERATOR_STAGE'] || 'all-stages';
  const region = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'];
  const accountId = process.env['PIPELINE_ACCOUNT_ID'];

  // Validate required variables when VERBOSE_LOG_GROUP_NAME is set
  if (!region) {
    const message =
      'AWS_REGION or AWS_DEFAULT_REGION environment variable is required when VERBOSE_LOG_GROUP_NAME is set. Either provide these variables or unset VERBOSE_LOG_GROUP_NAME to use console logging.';
    console.error(message);
    throw new Error(message);
  }

  if (!accountId) {
    const message =
      'PIPELINE_ACCOUNT_ID environment variable is required when VERBOSE_LOG_GROUP_NAME is set. Either provide this variable or unset VERBOSE_LOG_GROUP_NAME to use console logging.';
    console.error(message);
    throw new Error(message);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logStreamName = `${stage}/${accountId}/${timestamp}`;

  // Create log stream before initializing transports
  // Note: The log group must exist before creating the log stream.
  // In production, the log group is created by CloudFormation (module-infrastructure.yaml).
  // Store the promise so application code can wait for initialization
  cloudWatchInitPromise = (async () => {
    try {
      // Wait for log stream creation to complete
      await LoggerUtil.createLoggerStream({
        logGroupName: verboseLogGroupName,
        logStreamName: logStreamName,
        region: region,
      });

      // Only add CloudWatch transports after stream is successfully created
      try {
        // logger → CloudWatch ONLY (remove console)
        Logger.clear();
        const loggerTransport = new CloudWatchLogsTransport({
          logGroupName: verboseLogGroupName,
          logStreamName: logStreamName,
          region: region,
          uploadRate: 2000, // Batch logs every 2 seconds
        });

        Logger.add(loggerTransport);

        // statusLogger → Console + CloudWatch
        const statusTransport = new CloudWatchLogsTransport({
          logGroupName: verboseLogGroupName,
          logStreamName: logStreamName,
          region: region,
          uploadRate: 2000,
        });

        StatusLogger.add(statusTransport);

        // Mark CloudWatch as ready and flush buffered logs
        cloudWatchReady = true;
        flushEarlyLogBuffer();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to initialize CloudWatch logging: ${errorMessage}`);
        console.error('Falling back to console-only logging.');

        // Mark as ready (fallback mode) and flush to console
        cloudWatchReady = true;
        flushEarlyLogBuffer();

        // Restore console transport for Logger (StatusLogger still has console)
        Logger.add(
          new winston.transports.Console({
            format: winston.format.colorize({ all: true }),
          }),
        );
      }
    } catch (error: unknown) {
      console.error(`Failed to create CloudWatch log stream. Falling back to console-only logging.`);
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);

      // Mark as ready (fallback mode) and flush to console
      cloudWatchReady = true;
      flushEarlyLogBuffer();
      // Continue without CloudWatch - console logging will still work
    }
  })();

  // Catch any unhandled errors from the initialization
  cloudWatchInitPromise.catch(err => {
    console.error('Unexpected error during CloudWatch initialization:', err);
  });
}

/**
 * Wait for CloudWatch logging initialization to complete.
 *
 * @description
 * This function should be called at application startup (e.g., in runner.ts main function)
 * before any logging occurs. It ensures that the CloudWatch log stream is created and
 * transports are configured before application code starts logging.
 *
 * When VERBOSE_LOG_GROUP_NAME is not set, this function returns immediately (no-op).
 * When VERBOSE_LOG_GROUP_NAME is set, this function waits for the async initialization
 * to complete, ensuring all logs go to CloudWatch from the beginning.
 *
 * @returns Promise that resolves when CloudWatch is ready (or immediately if not using CloudWatch)
 *
 * @example
 * ```typescript
 * // In runner.ts main function
 * async function main() {
 *   // Wait for logger initialization before any other code runs
 *   await waitForLoggerInitialization();
 *
 *   // Now all logs will go to CloudWatch
 *   const logger = createLogger(['runner']);
 *   logger.info('Application started');
 * }
 * ```
 */
export async function waitForLoggerInitialization(): Promise<void> {
  if (cloudWatchInitPromise) {
    await cloudWatchInitPromise;
  }
}

/**
 * Flush all CloudWatch log transports and ensure buffered logs are sent.
 *
 * @description
 * This function should be called before process exit (e.g., at the end of runner.ts main function)
 * to ensure all buffered logs are sent to CloudWatch. The `beforeExit` handler is unreliable
 * for async work because Node.js exits before the async flush completes.
 *
 * When VERBOSE_LOG_GROUP_NAME is not set, this function is a no-op.
 *
 * @returns Promise that resolves when all CloudWatch transports have flushed
 *
 * @example
 * ```typescript
 * // In runner.ts main function
 * async function main() {
 *   await waitForLoggerInitialization();
 *   // ... application code ...
 *   await flushLoggers();
 * }
 * ```
 */
export async function flushLoggers(): Promise<void> {
  const flushPromises: Promise<void>[] = [];

  for (const winstonLogger of [Logger, StatusLogger]) {
    for (const transport of winstonLogger.transports) {
      if (transport instanceof CloudWatchLogsTransport) {
        flushPromises.push(
          transport.flushAsync().catch(err => {
            console.error('[flushLoggers] Failed to flush CloudWatch transport:', err);
          }),
        );
      }
    }
  }

  await Promise.all(flushPromises);
}

/**
 * Icon-enabled logger interface providing structured logging methods with visual indicators.
 * All methods support optional prefixes for contextual information like account:region identifiers.
 *
 * @example
 * ```typescript
 * const logger = createLogger(['service-name']);
 *
 * // Basic logging with icons
 * logger.info('Operation completed successfully');           // ℹ️  Operation completed successfully
 * logger.warn('Rate limit approaching');                     // ⚠️  Rate limit approaching
 * logger.error('Authentication failed');                     // ❌  Authentication failed
 *
 * // Process lifecycle logging
 * logger.processStart('Starting deployment');               // 🚀  Starting deployment
 * logger.processEnd('Deployment completed');                // ✅  Deployment completed
 *
 * // AWS API operation logging
 * logger.commandExecution('EnableMacieCommand', { ... });   // ℹ️  Executing EnableMacieCommand with arguments: {...}
 * logger.commandSuccess('EnableMacieCommand', { ... });     // ℹ️  Successfully executed EnableMacieCommand with arguments: {...}
 * logger.dryRun('EnableMacieCommand', { ... });             // 🔍  Dry run is true, so not executing EnableMacieCommand
 *                                                           // 🔍  Would have executed EnableMacieCommand with arguments: {...}
 *
 * // Contextual logging with prefixes
 * logger.info('Macie enabled successfully', 'Account1:us-east-1');  // ℹ️  [Account1:us-east-1] Macie enabled successfully
 * ```
 */
export interface IconLogger {
  /** Log informational message with info icon (ℹ️) */
  info(message: string, prefix?: string): void;
  /** Log warning message with warning icon (⚠️) */
  warn(message: string, prefix?: string): void;
  /** Log error message with error icon (❌) */
  error(message: string, prefix?: string): void;
  /** Log process start message with rocket icon (🚀) */
  processStart(message: string, prefix?: string): void;
  /** Log process completion message with checkmark icon (✅) */
  processEnd(message: string, prefix?: string): void;
  /** Log dry run operation with magnifying glass icon (🔍) */
  dryRun(commandName: string, parameters: Record<string, unknown>, prefix?: string): void;
  /** Log AWS command execution with info icon (ℹ️) */
  commandExecution(commandName: string, parameters: Record<string, unknown>, prefix?: string): void;
  /** Log successful AWS command completion with info icon (ℹ️) */
  commandSuccess(commandName: string, parameters: Record<string, unknown>, prefix?: string): void;
}

/**
 * Internal helper function for standardized message logging with optional prefixes.
 * Handles message formatting and delegates to the appropriate Winston logger method.
 *
 * If CloudWatch is not ready yet, logs are buffered and will be flushed when CloudWatch
 * initialization completes. This ensures all logs (including module-level initialization logs)
 * go to CloudWatch instead of being lost to console.
 *
 * @param message - The message to log
 * @param level - Log level (info, warn, error)
 * @param logger - Winston logger instance to use
 * @param prefix - Optional prefix to prepend to message (typically account:region format)
 */
function logMessage(message: string, level: 'info' | 'warn' | 'error', logger: winston.Logger, prefix?: string): void {
  // If CloudWatch is ready, log normally
  if (cloudWatchReady) {
    const formattedMessage = prefix ? `[${prefix}] ${message}` : message;
    logger[level](formattedMessage);
    return;
  }

  // If CloudWatch not ready and VERBOSE_LOG_GROUP_NAME is set, buffer the log
  if (process.env['VERBOSE_LOG_GROUP_NAME']) {
    earlyLogBuffer.push({ message, level, logger, prefix });
    return;
  }

  // If CloudWatch not configured, log to console immediately
  const formattedMessage = prefix ? `[${prefix}] ${message}` : message;
  logger[level](formattedMessage);
}

/**
 * Creates an icon-enabled logger with specified labels for contextual identification.
 * The logger provides visual icons for different message types and supports optional
 * prefixes for additional context like account and region information.
 *
 * @param logInfo - Array of strings to create hierarchical logger labels (e.g., ['macie', 'enable'])
 * @returns IconLogger instance with icon-enhanced logging methods
 *
 * @example
 * ```typescript
 * // Create service-specific logger
 * const macieLogger = createLogger(['macie']);
 * macieLogger.info('Starting Macie configuration');
 * // Output: 2023-11-01 10:30:45.123 | info | macie | ℹ️  Starting Macie configuration
 *
 * // Create hierarchical logger
 * const detailedLogger = createLogger(['security-services', 'macie', 'enable']);
 * detailedLogger.processStart('Beginning account enablement');
 * // Output: 2023-11-01 10:30:45.123 | info | security-services | macie | enable | 🚀  Beginning account enablement
 *
 * // Use with contextual prefixes
 * const logger = createLogger(['batch-processor']);
 * logger.info('Processing account batch', 'Management:us-east-1');
 * // Output: 2023-11-01 10:30:45.123 | info | batch-processor | ℹ️  [Management:us-east-1] Processing account batch
 *
 * // AWS API operation logging
 * logger.commandExecution('EnableMacieCommand', {
 *   findingPublishingFrequency: 'FIFTEEN_MINUTES'
 * }, 'Account123:us-west-2');
 * // Output: 2023-11-01 10:30:45.123 | info | batch-processor | ℹ️  [Account123:us-west-2] Executing EnableMacieCommand with arguments: {"findingPublishingFrequency":"FIFTEEN_MINUTES"}
 *
 * // Dry run logging
 * logger.dryRun('CreateMemberCommand', { accountId: '123456789012' });
 * // Output: 2023-11-01 10:30:45.123 | info | batch-processor | 🔍  Dry run is true, so not executing CreateMemberCommand
 * //         2023-11-01 10:30:45.123 | info | batch-processor | 🔍  Would have executed CreateMemberCommand with arguments: {"accountId":"123456789012"}
 * ```
 */
export const createLogger = (logInfo: string[]): IconLogger => {
  if (!logInfo || logInfo.length === 0) {
    throw new Error('createLogger requires at least one log info item');
  }
  const logInfoString = logInfo.join(' | ');
  const baseLogger = Logger.child({ childLabel: logInfoString });

  return {
    info: (message: string, prefix?: string) => {
      const iconMessage = `ℹ️  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    warn: (message: string, prefix?: string) => {
      const iconMessage = `⚠️  ${message}`;
      logMessage(iconMessage, 'warn', baseLogger, prefix);
    },

    error: (message: string, prefix?: string) => {
      const iconMessage = `❌  ${message}`;
      logMessage(iconMessage, 'error', baseLogger, prefix);
    },

    processStart: (message: string, prefix?: string) => {
      const iconMessage = `🚀  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    processEnd: (message: string, prefix?: string) => {
      const iconMessage = `✅  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    dryRun: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const dryRunIcon = `🔍`;
      logMessage(`${dryRunIcon}  Dry run is true, so not executing ${commandName}`, 'info', baseLogger, prefix);
      logMessage(
        `${dryRunIcon}  Would have executed ${commandName} with arguments: ${JSON.stringify(parameters)}`,
        'info',
        baseLogger,
        prefix,
      );
    },

    commandExecution: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const iconMessage = `ℹ️  Executing ${commandName} with arguments: ${JSON.stringify(parameters)}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    commandSuccess: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const iconMessage = `ℹ️  Successfully executed ${commandName} with arguments: ${JSON.stringify(parameters)}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },
  };
};

/**
 * Creates an icon-enabled status logger for high-priority messages that bypass log level filtering.
 * Status loggers always output messages regardless of the LOG_LEVEL environment variable,
 * making them suitable for deployment status, critical alerts, and user-facing notifications.
 *
 * @param logInfo - Array of strings to create hierarchical logger labels (must not be empty)
 * @returns IconLogger instance configured for high-priority status messages
 *
 * @throws {Error} When logInfo is empty or undefined
 *
 * @example
 * ```typescript
 * // Create deployment status logger
 * const deploymentLogger = createStatusLogger(['deployment']);
 * deploymentLogger.info('Phase 1: Infrastructure deployment completed');
 * // Output: 2023-11-01 10:30:45.123 | status | deployment | ℹ️  Phase 1: Infrastructure deployment completed
 *
 * // Create module status logger
 * const moduleLogger = createStatusLogger(['macie-module']);
 * moduleLogger.processStart('Starting Macie module execution');
 * moduleLogger.processEnd('Macie module completed successfully');
 * // Output: 2023-11-01 10:30:45.123 | status | macie-module | 🚀  Starting Macie module execution
 * //         2023-11-01 10:30:45.123 | status | macie-module | ✅  Macie module completed successfully
 *
 * // Critical error logging
 * const criticalLogger = createStatusLogger(['system', 'critical']);
 * criticalLogger.error('Failed to assume role in management account');
 * // Output: 2023-11-01 10:30:45.123 | status | system | critical | ❌  Failed to assume role in management account
 *
 * // Error handling for invalid input
 * try {
 *   const invalidLogger = createStatusLogger([]);
 * } catch (error) {
 *   console.error('Error: createStatusLogger requires at least one log info item');
 * }
 * ```
 */
export const createStatusLogger = (logInfo: string[]): IconLogger => {
  if (!logInfo || logInfo.length === 0) {
    throw new Error('createStatusLogger requires at least one log info item');
  }
  const logInfoString = logInfo.join(' | ');
  const baseLogger = StatusLogger.child({ childLabel: logInfoString });

  return {
    info: (message: string, prefix?: string) => {
      const iconMessage = `ℹ️  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    warn: (message: string, prefix?: string) => {
      const iconMessage = `⚠️  ${message}`;
      logMessage(iconMessage, 'warn', baseLogger, prefix);
    },

    error: (message: string, prefix?: string) => {
      const iconMessage = `❌  ${message}`;
      logMessage(iconMessage, 'error', baseLogger, prefix);
    },

    processStart: (message: string, prefix?: string) => {
      const iconMessage = `🚀  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    processEnd: (message: string, prefix?: string) => {
      const iconMessage = `✅  ${message}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    dryRun: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const dryRunIcon = `🔍`;
      logMessage(`${dryRunIcon}  Dry run is true, so not executing ${commandName}`, 'info', baseLogger, prefix);
      logMessage(
        `${dryRunIcon}  Would have executed ${commandName} with arguments: ${JSON.stringify(parameters)}`,
        'info',
        baseLogger,
        prefix,
      );
    },

    commandExecution: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const iconMessage = `ℹ️  Executing ${commandName} with arguments: ${JSON.stringify(parameters)}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },

    commandSuccess: (commandName: string, parameters: Record<string, unknown>, prefix?: string) => {
      const iconMessage = `ℹ️  Successfully executed ${commandName} with arguments: ${JSON.stringify(parameters)}`;
      logMessage(iconMessage, 'info', baseLogger, prefix);
    },
  };
};
