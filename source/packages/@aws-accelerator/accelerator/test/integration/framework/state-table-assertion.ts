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
 * @fileoverview Shared DynamoDB state table assertion for module integration tests.
 *
 * Every module writes execution state to the same DynamoDB table via saveModuleExecutionState().
 * This utility verifies that the correct record was written after module execution.
 *
 * Uses queryDynamoDBTable from @aws-lza which provides table validation, expression building,
 * pagination, and throttling backoff — instead of raw DynamoDB SDK calls.
 */

import path from 'node:path';
import { createLogger, queryDynamoDBTable } from 'aws-lza';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AssertionResult, ResolvedEnvironment } from './types';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Options for state table assertion.
 */
export interface StateTableAssertionOptions {
  /** Module/service name as stored in PK (e.g., 'macie') */
  serviceName: string;
  /** Expected lastStatus value (e.g., 'completed', 'failed') */
  expectedStatus: string;
  /** Max age in seconds for the timestamp to be considered recent. Default: 300 (5 min) */
  maxAgeSeconds?: number;
}

/**
 * Assert that the module state table has the correct entry after execution.
 *
 * Checks:
 * - Record exists with PK=MODULE#{serviceName}, SK=EXECUTION#latest
 * - lastStatus matches expected
 * - lastExecutionTime is recent (within maxAgeSeconds)
 * - configHash is present and non-empty
 * - lastConfig is valid JSON
 */
export async function assertStateTableEntry(
  environment: ResolvedEnvironment,
  options: StateTableAssertionOptions,
): Promise<AssertionResult[]> {
  const tableName = environment.moduleInfrastructure.stateTableName;

  logger.info(`Asserting state table entry for ${options.serviceName} in ${tableName}`);

  const client = new DynamoDBClient({
    region: environment.region,
    credentials: environment.managementAccountCredentials
      ? {
          accessKeyId: environment.managementAccountCredentials.accessKeyId,
          secretAccessKey: environment.managementAccountCredentials.secretAccessKey,
          sessionToken: environment.managementAccountCredentials.sessionToken,
        }
      : undefined,
  });

  try {
    const result = await queryDynamoDBTable({
      client,
      tableName,
      logPrefix: 'StateTableAssertion',
      partitionKey: { name: 'PK', value: `MODULE#${options.serviceName}` },
      sortKey: { name: 'SK', value: 'EXECUTION#latest' },
      pagination: { enabled: true, maxPages: 1 },
    });

    if (!result.items || result.items.length === 0) {
      return [
        {
          name: 'stateTableEntryExists',
          passed: false,
          message: `No state table entry found for ${options.serviceName}`,
        },
      ];
    }

    return validateStateItem(result.items[0], options);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return [
      {
        name: 'stateTableEntryExists',
        passed: false,
        message: `Failed to query state table: ${msg}`,
      },
    ];
  }
}

/**
 * Validate fields of a retrieved state table item.
 */
function validateStateItem(item: { [key: string]: unknown }, options: StateTableAssertionOptions): AssertionResult[] {
  const maxAge = options.maxAgeSeconds ?? 300;
  const results: AssertionResult[] = [];

  results.push(
    { name: 'stateTableEntryExists', passed: true, message: `State table entry found for ${options.serviceName}` },
    assertStatus(item, options.expectedStatus),
    assertTimestamp(item, maxAge),
    assertConfigHash(item),
    assertConfigJson(item),
  );

  return results;
}

function assertStatus(item: { [key: string]: unknown }, expectedStatus: string): AssertionResult {
  const lastStatus = item['lastStatus'] as string | undefined;
  const passed = lastStatus === expectedStatus;
  return {
    name: 'stateTableStatus',
    passed,
    actual: lastStatus,
    expected: expectedStatus,
    message: passed
      ? `Status matches: ${lastStatus}`
      : `Status mismatch: expected ${expectedStatus}, got ${lastStatus}`,
  };
}

function assertTimestamp(item: { [key: string]: unknown }, maxAge: number): AssertionResult {
  const lastExecutionTime = item['lastExecutionTime'] as string | undefined;
  if (!lastExecutionTime) {
    return { name: 'stateTableTimestamp', passed: false, message: 'lastExecutionTime is missing' };
  }
  const ageSeconds = (Date.now() - new Date(lastExecutionTime).getTime()) / 1000;
  const passed = ageSeconds <= maxAge;
  return {
    name: 'stateTableTimestamp',
    passed,
    actual: `${Math.round(ageSeconds)}s ago`,
    expected: `within ${maxAge}s`,
    message: passed
      ? `Execution time is recent (${Math.round(ageSeconds)}s ago)`
      : `Execution time is stale (${Math.round(ageSeconds)}s ago, max ${maxAge}s)`,
  };
}

function assertConfigHash(item: { [key: string]: unknown }): AssertionResult {
  const configHash = item['configHash'] as string | undefined;
  const passed = !!configHash && configHash.length > 0;
  return {
    name: 'stateTableConfigHash',
    passed,
    actual: configHash ?? 'missing',
    message: passed ? `Config hash present: ${configHash}` : 'Config hash is missing',
  };
}

function assertConfigJson(item: { [key: string]: unknown }): AssertionResult {
  const lastConfig = item['lastConfig'] as string | undefined;
  if (!lastConfig) {
    return { name: 'stateTableConfigValid', passed: false, message: 'lastConfig is missing' };
  }
  try {
    JSON.parse(lastConfig);
    return { name: 'stateTableConfigValid', passed: true, message: 'lastConfig is valid JSON' };
  } catch {
    return { name: 'stateTableConfigValid', passed: false, message: 'lastConfig is invalid JSON' };
  }
}
