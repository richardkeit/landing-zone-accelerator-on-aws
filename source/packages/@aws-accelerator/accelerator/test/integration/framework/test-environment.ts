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

import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createLogger, getCredentials, IAssumeRoleCredential, setRetryStrategy } from 'aws-lza';
import path from 'node:path';
import { AccountResolver } from './account-resolver';
import { ResolvedEnvironment } from './types';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Required environment variables for module integration tests.
 */
interface RequiredEnvVars {
  accountId: string;
  partition: string;
  region: string;
  envName: string;
  prefix: string;
}

/**
 * Optional environment variables for logging configuration.
 */
interface LoggingEnvVars {
  bucketName: string;
  bucketKeyArn: string;
}

/**
 * Builds a fully resolved test environment from GitLab CI variables + ENV_MANIFEST.
 *
 * Steps:
 * 1. Read required env vars (ACCOUNT_ID, PARTITION, AWS_DEFAULT_REGION, ENV_NAME, ACCELERATOR_PREFIX)
 * 2. Resolve account mappings via AccountResolver (ENV_MANIFEST)
 * 3. Obtain STS credentials for management account (if not already inside it)
 * 4. Derive module infrastructure table names
 * 5. Verify DynamoDB tables are accessible (fail-fast)
 * 6. Build and return ResolvedEnvironment
 */
export async function buildTestEnvironment(): Promise<ResolvedEnvironment> {
  // Step 1: Read required environment variables
  const envVars = getRequiredEnvVars();
  const loggingVars = getLoggingEnvVars();

  logger.info(
    `Building test environment: ${envVars.envName} [${envVars.accountId}:${envVars.partition}:${envVars.region}]`,
  );

  // Step 2: Resolve account mappings
  const resolver = new AccountResolver(envVars.envName, envVars.partition);
  const accounts = resolver.getAccountMap();
  const managementAccountId = resolver.resolveAccountId('Management');

  // Step 3: Obtain STS credentials for management account
  const credentials = await getManagementAccountCredentials(
    envVars.accountId,
    managementAccountId,
    envVars.partition,
    envVars.region,
  );

  // Step 4: Derive module infrastructure table names
  const stateTableName = `${envVars.prefix}-Module-State-${envVars.accountId}-${envVars.region}`;
  const retentionTableName = `${envVars.prefix}-Resource-Retention-${envVars.accountId}-${envVars.region}`;

  // Set MODULE_RESOURCE_PREFIX so module code (getModuleResourcePrefix()) resolves table names correctly
  process.env['MODULE_RESOURCE_PREFIX'] = envVars.prefix;

  // Step 5: Verify DynamoDB tables are accessible
  await verifyDynamoDBTable(stateTableName, envVars.region, credentials);
  await verifyDynamoDBTable(retentionTableName, envVars.region, credentials);

  // Step 6: Build ResolvedEnvironment
  const environment: ResolvedEnvironment = {
    partition: envVars.partition,
    region: envVars.region,
    managementAccountId,
    accounts,
    managementAccountCredentials: credentials,
    prefix: envVars.prefix,
    solutionId: 'AwsSolution/SO0199',
    resourcePrefixes: {
      accelerator: envVars.prefix,
      bucketName: envVars.prefix.toLowerCase(),
      databaseName: envVars.prefix.toLowerCase(),
      kmsAlias: 'alias/accelerator',
      repoName: envVars.prefix.toLowerCase(),
      secretName: '/accelerator',
      snsTopicName: envVars.prefix,
      ssmParamName: '/accelerator',
      importResourcesSsmParamName: '/accelerator/imported-resources',
      trailLogName: `${envVars.prefix}-CloudTrail`,
      ssmLogName: `${envVars.prefix}-SSM`,
    },
    logging: {
      bucketName: loggingVars.bucketName,
      bucketKeyArn: loggingVars.bucketKeyArn,
    },
    moduleInfrastructure: {
      stateTableName,
      retentionTableName,
    },
  };

  logger.info('Test environment built successfully');
  return environment;
}

/**
 * Read and validate required environment variables.
 */
function getRequiredEnvVars(): RequiredEnvVars {
  const accountId = process.env['ACCOUNT_ID'];
  const partition = process.env['PARTITION'];
  const region = process.env['AWS_DEFAULT_REGION'];
  const envName = process.env['ENV_NAME'];
  const prefix = process.env['ACCELERATOR_PREFIX'] ?? 'AWSAccelerator';

  if (!accountId || !partition || !region || !envName) {
    throw new Error('Missing required environment variables: ACCOUNT_ID, PARTITION, AWS_DEFAULT_REGION, ENV_NAME');
  }

  return { accountId, partition, region, envName, prefix };
}

/**
 * Read logging environment variables.
 * These are required for modules that need S3 logging (e.g., Macie).
 */
function getLoggingEnvVars(): LoggingEnvVars {
  const bucketName = process.env['LOGGING_BUCKET_NAME'];
  const bucketKeyArn = process.env['LOGGING_BUCKET_KEY_ARN'];

  if (!bucketName || !bucketKeyArn) {
    throw new Error('Missing logging environment variables: LOGGING_BUCKET_NAME, LOGGING_BUCKET_KEY_ARN');
  }

  return { bucketName, bucketKeyArn };
}

/**
 * Obtain STS credentials for the management account.
 * If already running inside the management account, returns undefined.
 */
async function getManagementAccountCredentials(
  currentAccountId: string,
  managementAccountId: string,
  partition: string,
  region: string,
): Promise<IAssumeRoleCredential | undefined> {
  const solutionId = 'LzaIntegTest';

  // Check if already inside management account
  const stsClient = new STSClient({
    region,
    customUserAgent: solutionId,
    retryStrategy: setRetryStrategy(),
  });

  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  const callerAccountId = identity.Account;

  if (callerAccountId === managementAccountId) {
    logger.info('Already inside management account, no STS assume needed');
    return undefined;
  }

  logger.info(`Assuming role into management account ${managementAccountId}`);
  const roleArn = `arn:${partition}:iam::${managementAccountId}:role/LzaIntegrationTestRole`;

  const credentials = await getCredentials({
    accountId: managementAccountId,
    region,
    assumeRoleArn: roleArn,
    solutionId,
    logPrefix: `${managementAccountId}:${region}`,
  });

  logger.info('Successfully obtained management account credentials');
  return credentials;
}

/**
 * Verify a DynamoDB table exists and is accessible.
 * Fail-fast if module infrastructure hasn't been deployed.
 */
async function verifyDynamoDBTable(
  tableName: string,
  region: string,
  credentials?: IAssumeRoleCredential,
): Promise<void> {
  logger.info(`Verifying DynamoDB table: ${tableName}`);

  const client = new DynamoDBClient({
    region,
    credentials: credentials
      ? {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        }
      : undefined,
  });

  try {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const status = response.Table?.TableStatus;
    if (status !== 'ACTIVE') {
      throw new Error(`Table ${tableName} is not ACTIVE (status: ${status})`);
    }
    logger.info(`Table ${tableName} verified (ACTIVE)`);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      throw new Error(
        `Module infrastructure table "${tableName}" not found. ` +
          'Run create-module-infrastructure.sh before executing integration tests.',
      );
    }
    throw error;
  }
}
