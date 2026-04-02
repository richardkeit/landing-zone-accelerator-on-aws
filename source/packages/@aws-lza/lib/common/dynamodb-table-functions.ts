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
 * @fileoverview DynamoDB Query and Scan Utilities - Advanced DynamoDB operations with filtering
 *
 * Provides comprehensive DynamoDB query and scan operations with advanced filtering capabilities,
 * expression building, and error handling. Supports complex query patterns including partition keys,
 * sort keys, filter expressions, and various DynamoDB operators.
 *
 * Key features:
 * - Flexible query and scan operations
 * - Advanced filter expression building
 * - Support for all DynamoDB operators
 * - Automatic expression attribute value management
 * - Comprehensive error handling and validation
 * - Table existence validation and creation
 */

import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  BatchWriteCommandInput,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import path from 'node:path';
import { IDynamoDBFilter, IDynamoDBPartitionKey, IDynamoDBSortKey } from './interfaces';
import { createLogger } from './logger';
import { DynamoDBFilterOperator, DynamoDBLogicalOperator, MODULE_EXCEPTIONS } from './types';
import { executeApi } from './utility';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Validates that a DynamoDB table exists and is accessible
 * @param client - DynamoDB client instance
 * @param tableName - Name of the table to validate
 * @param logPrefix - Prefix for logging messages
 * @throws {Error} When table does not exist or is not accessible
 */
async function validateTableExists(client: DynamoDBClient, tableName: string, logPrefix: string): Promise<void> {
  await executeApi(
    'DescribeTableCommand',
    { TableName: tableName },
    () => client.send(new DescribeTableCommand({ TableName: tableName })),
    logger,
    logPrefix,
  );
}

/**
 * Builds a filter expression string from an array of filter conditions
 * @param filters - Array of filter conditions
 * @param expressionAttributeValues - Object to populate with expression attribute values
 * @param valueCounter - Counter for generating unique value placeholders
 * @param filterOperator - Logical operator for combining filters (AND/OR)
 * @returns Filter expression string
 */
function buildFilterExpression(
  filters: IDynamoDBFilter[],
  expressionAttributeValues: { [key: string]: unknown },
  valueCounter: { count: number },
  filterOperator?: DynamoDBLogicalOperator,
): string {
  const filterConditions = filters
    .map(filter => {
      const operator = filter.operator ?? DynamoDBFilterOperator.EQUALS;
      const valueKey = `:val${++valueCounter.count}`;

      switch (operator) {
        case 'attribute_exists':
          return `attribute_exists(${filter.name})`;
        case 'attribute_not_exists':
          return `attribute_not_exists(${filter.name})`;
        case 'begins_with':
          expressionAttributeValues[valueKey] = filter.value;
          return `begins_with(${filter.name}, ${valueKey})`;
        case 'contains':
          expressionAttributeValues[valueKey] = filter.value;
          return `contains(${filter.name}, ${valueKey})`;
        case 'attribute_type':
          expressionAttributeValues[valueKey] = filter.value;
          return `attribute_type(${filter.name}, ${valueKey})`;
        case 'size':
          expressionAttributeValues[valueKey] = filter.value;
          return `size(${filter.name}) = ${valueKey}`;
        case 'between': {
          const valueKey2 = `:val${++valueCounter.count}`;
          expressionAttributeValues[valueKey] = filter.value;
          expressionAttributeValues[valueKey2] = filter.value2;
          return `${filter.name} BETWEEN ${valueKey} AND ${valueKey2}`;
        }
        case 'in':
          if (filter.values) {
            const inValues = filter.values.map((_, index) => {
              const inValueKey = `:val${++valueCounter.count}`;
              expressionAttributeValues[inValueKey] = filter.values![index];
              return inValueKey;
            });
            return `${filter.name} IN (${inValues.join(', ')})`;
          }
          return '';
        default:
          expressionAttributeValues[valueKey] = filter.value;
          return `${filter.name} ${operator} ${valueKey}`;
      }
    })
    .filter(Boolean);

  return filterConditions.length > 0 ? filterConditions.join(` ${filterOperator ?? 'AND'} `) : '';
}

/**
 * Builds a key condition expression for DynamoDB query operations
 * @param partitionKey - Partition key configuration
 * @param sortKey - Optional sort key configuration
 * @param expressionAttributeValues - Object to populate with expression attribute values
 * @param valueCounter - Counter for generating unique value placeholders
 * @returns Key condition expression string
 */
function buildKeyConditionExpression(
  partitionKey: IDynamoDBPartitionKey,
  sortKey: IDynamoDBSortKey | undefined,
  expressionAttributeValues: { [key: string]: unknown },
  valueCounter: { count: number },
): string {
  expressionAttributeValues[':pk'] = partitionKey.value;
  let keyConditionExpression = `${partitionKey.name} = :pk`;

  if (sortKey) {
    const operator = sortKey.operator ?? DynamoDBFilterOperator.EQUALS;
    const skValue = `:sk${++valueCounter.count}`;
    expressionAttributeValues[skValue] = sortKey.value;

    if (operator === 'begins_with') {
      keyConditionExpression += ` AND begins_with(${sortKey.name}, ${skValue})`;
    } else if (operator === 'between') {
      const skValue2 = `:sk${++valueCounter.count}`;
      expressionAttributeValues[skValue2] = sortKey.value2;
      keyConditionExpression += ` AND ${sortKey.name} BETWEEN ${skValue} AND ${skValue2}`;
    } else {
      keyConditionExpression += ` AND ${sortKey.name} ${operator} ${skValue}`;
    }
  }

  return keyConditionExpression;
}

/**
 * Executes a DynamoDB query operation
 * @param options - Query operation configuration
 * @returns Query results with LastEvaluatedKey for pagination
 */
async function executeQuery(options: {
  docClient: DynamoDBDocumentClient;
  tableName: string;
  keyConditionExpression: string;
  filterExpression: string;
  expressionAttributeValues: { [key: string]: unknown };
  scanIndexForward: boolean | undefined;
  limit: number | undefined;
  exclusiveStartKey?: Record<string, unknown>;
  logPrefix: string;
}): Promise<{ items: { [key: string]: unknown }[] | undefined; lastEvaluatedKey?: Record<string, unknown> }> {
  const queryParameters = {
    TableName: options.tableName,
    KeyConditionExpression: options.keyConditionExpression,
    ...(Object.keys(options.expressionAttributeValues).length > 0 && {
      ExpressionAttributeValues: options.expressionAttributeValues,
    }),
    FilterExpression: options.filterExpression || undefined,
    ScanIndexForward: options.scanIndexForward,
    Limit: options.limit,
    ExclusiveStartKey: options.exclusiveStartKey,
  };

  const queryResponse = await executeApi(
    'QueryCommand',
    queryParameters,
    () => options.docClient.send(new QueryCommand(queryParameters)),
    logger,
    options.logPrefix,
  );

  return {
    items: queryResponse.Items && queryResponse.Items.length > 0 ? queryResponse.Items : undefined,
    lastEvaluatedKey: queryResponse.LastEvaluatedKey,
  };
}

/**
 * Executes a DynamoDB scan operation
 * @param options - Scan operation configuration
 * @returns Scan results with LastEvaluatedKey for pagination
 */
async function executeScan(options: {
  docClient: DynamoDBDocumentClient;
  tableName: string;
  filterExpression: string;
  expressionAttributeValues: { [key: string]: unknown };
  limit: number | undefined;
  exclusiveStartKey?: Record<string, unknown>;
  logPrefix: string;
}): Promise<{ items: { [key: string]: unknown }[] | undefined; lastEvaluatedKey?: Record<string, unknown> }> {
  const scanParameters = {
    TableName: options.tableName,
    ...(options.filterExpression && { FilterExpression: options.filterExpression }),
    ...(Object.keys(options.expressionAttributeValues).length > 0 && {
      ExpressionAttributeValues: options.expressionAttributeValues,
    }),
    Limit: options.limit,
    ExclusiveStartKey: options.exclusiveStartKey,
  };

  const scanResponse = await executeApi(
    'ScanCommand',
    scanParameters,
    () => options.docClient.send(new ScanCommand(scanParameters)),
    logger,
    options.logPrefix,
  );

  return {
    items: scanResponse.Items && scanResponse.Items.length > 0 ? scanResponse.Items : undefined,
    lastEvaluatedKey: scanResponse.LastEvaluatedKey,
  };
}

/**
 * Pagination configuration for DynamoDB query operations
 */
export interface IDynamoDBPaginationConfig {
  /** Enable automatic pagination to retrieve all results */
  readonly enabled: boolean;
  /** Optional maximum number of pages to retrieve (safety limit, default: 100) */
  readonly maxPages?: number;
}

/**
 * Executes DynamoDB query or scan with automatic pagination support.
 * Loops through all pages using LastEvaluatedKey until all results are retrieved
 * or maxPages limit is reached.
 *
 * @param options - Pagination execution configuration
 * @returns Query result with all items and pagination metadata
 */
async function executeWithPagination(options: {
  docClient: DynamoDBDocumentClient;
  tableName: string;
  partitionKey?: IDynamoDBPartitionKey;
  sortKey?: IDynamoDBSortKey;
  filters?: IDynamoDBFilter[];
  filterOperator?: DynamoDBLogicalOperator;
  scanIndexForward?: boolean;
  limit?: number;
  maxPages: number;
  logPrefix: string;
}): Promise<IDynamoDBQueryResult> {
  const allItems: { [key: string]: unknown }[] = [];
  let pageCount = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;
  let hasMorePages = true;

  logger.info(
    `Starting paginated query for table ${options.tableName} (maxPages: ${options.maxPages})`,
    options.logPrefix,
  );

  while (hasMorePages && pageCount < options.maxPages) {
    pageCount++;

    const expressionAttributeValues: { [key: string]: unknown } = {};
    const valueCounter = { count: 0 };

    // Determine if this is a query or scan operation
    const isQuery = !!options.partitionKey;

    let result: { items: { [key: string]: unknown }[] | undefined; lastEvaluatedKey?: Record<string, unknown> };

    if (isQuery) {
      // Build key condition expression for query
      const keyConditionExpression = buildKeyConditionExpression(
        options.partitionKey!,
        options.sortKey,
        expressionAttributeValues,
        valueCounter,
      );

      // Build filter expression if filters provided
      const filterExpression = options.filters
        ? buildFilterExpression(options.filters, expressionAttributeValues, valueCounter, options.filterOperator)
        : '';

      // Execute query with pagination
      result = await executeQuery({
        docClient: options.docClient,
        tableName: options.tableName,
        keyConditionExpression,
        filterExpression,
        expressionAttributeValues,
        scanIndexForward: options.scanIndexForward,
        limit: options.limit,
        exclusiveStartKey: lastEvaluatedKey,
        logPrefix: options.logPrefix,
      });
    } else {
      // Build filter expression for scan
      const filterExpression = options.filters
        ? buildFilterExpression(options.filters, expressionAttributeValues, valueCounter, options.filterOperator)
        : '';

      // Execute scan with pagination
      result = await executeScan({
        docClient: options.docClient,
        tableName: options.tableName,
        filterExpression,
        expressionAttributeValues,
        limit: options.limit,
        exclusiveStartKey: lastEvaluatedKey,
        logPrefix: options.logPrefix,
      });
    }

    // Accumulate items from this page
    if (result.items && result.items.length > 0) {
      allItems.push(...result.items);
      logger.info(
        `Page ${pageCount}: Retrieved ${result.items.length} items (total: ${allItems.length})`,
        options.logPrefix,
      );
    } else {
      logger.info(`Page ${pageCount}: No items returned`, options.logPrefix);
    }

    // Check if there are more pages
    if (result.lastEvaluatedKey) {
      lastEvaluatedKey = result.lastEvaluatedKey;
      hasMorePages = true;
    } else {
      hasMorePages = false;
      logger.info(`Pagination complete: Retrieved all items across ${pageCount} page(s)`, options.logPrefix);
    }
  }

  // Warn if we hit the maxPages limit
  if (hasMorePages && pageCount >= options.maxPages) {
    logger.warn(
      `Reached maximum page limit (${options.maxPages}). There may be more items available. ` +
        `Retrieved ${allItems.length} items across ${pageCount} pages.`,
      options.logPrefix,
    );
  }

  return {
    items: allItems.length > 0 ? allItems : undefined,
    lastEvaluatedKey,
    pageCount,
    totalItems: allItems.length,
  };
}

/**
 * Result of DynamoDB query operation with optional pagination metadata
 */
export interface IDynamoDBQueryResult {
  /** Array of items returned from the query */
  readonly items: { [key: string]: unknown }[] | undefined;
  /** Last evaluated key for pagination (present if more results available) */
  readonly lastEvaluatedKey?: Record<string, unknown>;
  /** Number of pages retrieved (only present when pagination enabled) */
  readonly pageCount?: number;
  /** Total number of items retrieved across all pages */
  readonly totalItems?: number;
}

/**
 * Performs advanced DynamoDB query or scan operations with automatic pagination support.
 * Always returns pagination metadata for consistency and observability.
 *
 * @param options - Configuration object for the DynamoDB operation
 * @param options.client - DynamoDB client instance
 * @param options.logPrefix - Prefix for logging messages
 * @param options.tableName - Name of the DynamoDB table
 * @param options.partitionKey - Optional partition key for query operations
 * @param options.sortKey - Optional sort key with operator support
 * @param options.filters - Optional array of filter conditions
 * @param options.filterOperator - Logical operator for combining filters (AND/OR)
 * @param options.scanIndexForward - Sort order for query results
 * @param options.limit - Maximum number of items to return per page
 * @param options.pagination - Pagination configuration (enabled: true is required, maxPages defaults to 100)
 * @returns Promise resolving to query result with items and pagination metadata
 *
 * @example
 * ```typescript
 * // Query with automatic pagination
 * const result = await queryDynamoDBTable({
 *   client,
 *   tableName: 'my-table',
 *   partitionKey: { name: 'PK', value: 'USER#123' },
 *   pagination: { enabled: true },
 *   logPrefix: 'MyApp'
 * });
 *
 * // Query with custom maxPages limit
 * const result = await queryDynamoDBTable({
 *   client,
 *   tableName: 'my-table',
 *   partitionKey: { name: 'PK', value: 'RETENTION#MACIE' },
 *   pagination: { enabled: true, maxPages: 50 },
 *   logPrefix: 'MyApp'
 * });
 * ```
 */
export async function queryDynamoDBTable(options: {
  client: DynamoDBClient;
  logPrefix: string;
  tableName: string;
  partitionKey?: IDynamoDBPartitionKey;
  sortKey?: IDynamoDBSortKey;
  filters?: IDynamoDBFilter[];
  filterOperator?: DynamoDBLogicalOperator;
  scanIndexForward?: boolean;
  limit?: number;
  pagination: IDynamoDBPaginationConfig & { enabled: true };
}): Promise<IDynamoDBQueryResult> {
  const docClient = DynamoDBDocumentClient.from(options.client);

  await validateTableExists(options.client, options.tableName, options.logPrefix);

  const maxPages = options.pagination.maxPages ?? 100; // Safety limit

  // Always execute with pagination
  return executeWithPagination({
    docClient,
    tableName: options.tableName,
    partitionKey: options.partitionKey,
    sortKey: options.sortKey,
    filters: options.filters,
    filterOperator: options.filterOperator,
    scanIndexForward: options.scanIndexForward,
    limit: options.limit,
    maxPages,
    logPrefix: options.logPrefix,
  });
}
/**
 * Puts an array of items into a DynamoDB table using batch write operations.
 * Handles batching, retries for unprocessed items, and comprehensive validation.
 * Items with the same primary key will be replaced (upsert behavior).
 *
 * @param options - Configuration object for the batch put operation
 * @param options.client - DynamoDB client instance
 * @param options.tableName - Name of the DynamoDB table
 * @param options.items - Array of items to insert/update in the table
 * @param options.dryRun - Whether to perform dry run without making changes
 * @param options.logPrefix - Prefix for logging messages
 * @returns Promise that resolves when all items are processed
 *
 * @throws {Error} When table does not exist (MODULE_EXCEPTIONS.INVALID_INPUT)
 * @throws {Error} When items contain invalid data (MODULE_EXCEPTIONS.INVALID_INPUT)
 * @throws {Error} When unprocessed items remain after retries (MODULE_EXCEPTIONS.SERVICE_EXCEPTION)
 *
 * @example
 * ```typescript
 * // Basic usage
 * await putItemsBatch({
 *   client: dynamoClient,
 *   tableName: 'MyTable',
 *   items: [
 *     { id: '1', name: 'Item 1', status: 'active' },
 *     { id: '2', name: 'Item 2', status: 'inactive' }
 *   ],
 *   dryRun: false,
 *   logPrefix: 'BatchInsert:us-east-1'
 * });
 *
 * // Dry run mode
 * await putItemsBatch({
 *   client: dynamoClient,
 *   tableName: 'MyTable',
 *   items: items,
 *   dryRun: true,
 *   logPrefix: 'TestRun'
 * });
 * ```
 */
export async function putItemsBatch(options: {
  client: DynamoDBClient;
  tableName: string;
  items: Record<string, unknown>[];
  dryRun: boolean;
  logPrefix: string;
}): Promise<void> {
  const docClient = DynamoDBDocumentClient.from(options.client);

  // Validate table exists
  await validateTableExists(options.client, options.tableName, options.logPrefix);

  // Handle empty items array
  if (!options.items || options.items.length === 0) {
    logger.warn(`No items provided for batch put operation on table ${options.tableName}`, options.logPrefix);
    return;
  }

  // Validate each item
  const validationErrors: string[] = [];
  for (let i = 0; i < options.items.length; i++) {
    const item = options.items[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      validationErrors.push(`Item at index ${i} is not a valid object`);
    }
  }

  if (validationErrors.length > 0) {
    const message = `${MODULE_EXCEPTIONS.INVALID_INPUT}: ${validationErrors.join(', ')}`;
    logger.error(message, options.logPrefix);
    throw new Error(message);
  }

  logger.info(`Processing ${options.items.length} items for table ${options.tableName}`, options.logPrefix);

  // Chunk items into batches of 25 (DynamoDB limit)
  const batchSize = 25;
  const batches: Record<string, unknown>[][] = [];
  for (let i = 0; i < options.items.length; i += batchSize) {
    batches.push(options.items.slice(i, i + batchSize));
  }

  logger.info(`Split into ${batches.length} batches for processing`, options.logPrefix);

  // Process each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    await processBatch(docClient, options.tableName, batch, options.dryRun, options.logPrefix, batchIndex + 1);
  }

  logger.info(`Successfully processed all ${options.items.length} items`, options.logPrefix);
}

/**
 * Processes a single batch of items with retry logic for unprocessed items
 * @param docClient - DynamoDB document client instance
 * @param tableName - Name of the DynamoDB table
 * @param items - Batch of items to process
 * @param dryRun - Whether to perform dry run
 * @param logPrefix - Prefix for logging messages
 * @param batchNumber - Batch number for logging
 * @returns Promise that resolves when batch is processed
 */
async function processBatch(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, unknown>[],
  dryRun: boolean,
  logPrefix: string,
  batchNumber: number,
): Promise<void> {
  const requestItems: BatchWriteCommandInput['RequestItems'] = {
    [tableName]: items.map(item => ({
      PutRequest: {
        Item: item,
      },
    })),
  };

  const commandName = 'BatchWriteCommand';
  const parameters = { RequestItems: requestItems };

  if (dryRun) {
    logger.dryRun(commandName, { ...parameters, ItemCount: items.length, BatchNumber: batchNumber }, logPrefix);
    return;
  }

  let unprocessedItems: typeof requestItems = requestItems;
  let retryCount = 0;
  const maxRetries = 3;

  while (Object.keys(unprocessedItems).length > 0 && retryCount <= maxRetries) {
    const response = await executeApi(
      commandName,
      { ItemCount: items.length, BatchNumber: batchNumber, RetryAttempt: retryCount },
      () => docClient.send(new BatchWriteCommand({ RequestItems: unprocessedItems })),
      logger,
      logPrefix,
    );

    if (response.UnprocessedItems && Object.keys(response.UnprocessedItems).length > 0) {
      unprocessedItems = response.UnprocessedItems;
      retryCount++;

      if (retryCount <= maxRetries) {
        const unprocessedCount = unprocessedItems[tableName]?.length || 0;
        logger.warn(
          `Batch ${batchNumber}: ${unprocessedCount} unprocessed items, retrying (attempt ${retryCount}/${maxRetries})`,
          logPrefix,
        );
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      }
    } else {
      unprocessedItems = {};
    }
  }

  // Check if there are still unprocessed items after all retries
  if (Object.keys(unprocessedItems).length > 0) {
    const unprocessedCount = unprocessedItems[tableName]?.length || 0;
    const message = `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Failed to process all items in batch ${batchNumber} after ${maxRetries} retries. ${unprocessedCount} items remain unprocessed`;
    logger.error(message, logPrefix);
    throw new Error(message);
  }

  logger.info(`Successfully processed batch ${batchNumber} with ${items.length} items`, logPrefix);
}
