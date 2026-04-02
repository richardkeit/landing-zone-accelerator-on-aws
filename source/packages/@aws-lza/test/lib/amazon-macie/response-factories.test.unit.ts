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

import { FindingPublishingFrequency } from '@aws-sdk/client-macie2';
import { beforeEach, describe, expect, test } from 'vitest';
import { IMacieS3Destination, IMacieSessionResponse } from '../../../lib/amazon-macie/interfaces';
import { MacieSessionResponseHandler } from '../../../lib/amazon-macie/response-factories';

describe('MacieSessionResponseHandler', () => {
  let handler: MacieSessionResponseHandler;

  beforeEach(() => {
    handler = new MacieSessionResponseHandler();
  });

  describe('create', () => {
    test('should create session response successfully with minimal data', () => {
      const response = handler.create('enabled', 'us-east-1', {
        accountIds: ['XXXXXXXXXXXX', 'YYYYYYYYYYYY'],
      });

      expect(response).toEqual({
        operation: 'enabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX', 'YYYYYYYYYYYY'],
        publishSensitiveDataFindings: undefined,
        findingPublishingFrequency: undefined,
        s3Destination: undefined,
      });
    });

    test('should create session response with empty accountIds array', () => {
      const response = handler.create('disabled', 'us-west-2', {
        accountIds: [],
      });

      expect(response).toEqual({
        operation: 'disabled',
        regions: ['us-west-2'],
        accountIds: [],
        publishSensitiveDataFindings: undefined,
        findingPublishingFrequency: undefined,
        s3Destination: undefined,
      });
    });

    test('should create session response without accountIds data', () => {
      const response = handler.create('enabled', 'eu-west-1', {});

      expect(response).toEqual({
        operation: 'enabled',
        regions: ['eu-west-1'],
        accountIds: [],
        publishSensitiveDataFindings: undefined,
        findingPublishingFrequency: undefined,
        s3Destination: undefined,
      });
    });

    test('should create session response with Macie configuration for enabled operation', () => {
      const mockS3Destination: IMacieS3Destination = {
        bucketName: 'test-macie-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/test-key',
        keyPrefix: 'macie-findings',
      };

      const response = handler.create('enabled', 'us-east-1', {
        accountIds: ['XXXXXXXXXXXX'],
        publishSensitiveDataFindings: true,
        findingPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
        s3Destination: mockS3Destination,
      });

      expect(response).toEqual({
        operation: 'enabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX'],
        publishSensitiveDataFindings: true,
        findingPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
        s3Destination: mockS3Destination,
      });
    });

    test('should handle configuration with partial S3 destination', () => {
      const mockS3Destination: IMacieS3Destination = {
        bucketName: 'test-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/test-key',
        // keyPrefix is optional
      };

      const response = handler.create('enabled', 'ap-southeast-1', {
        accountIds: ['ZZZZZZZZZZZZ', 'AAAAAAAAAAAA'],
        publishSensitiveDataFindings: false,
        findingPublishingFrequency: FindingPublishingFrequency.SIX_HOURS,
        s3Destination: mockS3Destination,
      });

      expect(response.s3Destination).toEqual(mockS3Destination);
      expect(response.publishSensitiveDataFindings).toBe(false);
      expect(response.findingPublishingFrequency).toBe(FindingPublishingFrequency.SIX_HOURS);
    });
  });

  describe('getIdentifier', () => {
    test('should generate correct identifier for enabled operation', () => {
      const response: IMacieSessionResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX'],
      };

      const identifier = handler.getIdentifier(response);
      expect(identifier).toBe('enabled-session');
    });

    test('should generate correct identifier for disabled operation', () => {
      const response: IMacieSessionResponse = {
        operation: 'disabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX'],
      };

      const identifier = handler.getIdentifier(response);
      expect(identifier).toBe('disabled-session');
    });
  });

  describe('canMerge', () => {
    let response1: IMacieSessionResponse;
    let response2: IMacieSessionResponse;

    beforeEach(() => {
      response1 = {
        operation: 'enabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX'],
      };
      response2 = {
        operation: 'enabled',
        regions: ['us-west-2'],
        accountIds: ['YYYYYYYYYYYY'],
      };
    });

    test('should return true for compatible responses with same operation', () => {
      expect(handler.canMerge(response1, response2)).toBe(true);
    });

    test('should return false for different operations', () => {
      response2.operation = 'disabled';
      expect(handler.canMerge(response1, response2)).toBe(false);
    });

    test('should return true even with different regions and accounts', () => {
      response2.regions = ['eu-central-1', 'ap-northeast-1'];
      response2.accountIds = ['ZZZZZZZZZZZZ', 'AAAAAAAAAAAA', 'BBBBBBBBBBBB'];
      expect(handler.canMerge(response1, response2)).toBe(true);
    });
  });

  describe('merge', () => {
    let response1: IMacieSessionResponse;
    let response2: IMacieSessionResponse;

    beforeEach(() => {
      response1 = {
        operation: 'enabled',
        regions: ['us-east-1'],
        accountIds: ['XXXXXXXXXXXX'],
      };
      response2 = {
        operation: 'enabled',
        regions: ['us-west-2'],
        accountIds: ['YYYYYYYYYYYY'],
      };
    });

    test('should merge regions without duplicates', () => {
      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2']);
      expect(merged.operation).toBe('enabled');
    });

    test('should merge accountIds without duplicates', () => {
      const merged = handler.merge(response1, response2);

      expect(merged.accountIds).toEqual(['XXXXXXXXXXXX', 'YYYYYYYYYYYY']);
    });

    test('should handle duplicate regions', () => {
      response2.regions = ['us-east-1', 'us-west-2'];
      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2']);
    });

    test('should handle duplicate accountIds', () => {
      response2.accountIds = ['XXXXXXXXXXXX', 'YYYYYYYYYYYY'];
      const merged = handler.merge(response1, response2);

      expect(merged.accountIds).toEqual(['XXXXXXXXXXXX', 'YYYYYYYYYYYY']);
    });

    test('should preserve Macie-specific configuration from existing response', () => {
      const mockS3Destination: IMacieS3Destination = {
        bucketName: 'existing-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/existing-key',
        keyPrefix: 'existing-prefix',
      };

      response1.publishSensitiveDataFindings = true;
      response1.findingPublishingFrequency = FindingPublishingFrequency.ONE_HOUR;
      response1.s3Destination = mockS3Destination;

      const merged = handler.merge(response1, response2);

      expect(merged.publishSensitiveDataFindings).toBe(true);
      expect(merged.findingPublishingFrequency).toBe(FindingPublishingFrequency.ONE_HOUR);
      expect(merged.s3Destination).toEqual(mockS3Destination);
    });

    test('should use new response values when existing values are undefined', () => {
      const newS3Destination: IMacieS3Destination = {
        bucketName: 'new-bucket',
        kmsKeyArn: 'arn:aws:kms:us-west-2:XXXXXXXXXXXX:key/new-key',
        keyPrefix: 'new-prefix',
      };

      response2.publishSensitiveDataFindings = false;
      response2.findingPublishingFrequency = FindingPublishingFrequency.FIFTEEN_MINUTES;
      response2.s3Destination = newS3Destination;

      const merged = handler.merge(response1, response2);

      expect(merged.publishSensitiveDataFindings).toBe(false);
      expect(merged.findingPublishingFrequency).toBe(FindingPublishingFrequency.FIFTEEN_MINUTES);
      expect(merged.s3Destination).toEqual(newS3Destination);
    });

    test('should handle partial configuration updates', () => {
      response1.publishSensitiveDataFindings = true;
      response1.findingPublishingFrequency = FindingPublishingFrequency.ONE_HOUR;

      // Only update s3Destination in new response
      response2.s3Destination = {
        bucketName: 'updated-bucket',
        kmsKeyArn: 'arn:aws:kms:us-west-2:XXXXXXXXXXXX:key/updated-key',
      };

      const merged = handler.merge(response1, response2);

      expect(merged.publishSensitiveDataFindings).toBe(true);
      expect(merged.findingPublishingFrequency).toBe(FindingPublishingFrequency.ONE_HOUR);
      expect(merged.s3Destination).toEqual(response2.s3Destination);
    });

    test('should handle undefined configuration values', () => {
      // No configuration in either response
      const merged = handler.merge(response1, response2);

      expect(merged.publishSensitiveDataFindings).toBeUndefined();
      expect(merged.findingPublishingFrequency).toBeUndefined();
      expect(merged.s3Destination).toBeUndefined();
    });

    test('should preserve all other fields from existing response', () => {
      const merged = handler.merge(response1, response2);

      expect(merged.operation).toBe(response1.operation);
      // Regions and accountIds are merged, not just preserved
      expect(merged.regions).toContain('us-east-1');
      expect(merged.accountIds).toContain('XXXXXXXXXXXX');
    });

    test('should handle complex merge scenario', () => {
      response1.regions = ['us-east-1', 'eu-west-1'];
      response1.accountIds = ['XXXXXXXXXXXX', 'ZZZZZZZZZZZZ'];
      response1.publishSensitiveDataFindings = true;

      response2.regions = ['us-west-2', 'eu-west-1']; // eu-west-1 is duplicate
      response2.accountIds = ['YYYYYYYYYYYY', 'ZZZZZZZZZZZZ']; // ZZZZZZZZZZZZ is duplicate
      response2.findingPublishingFrequency = FindingPublishingFrequency.SIX_HOURS;
      response2.s3Destination = {
        bucketName: 'complex-bucket',
        kmsKeyArn: 'arn:aws:kms:us-west-2:XXXXXXXXXXXX:key/complex-key',
        keyPrefix: 'complex-prefix',
      };

      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'eu-west-1', 'us-west-2']);
      expect(merged.accountIds).toEqual(['XXXXXXXXXXXX', 'ZZZZZZZZZZZZ', 'YYYYYYYYYYYY']);
      expect(merged.publishSensitiveDataFindings).toBe(true);
      expect(merged.findingPublishingFrequency).toBe(FindingPublishingFrequency.SIX_HOURS);
      expect(merged.s3Destination).toEqual(response2.s3Destination);
    });
  });
});

describe('Integration tests', () => {
  test('should work together for complete workflow', () => {
    const handler = new MacieSessionResponseHandler();

    // Create first response
    const response1 = handler.create('enabled', 'us-east-1', {
      accountIds: ['XXXXXXXXXXXX'],
      publishSensitiveDataFindings: true,
      findingPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
      s3Destination: {
        bucketName: 'test-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/test-key',
        keyPrefix: 'test-prefix',
      },
    });

    // Create second response
    const response2 = handler.create('enabled', 'us-west-2', {
      accountIds: ['YYYYYYYYYYYY'],
    });

    // Verify they can be merged
    expect(handler.canMerge(response1, response2)).toBe(true);

    // Merge them
    const merged = handler.merge(response1, response2);

    expect(merged).toEqual({
      operation: 'enabled',
      regions: ['us-east-1', 'us-west-2'],
      accountIds: ['XXXXXXXXXXXX', 'YYYYYYYYYYYY'],
      publishSensitiveDataFindings: true,
      findingPublishingFrequency: FindingPublishingFrequency.ONE_HOUR,
      s3Destination: {
        bucketName: 'test-bucket',
        kmsKeyArn: 'arn:aws:kms:us-east-1:XXXXXXXXXXXX:key/test-key',
        keyPrefix: 'test-prefix',
      },
    });
  });

  test('should handle disabled operation workflow', () => {
    const handler = new MacieSessionResponseHandler();

    const response1 = handler.create('disabled', 'us-east-1', {
      accountIds: ['XXXXXXXXXXXX', 'ZZZZZZZZZZZZ'],
    });

    const response2 = handler.create('disabled', 'eu-central-1', {
      accountIds: ['YYYYYYYYYYYY'],
    });

    expect(handler.canMerge(response1, response2)).toBe(true);

    const merged = handler.merge(response1, response2);

    expect(merged).toEqual({
      operation: 'disabled',
      regions: ['us-east-1', 'eu-central-1'],
      accountIds: ['XXXXXXXXXXXX', 'ZZZZZZZZZZZZ', 'YYYYYYYYYYYY'],
      publishSensitiveDataFindings: undefined,
      findingPublishingFrequency: undefined,
      s3Destination: undefined,
    });
  });
});
