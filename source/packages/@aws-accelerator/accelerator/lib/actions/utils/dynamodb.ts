/**
 * @fileoverview DynamoDB helper functions for LZA state management operations.
 *
 * @description
 * This module provides simplified wrapper functions around the aws-lza DynamoDB utilities
 * for common state management operations. It offers a higher-level API for:
 * - Single item retrieval (getItem)
 * - Single item insertion/update (putItem)
 * - DynamoDB client creation with proper configuration
 *
 * These helpers reduce boilerplate code in module actions that need to interact with
 * DynamoDB tables for state persistence, configuration tracking, and execution history.
 *
 * The module wraps the lower-level aws-lza functions (queryDynamoDBTable, putItemsBatch)
 * with simpler interfaces optimized for single-item operations, which are the most
 * common use case in LZA module state management.
 *
 * @example
 * ```typescript
 * // Create client and perform state operations
 * const client = createDynamoDBClient('us-east-1', 'AwsSolution/SO0199/v1.0.0');
 *
 * // Get module state
 * const state = await getItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   { PK: 'MODULE#macie', SK: 'EXECUTION#latest' },
 *   'XXXXXXXXXXXX:us-east-1'
 * );
 *
 * // Update module state
 * await putItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   {
 *     PK: 'MODULE#macie',
 *     SK: 'EXECUTION#latest',
 *     configHash: 'abc123...',
 *     lastExecutionTime: new Date().toISOString()
 *   },
 *   'XXXXXXXXXXXX:us-east-1',
 *   false
 * );
 * ```
 *
 * @see {@link https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ | DynamoDB Developer Guide}
 */

/**
 * DynamoDB helper functions for state management.
 * Provides simplified wrappers around the aws-lza DynamoDB utilities for common state operations.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createLogger, IAssumeRoleCredential, putItemsBatch, queryDynamoDBTable, setRetryStrategy } from 'aws-lza';
import path from 'node:path';

/**
 * Logger instance for DynamoDB operations.
 *
 * @private
 * @constant
 *
 * @description
 * Provides structured logging for DynamoDB helper operations including:
 * - Item retrieval operations
 * - Item insertion/update operations
 * - Error conditions
 *
 * Uses the filename as the logger context for easy identification in log aggregation systems.
 */
const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Retrieves a single item from a DynamoDB table by partition key and sort key.
 *
 * @async
 * @function getItem
 * @export
 *
 * @description
 * Simplified wrapper around queryDynamoDBTable for retrieving a single item.
 * This is the most common DynamoDB read pattern in LZA module state management.
 *
 * The function:
 * 1. Queries the table using the provided partition key (PK) and optional sort key (SK)
 * 2. Limits results to 1 item for efficiency
 * 3. Returns the item if found, or null if not found
 * 4. Throws an error if the query operation fails
 *
 * This wrapper simplifies the aws-lza queryDynamoDBTable API by:
 * - Handling the common single-item retrieval pattern
 * - Providing a simpler return type (item or null)
 * - Reducing boilerplate in calling code
 *
 * @param {DynamoDBClient} client - Configured DynamoDB client instance
 * @param {string} tableName - Name of the DynamoDB table to query
 * @param {Record<string, string>} key - Object containing PK and optionally SK values
 * @param {string} key.PK - Partition key value (required)
 * @param {string} [key.SK] - Sort key value (optional)
 * @param {string} logPrefix - Prefix for logging messages (format: accountId:region)
 *
 * @returns {Promise<Record<string, unknown> | null>} The item if found, null if not found
 *
 * @throws {Error} When DynamoDB query operation fails
 * @throws {Error} When table does not exist
 * @throws {Error} When credentials are invalid or expired
 *
 * @example
 * ```typescript
 * // Get latest module execution state
 * const client = createDynamoDBClient('us-east-1', 'AwsSolution/SO0199/v1.0.0');
 * const state = await getItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   { PK: 'MODULE#macie', SK: 'EXECUTION#latest' },
 *   'XXXXXXXXXXXX:us-east-1'
 * );
 *
 * if (state) {
 *   // State found - check configuration hash
 *   const previousHash = state.configHash;
 * } else {
 *   // No previous state - first execution
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Get retention state for a specific stack
 * const retentionState = await getItem(
 *   client,
 *   'AWSAccelerator-Resource-Retention-XXXXXXXXXXXX-us-east-1',
 *   { PK: 'RETENTION#macie', SK: 'STACK#XXXXXXXXXXXX#us-east-1#AWSAccelerator-SecurityStack' },
 *   'XXXXXXXXXXXX:us-east-1'
 * );
 * ```
 *
 * @see {@link queryDynamoDBTable} - Lower-level query function from aws-lza
 */
export async function getItem(
  client: DynamoDBClient,
  tableName: string,
  key: Record<string, string>,
  logPrefix: string,
): Promise<Record<string, unknown> | null> {
  try {
    logger.info(`Getting item from table ${tableName} with key: ${JSON.stringify(key)}`, logPrefix);

    const result = await queryDynamoDBTable({
      client,
      tableName,
      partitionKey: { name: 'PK', value: key['PK'] },
      sortKey: key['SK'] ? { name: 'SK', value: key['SK'] } : undefined,
      limit: 1,
      pagination: { enabled: true },
      logPrefix,
    });

    if (!result.items || result.items.length === 0) {
      logger.info(`No item found in table ${tableName} with key: ${JSON.stringify(key)}`, logPrefix);
      return null;
    }

    logger.info(`Successfully retrieved item from table ${tableName}`, logPrefix);
    return result.items[0];
  } catch (error: unknown) {
    logger.error(`Error getting item from table ${tableName}: ${error}`, logPrefix);
    throw error;
  }
}

/**
 * Inserts or updates a single item in a DynamoDB table.
 *
 * @async
 * @function putItem
 * @export
 *
 * @description
 * Simplified wrapper around putItemsBatch for inserting or updating a single item.
 * This is the most common DynamoDB write pattern in LZA module state management.
 *
 * The function:
 * 1. Wraps the single item in an array for putItemsBatch
 * 2. Writes the item to the specified table
 * 3. Supports dry-run mode for testing without making changes
 * 4. Throws an error if the write operation fails
 *
 * This wrapper simplifies the aws-lza putItemsBatch API by:
 * - Handling the common single-item write pattern
 * - Eliminating the need to wrap items in arrays
 * - Reducing boilerplate in calling code
 *
 * **Note:** DynamoDB PutItem replaces the entire item if it exists. To update specific
 * attributes, use UpdateItem instead (not provided by this helper).
 *
 * @param {DynamoDBClient} client - Configured DynamoDB client instance
 * @param {string} tableName - Name of the DynamoDB table
 * @param {Record<string, unknown>} item - Item to insert or update in the table (must include PK and SK)
 * @param {string} logPrefix - Prefix for logging messages (format: accountId:region)
 * @param {boolean} dryRun - Whether to perform dry run without making changes
 *
 * @returns {Promise<void>} Resolves when item is successfully written
 *
 * @throws {Error} When DynamoDB put operation fails
 * @throws {Error} When table does not exist
 * @throws {Error} When credentials are invalid or expired
 * @throws {Error} When item is missing required keys (PK, SK)
 *
 * @example
 * ```typescript
 * // Save module execution state
 * const client = createDynamoDBClient('us-east-1', 'AwsSolution/SO0199/v1.0.0');
 * await putItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   {
 *     PK: 'MODULE#macie',
 *     SK: 'EXECUTION#latest',
 *     serviceName: 'macie',
 *     configHash: 'c190b26ac4cf147dc171fdd480609f3b56ea61809b20a47b330096769d8250ff',
 *     lastExecutionTime: '2024-01-15T10:30:00.000Z',
 *     status: 'COMPLETED'
 *   },
 *   'XXXXXXXXXXXX:us-east-1',
 *   false
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Save retention state for a stack
 * await putItem(
 *   client,
 *   'AWSAccelerator-Resource-Retention-XXXXXXXXXXXX-us-east-1',
 *   {
 *     PK: 'RETENTION#macie',
 *     SK: 'STACK#XXXXXXXXXXXX#us-east-1#AWSAccelerator-SecurityStack',
 *     stackName: 'AWSAccelerator-SecurityStack-XXXXXXXXXXXX-us-east-1',
 *     retentionStatus: 'COMPLETED',
 *     modifiedResources: ['MacieExportConfig'],
 *     timestamp: '2024-01-15T10:30:00.000Z'
 *   },
 *   'XXXXXXXXXXXX:us-east-1',
 *   false
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Dry run example
 * await putItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   { PK: 'MODULE#macie', SK: 'EXECUTION#latest', configHash: 'abc123' },
 *   'XXXXXXXXXXXX:us-east-1',
 *   true  // Dry run - no actual write
 * );
 * ```
 *
 * @see {@link putItemsBatch} - Lower-level batch write function from aws-lza
 */
export async function putItem(
  client: DynamoDBClient,
  tableName: string,
  item: Record<string, unknown>,
  logPrefix: string,
  dryRun: boolean,
): Promise<void> {
  try {
    logger.info(`Putting item into table ${tableName}`, logPrefix);

    await putItemsBatch({
      client,
      tableName,
      items: [item],
      dryRun,
      logPrefix,
    });

    logger.info(`Successfully put item into table ${tableName}`, logPrefix);
  } catch (error: unknown) {
    logger.error(`Error putting item into table ${tableName}: ${error}`, logPrefix);
    throw error;
  }
}

/**
 * Creates a configured DynamoDB client instance.
 *
 * @function createDynamoDBClient
 * @export
 *
 * @description
 * Factory function for creating DynamoDB client instances with proper LZA configuration.
 * The client is configured with:
 * - Custom user agent for solution tracking
 * - Retry strategy with exponential backoff
 * - Optional cross-account credentials
 *
 * This function ensures consistent client configuration across all DynamoDB operations
 * in LZA modules, including proper error handling, retry behavior, and credential management.
 *
 * **Same-Account Operations:**
 * When operating in the same account, credentials are inherited from the execution environment
 * (IAM role, environment variables, or instance profile).
 *
 * **Cross-Account Operations:**
 * When operating across accounts, provide credentials obtained from STS AssumeRole.
 * The credentials should have permissions to access the target DynamoDB table.
 *
 * @param {string} region - AWS region for the DynamoDB client
 * @param {string} solutionId - Solution identifier for custom user agent (e.g., 'AwsSolution/SO0199/v1.0.0')
 * @param {IAssumeRoleCredential} [credentials] - Optional credentials for cross-account access
 *
 * @returns {DynamoDBClient} Configured DynamoDB client instance
 *
 * @example
 * ```typescript
 * // Same-account client (uses default credentials)
 * const client = createDynamoDBClient(
 *   'us-east-1',
 *   'AwsSolution/SO0199/v1.0.0'
 * );
 *
 * // Use client for operations
 * const state = await getItem(
 *   client,
 *   'AWSAccelerator-Module-State-XXXXXXXXXXXX-us-east-1',
 *   { PK: 'MODULE#macie', SK: 'EXECUTION#latest' },
 *   'XXXXXXXXXXXX:us-east-1'
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Cross-account client with assumed role credentials
 * import { getCredentials } from 'aws-lza';
 *
 * const credentials = await getCredentials({
 *   accountId: 'YYYYYYYYYYYY',
 *   region: 'us-east-1',
 *   assumeRoleName: 'AWSControlTowerExecution',
 *   partition: 'aws',
 *   logPrefix: 'XXXXXXXXXXXX:us-east-1'
 * });
 *
 * const client = createDynamoDBClient(
 *   'us-east-1',
 *   'AwsSolution/SO0199/v1.0.0',
 *   credentials
 * );
 *
 * // Client now has access to DynamoDB tables in account YYYYYYYYYYYY
 * ```
 *
 * @example
 * ```typescript
 * // Multi-region client creation
 * const regions = ['us-east-1', 'us-west-2', 'eu-west-1'];
 * const clients = regions.map(region =>
 *   createDynamoDBClient(region, 'AwsSolution/SO0199/v1.0.0')
 * );
 * ```
 *
 * @see {@link IAssumeRoleCredential} - Credential interface from aws-lza
 * @see {@link setRetryStrategy} - Retry strategy configuration from aws-lza
 */
export function createDynamoDBClient(
  region: string,
  solutionId: string,
  credentials?: IAssumeRoleCredential,
): DynamoDBClient {
  return new DynamoDBClient({
    region,
    customUserAgent: solutionId,
    retryStrategy: setRetryStrategy(),
    credentials,
  });
}
