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
 * @fileoverview Transit Gateway Core Functions - Shared SDK operations
 *
 * Provides reusable functions for Transit Gateway module operations including
 * cross-account EC2 client creation and attachment name resolution.
 */

import { EC2Client } from '@aws-sdk/client-ec2';
import path from 'node:path';
import { createLogger } from '../common/logger';
import { setRetryStrategy } from '../common/utility';
import { getCredentials } from '../common/sts-functions';
import { IDesiredAttachment, ITgwModuleRequest } from './interfaces';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Creates an EC2 client, assuming a cross-account role if needed
 * @param props - TGW module request containing credentials and configuration
 * @param accountId - Target account ID
 * @param region - Target region
 * @param logPrefix - Prefix for logging messages
 * @returns EC2 client configured for the target account and region
 */
export async function getEc2Client(
  props: ITgwModuleRequest,
  accountId: string,
  region: string,
  logPrefix: string,
): Promise<EC2Client> {
  let credentials = props.credentials;
  if (accountId !== props.invokingAccountId || region !== props.region) {
    logger.info(`Assuming role in account ${accountId} region ${region}`, logPrefix);
    const assumed = await getCredentials({
      partition: props.partition,
      accountId,
      region,
      logPrefix,
      solutionId: props.solutionId,
      assumeRoleName: props.configuration.accountAccessRoleName,
      credentials: props.credentials,
    });
    if (assumed) {
      credentials = assumed;
    }
  }
  return new EC2Client({
    region,
    customUserAgent: props.solutionId,
    retryStrategy: setRetryStrategy(),
    credentials,
  });
}

/**
 * Finds the human-readable attachment name for a given attachment ID
 * @param attachmentId - The attachment ID to look up
 * @param desired - Array of desired attachments to search
 * @returns The attachment name, or the attachment ID if not found
 */
export function findAttachmentName(attachmentId: string, desired: IDesiredAttachment[]): string {
  const match = desired.find(d => d.attachmentId === attachmentId);
  return match?.attachmentName ?? attachmentId;
}
