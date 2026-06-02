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

import { ResourceAlreadyExistsException } from '@aws-sdk/client-cloudwatch-logs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LoggerUtil } from '../../../lib/common/logger-util';

// Mock Dependencies
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn(),
  CreateLogStreamCommand: vi.fn(),
  PutLogEventsCommand: vi.fn(),
  ResourceAlreadyExistsException: vi.fn(),
}));

vi.mock('../../../lib/common/throttle', () => ({
  throttlingBackOff: vi.fn(),
}));

vi.mock('../../../lib/common/utility', () => ({
  setRetryStrategy: vi.fn(function () {
    return {};
  }),
}));

const MOCK_CONSTANTS = {
  logGroupName: '/aws/lza/verbose-logs',
  logStreamName: 'pipeline/XXXXXXXXXXXX/2024-03-05T10-30-00-000Z',
  region: 'us-east-1',
  solutionId: 'AwsSolution/SO0199/1.0.0',
};

describe('LoggerUtil', () => {
  let mockThrottlingBackOff: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const throttle = await import('../../../lib/common/throttle.js');
    mockThrottlingBackOff = vi.mocked(throttle.throttlingBackOff);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('createLoggerStream', () => {
    test('should create log stream successfully', async () => {
      mockThrottlingBackOff.mockResolvedValue(undefined);

      await LoggerUtil.createLoggerStream({
        logGroupName: MOCK_CONSTANTS.logGroupName,
        logStreamName: MOCK_CONSTANTS.logStreamName,
        region: MOCK_CONSTANTS.region,
      });

      expect(mockThrottlingBackOff).toHaveBeenCalledTimes(1);
    });

    test('should pass solutionId as customUserAgent when provided', async () => {
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      mockThrottlingBackOff.mockResolvedValue(undefined);

      await LoggerUtil.createLoggerStream({
        logGroupName: MOCK_CONSTANTS.logGroupName,
        logStreamName: MOCK_CONSTANTS.logStreamName,
        region: MOCK_CONSTANTS.region,
        solutionId: MOCK_CONSTANTS.solutionId,
      });

      expect(CloudWatchLogsClient).toHaveBeenCalledWith(
        expect.objectContaining({
          region: MOCK_CONSTANTS.region,
          customUserAgent: MOCK_CONSTANTS.solutionId,
        }),
      );
    });

    test('should handle ResourceAlreadyExistsException gracefully', async () => {
      const error = new Error('Stream already exists');
      Object.setPrototypeOf(error, ResourceAlreadyExistsException.prototype);

      mockThrottlingBackOff.mockImplementation(async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch {
          // swallow
        }
        throw error;
      });

      await expect(
        LoggerUtil.createLoggerStream({
          logGroupName: MOCK_CONSTANTS.logGroupName,
          logStreamName: MOCK_CONSTANTS.logStreamName,
          region: MOCK_CONSTANTS.region,
        }),
      ).resolves.toBeUndefined();

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    test('should log error and rethrow for non-ResourceAlreadyExistsException errors', async () => {
      const error = new Error('Access denied');

      mockThrottlingBackOff.mockRejectedValue(error);

      await expect(
        LoggerUtil.createLoggerStream({
          logGroupName: MOCK_CONSTANTS.logGroupName,
          logStreamName: MOCK_CONSTANTS.logStreamName,
          region: MOCK_CONSTANTS.region,
        }),
      ).rejects.toThrow('Access denied');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[LoggerUtil] Failed to create log stream ${MOCK_CONSTANTS.logStreamName}:`,
        error,
      );
    });
  });

  describe('publishLoggerEvents', () => {
    test('should return early when logEvents array is empty', async () => {
      await LoggerUtil.publishLoggerEvents({
        logGroupName: MOCK_CONSTANTS.logGroupName,
        logStreamName: MOCK_CONSTANTS.logStreamName,
        logEvents: [],
        region: MOCK_CONSTANTS.region,
      });

      expect(mockThrottlingBackOff).not.toHaveBeenCalled();
    });

    test('should publish log events successfully', async () => {
      mockThrottlingBackOff.mockResolvedValue(undefined);

      const logEvents = [
        { message: 'test log 1', timestamp: Date.now() },
        { message: 'test log 2', timestamp: Date.now() },
      ];

      await LoggerUtil.publishLoggerEvents({
        logGroupName: MOCK_CONSTANTS.logGroupName,
        logStreamName: MOCK_CONSTANTS.logStreamName,
        logEvents,
        region: MOCK_CONSTANTS.region,
      });

      expect(mockThrottlingBackOff).toHaveBeenCalledTimes(1);
    });

    test('should pass solutionId as customUserAgent when provided', async () => {
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      mockThrottlingBackOff.mockResolvedValue(undefined);

      await LoggerUtil.publishLoggerEvents({
        logGroupName: MOCK_CONSTANTS.logGroupName,
        logStreamName: MOCK_CONSTANTS.logStreamName,
        logEvents: [{ message: 'test', timestamp: Date.now() }],
        region: MOCK_CONSTANTS.region,
        solutionId: MOCK_CONSTANTS.solutionId,
      });

      expect(CloudWatchLogsClient).toHaveBeenCalledWith(
        expect.objectContaining({
          region: MOCK_CONSTANTS.region,
          customUserAgent: MOCK_CONSTANTS.solutionId,
        }),
      );
    });

    test('should throw error when batch exceeds 10,000 events', async () => {
      const logEvents = Array.from({ length: 10001 }, (_, i) => ({
        message: `log event ${i}`,
        timestamp: Date.now(),
      }));

      await expect(
        LoggerUtil.publishLoggerEvents({
          logGroupName: MOCK_CONSTANTS.logGroupName,
          logStreamName: MOCK_CONSTANTS.logStreamName,
          logEvents,
          region: MOCK_CONSTANTS.region,
        }),
      ).rejects.toThrow('Cannot publish more than 10,000 log events in a single batch. Received 10001 events.');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[LoggerUtil] Cannot publish more than 10,000 log events in a single batch. Received 10001 events.',
      );
      expect(mockThrottlingBackOff).not.toHaveBeenCalled();
    });

    test('should log error and rethrow when PutLogEvents fails', async () => {
      const error = new Error('Service unavailable');
      mockThrottlingBackOff.mockRejectedValue(error);

      const logEvents = [{ message: 'test log', timestamp: Date.now() }];

      await expect(
        LoggerUtil.publishLoggerEvents({
          logGroupName: MOCK_CONSTANTS.logGroupName,
          logStreamName: MOCK_CONSTANTS.logStreamName,
          logEvents,
          region: MOCK_CONSTANTS.region,
        }),
      ).rejects.toThrow('Service unavailable');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[LoggerUtil] Failed to publish 1 log events to ${MOCK_CONSTANTS.logStreamName}:`,
        error,
      );
    });
  });
});
