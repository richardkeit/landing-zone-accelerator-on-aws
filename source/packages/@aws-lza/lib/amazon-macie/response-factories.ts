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
 * @fileoverview Macie Response Handler - Service-specific response creation and merging
 *
 * Provides Macie-specific handler for creating and managing Macie session response objects.
 * The organization and delegated account handlers are provided by the common
 * security-service-response-builder module since they follow the standard AWS Organizations
 * delegated administration pattern.
 *
 * Key components:
 * - MacieSessionResponseHandler for Macie-specific session configuration
 * - Type-safe response creation with validation
 * - Backward compatibility with existing Macie interfaces
 *
 * @example
 * ```typescript
 * import { SecurityServiceResponseBuilder, OrganizationAdminResponseHandler } from '../common/security-service-response-builder';
 * import { MacieSessionResponseHandler } from './response-factories';
 *
 * const logger = createLogger(['macie']);
 * const sessionBuilder = new SecurityServiceResponseBuilder<IMacieSessionResponse>(logger);
 * const sessionHandler = new MacieSessionResponseHandler();
 *
 * sessionBuilder.addResponse('enabled', 'us-east-1', sessionHandler, {
 *   accountIds: ['123456789012'],
 *   publishSensitiveDataFindings: true,
 *   findingPublishingFrequency: 'FIFTEEN_MINUTES',
 *   s3Destination: { bucketName: 'macie-bucket', kmsKeyArn: 'arn:aws:kms:...' }
 * });
 * ```
 */

import { SecurityModuleOperationType } from '../common/types';
import { IMacieS3Destination, IMacieSessionResponse } from './interfaces';

/**
 * Combined factory and merge handler for Macie session responses.
 * Handles both creation and merging in a single class.
 * Only used by Macie service.
 */
export class MacieSessionResponseHandler {
  /**
   * Creates a new Macie session response from data
   */
  create(operation: SecurityModuleOperationType, region: string, data: Record<string, unknown>): IMacieSessionResponse {
    const accountIds = (data['accountIds'] as string[]) || [];

    return {
      operation,
      regions: [region],
      accountIds,
      // Macie-specific fields
      publishSensitiveDataFindings: data['publishSensitiveDataFindings'] as boolean | undefined,
      findingPublishingFrequency: data['findingPublishingFrequency'] as string | undefined,
      s3Destination: data['s3Destination'] as IMacieS3Destination | undefined,
    };
  }

  /**
   * Gets unique identifier for grouping responses
   */
  getIdentifier(response: IMacieSessionResponse): string {
    return `${response.operation}-session`;
  }

  /**
   * Checks if two responses can be merged
   */
  canMerge(existing: IMacieSessionResponse, newResponse: IMacieSessionResponse): boolean {
    return existing.operation === newResponse.operation;
  }

  /**
   * Merges two responses by combining regions and accounts
   */
  merge(existing: IMacieSessionResponse, newResponse: IMacieSessionResponse): IMacieSessionResponse {
    return {
      ...existing,
      regions: [...new Set([...existing.regions, ...newResponse.regions])],
      accountIds: [...new Set([...existing.accountIds, ...newResponse.accountIds])],
      // Preserve Macie-specific configuration from first response
      publishSensitiveDataFindings: existing.publishSensitiveDataFindings ?? newResponse.publishSensitiveDataFindings,
      findingPublishingFrequency: existing.findingPublishingFrequency ?? newResponse.findingPublishingFrequency,
      s3Destination: existing.s3Destination ?? newResponse.s3Destination,
    };
  }
}
