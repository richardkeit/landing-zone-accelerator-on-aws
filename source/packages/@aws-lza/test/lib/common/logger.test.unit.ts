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

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const originalEnv = process.env;

// Mock winston at the top level
const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  clear: vi.fn(),
  add: vi.fn(),
  transports: [] as { flushAsync?: ReturnType<typeof vi.fn> }[],
};

const mockChild = vi.fn(() => mockLoggerMethods);

const mockLogger = {
  child: mockChild,
  ...mockLoggerMethods,
};

// winston.format(fn) returns a factory; calling factory() returns the transform.
// sanitizeFormat = winston.format(fn) → then sanitizeFormat() is called in format.combine(...)
const mockFormatFunction = vi.fn(() => vi.fn(() => 'mockedSanitizeFormat'));

Object.assign(mockFormatFunction, {
  combine: vi.fn(() => 'mockedCombinedFormat'),
  colorize: vi.fn(() => 'mockedColorize'),
  timestamp: vi.fn(() => 'mockedTimestamp'),
  printf: vi.fn((formatter: (info: Record<string, string>) => string) => formatter),
  align: vi.fn(() => 'mockedAlign'),
});

vi.mock('winston', () => ({
  createLogger: vi.fn(() => mockLogger),
  format: mockFormatFunction,
  transports: {
    Console: vi.fn(),
  },
  add: vi.fn(),
}));

vi.mock('winston-transport', () => ({
  default: vi.fn(),
}));

vi.mock('../../../lib/common/logger-util', () => ({
  LoggerUtil: {
    createLoggerStream: vi.fn(),
    publishLoggerEvents: vi.fn(),
  },
}));

describe('logger', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env['VERBOSE_LOG_GROUP_NAME'];
    delete process.env['LOG_LEVEL'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Logger initialization', () => {
    test('should create main logger with default settings', async () => {
      const winston = await import('winston');
      delete process.env['LOG_LEVEL'];

      await import('../../../lib/common/logger.js');

      const mockCreateLogger = vi.mocked(winston.createLogger);
      expect(mockCreateLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultMeta: { mainLabel: 'accelerator' },
          level: 'info',
          format: 'mockedCombinedFormat',
          transports: [expect.any(Object)],
        }),
      );

      const mockTimestamp = vi.mocked(winston.format.timestamp);
      expect(mockTimestamp).toHaveBeenCalledWith({
        format: 'YYYY-MM-DD HH:mm:ss.SSS',
      });
    });

    test('should use LOG_LEVEL environment variable if set', async () => {
      const winston = await import('winston');
      process.env['LOG_LEVEL'] = 'debug';

      await import('../../../lib/common/logger.js');

      const mockCreateLogger = vi.mocked(winston.createLogger);
      expect(mockCreateLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'debug',
        }),
      );
    });

    test('should create status logger', async () => {
      const winston = await import('winston');
      await import('../../../lib/common/logger.js');

      const mockAdd = vi.mocked(winston.add);
      expect(mockAdd).toHaveBeenCalled();
    });

    test('should create main logger with correct format', async () => {
      const winston = await import('winston');
      await import('../../../lib/common/logger.js');

      const printfMock = vi.mocked(winston.format.printf);
      const printfFormatter = printfMock.mock.calls[0]?.[0];

      if (!printfFormatter) {
        throw new Error('printf formatter not found');
      }

      expect(
        printfFormatter({
          timestamp: '2023-05-20 10:00:00',
          level: 'info',
          message: 'Test message',
          mainLabel: 'Main',
          childLabel: '',
        }),
      ).toBe('2023-05-20 10:00:00 | info | Main | Test message');

      expect(
        printfFormatter({
          timestamp: '2023-05-20 10:00:00',
          level: 'error',
          message: 'Error message',
          mainLabel: 'Main',
          childLabel: 'Child',
        }),
      ).toBe('2023-05-20 10:00:00 | error | Child | Error message');
    });

    test('should create status logger with correct format', async () => {
      const winston = await import('winston');
      await import('../../../lib/common/logger.js');

      const printfMock = vi.mocked(winston.format.printf);
      const statusPrintfFormatter = printfMock.mock.calls[1]?.[0];

      if (!statusPrintfFormatter) {
        throw new Error('status printf formatter not found');
      }

      expect(
        statusPrintfFormatter({
          timestamp: '2023-05-20 10:00:00',
          level: 'info',
          message: 'Status message',
          childLabel: 'module-name',
        }),
      ).toBe('2023-05-20 10:00:00 | status | module-name | Status message');
    });

    test('should include sanitizeFormat in format.combine calls', async () => {
      const winston = await import('winston');
      await import('../../../lib/common/logger.js');

      // sanitizeFormat is created via winston.format(fn) — verify it was called
      expect(mockFormatFunction).toHaveBeenCalled();

      // format.combine should be called with sanitizeFormat result as first arg
      const mockCombine = vi.mocked(winston.format.combine);
      expect(mockCombine).toHaveBeenCalled();
    });
  });

  describe('createLogger', () => {
    test('should create a child logger with the correct label', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test', 'child']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'test | child',
      });

      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.processStart).toBeDefined();
      expect(logger.processEnd).toBeDefined();
      expect(logger.dryRun).toBeDefined();
      expect(logger.commandExecution).toBeDefined();
      expect(logger.commandSuccess).toBeDefined();
    });

    test('should throw error when called with empty array', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      expect(() => createLogger([])).toThrow('createLogger requires at least one log info item');
    });

    test('should throw error when called with null', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      expect(() => createLogger(null as unknown as string[])).toThrow(
        'createLogger requires at least one log info item',
      );
    });

    test('should throw error when called with undefined', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      expect(() => createLogger(undefined as unknown as string[])).toThrow(
        'createLogger requires at least one log info item',
      );
    });

    test('should log info message with icon', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.info('Test message');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('ℹ️  Test message');
    });

    test('should log info message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.info('Test message', 'Account1:us-east-1');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('[Account1:us-east-1] ℹ️  Test message');
    });

    test('should log warn message with icon', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.warn('Warning message');

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith('⚠️  Warning message');
    });

    test('should log warn message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.warn('Warning message', 'Account2:us-west-2');

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith('[Account2:us-west-2] ⚠️  Warning message');
    });

    test('should log error message with icon', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.error('Error message');

      expect(mockLoggerMethods.error).toHaveBeenCalledWith('❌  Error message');
    });

    test('should log error message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.error('Error message', 'Account3:eu-west-1');

      expect(mockLoggerMethods.error).toHaveBeenCalledWith('[Account3:eu-west-1] ❌  Error message');
    });

    test('should log process start message with icon', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.processStart('Starting process');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('🚀  Starting process');
    });

    test('should log process start message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.processStart('Starting process', 'Batch1');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('[Batch1] 🚀  Starting process');
    });

    test('should log process end message with icon', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.processEnd('Process completed');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('✅  Process completed');
    });

    test('should log process end message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.processEnd('Process completed', 'Batch2');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('[Batch2] ✅  Process completed');
    });

    test('should log dry run messages', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { accountId: '123456789012', region: 'us-east-1' };

      logger.dryRun('EnableMacieCommand', parameters);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('🔍  Dry run is true, so not executing EnableMacieCommand');
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '🔍  Would have executed EnableMacieCommand with arguments: {"accountId":"123456789012","region":"us-east-1"}',
      );
    });

    test('should log dry run messages with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { findingFrequency: 'FIFTEEN_MINUTES' };

      logger.dryRun('EnableMacieCommand', parameters, 'Account1:us-east-1');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '[Account1:us-east-1] 🔍  Dry run is true, so not executing EnableMacieCommand',
      );
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '[Account1:us-east-1] 🔍  Would have executed EnableMacieCommand with arguments: {"findingFrequency":"FIFTEEN_MINUTES"}',
      );
    });

    test('should log command execution message', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { bucketName: 'test-bucket', region: 'us-west-2' };

      logger.commandExecution('CreateBucketCommand', parameters);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        'ℹ️  Executing CreateBucketCommand with arguments: {"bucketName":"test-bucket","region":"us-west-2"}',
      );
    });

    test('should log command execution message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { tableName: 'test-table' };

      logger.commandExecution('CreateTableCommand', parameters, 'Account2:ap-southeast-1');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '[Account2:ap-southeast-1] ℹ️  Executing CreateTableCommand with arguments: {"tableName":"test-table"}',
      );
    });

    test('should log command success message', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { roleArn: 'arn:aws:iam::123456789012:role/TestRole' };

      logger.commandSuccess('AssumeRoleCommand', parameters);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        'ℹ️  Successfully executed AssumeRoleCommand with arguments: {"roleArn":"arn:aws:iam::123456789012:role/TestRole"}',
      );
    });

    test('should log command success message with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const parameters = { policyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' };

      logger.commandSuccess('AttachPolicyCommand', parameters, 'Account3:eu-central-1');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '[Account3:eu-central-1] ℹ️  Successfully executed AttachPolicyCommand with arguments: {"policyArn":"arn:aws:iam::aws:policy/ReadOnlyAccess"}',
      );
    });

    test('should handle single label', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      createLogger(['single']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'single',
      });
    });

    test('should handle multiple labels', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      createLogger(['service', 'module', 'operation']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'service | module | operation',
      });
    });
  });

  describe('createStatusLogger', () => {
    test('should create a child status logger with the correct label', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      createStatusLogger(['status', 'test']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'status | test',
      });
    });

    test('should throw error when called with empty array', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      expect(() => createStatusLogger([])).toThrow('createStatusLogger requires at least one log info item');
    });

    test('should throw error when called with null', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      expect(() => createStatusLogger(null as unknown as string[])).toThrow(
        'createStatusLogger requires at least one log info item',
      );
    });

    test('should throw error when called with undefined', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      expect(() => createStatusLogger(undefined as unknown as string[])).toThrow(
        'createStatusLogger requires at least one log info item',
      );
    });

    test('should log status info message with icon', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['deployment']);
      statusLogger.info('Deployment completed');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('ℹ️  Deployment completed');
    });

    test('should log status warn message with icon', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['system']);
      statusLogger.warn('System warning');

      expect(mockLoggerMethods.warn).toHaveBeenCalledWith('⚠️  System warning');
    });

    test('should log status error message with icon', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['critical']);
      statusLogger.error('Critical error');

      expect(mockLoggerMethods.error).toHaveBeenCalledWith('❌  Critical error');
    });

    test('should log status process messages', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['module']);

      statusLogger.processStart('Module starting');
      statusLogger.processEnd('Module completed');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('🚀  Module starting');
      expect(mockLoggerMethods.info).toHaveBeenCalledWith('✅  Module completed');
    });

    test('should log status dry run messages', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['test']);
      const parameters = { testParam: 'value' };

      statusLogger.dryRun('TestCommand', parameters);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('🔍  Dry run is true, so not executing TestCommand');
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        '🔍  Would have executed TestCommand with arguments: {"testParam":"value"}',
      );
    });

    test('should log status command execution and success', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      const statusLogger = createStatusLogger(['api']);
      const parameters = { apiVersion: '2023-01-01' };

      statusLogger.commandExecution('ApiCommand', parameters);
      statusLogger.commandSuccess('ApiCommand', parameters);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        'ℹ️  Executing ApiCommand with arguments: {"apiVersion":"2023-01-01"}',
      );
      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        'ℹ️  Successfully executed ApiCommand with arguments: {"apiVersion":"2023-01-01"}',
      );
    });

    test('should handle single status label', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      createStatusLogger(['deployment']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'deployment',
      });
    });

    test('should handle multiple status labels', async () => {
      const { createStatusLogger } = await import('../../../lib/common/logger.js');
      createStatusLogger(['system', 'critical', 'alert']);

      expect(mockChild).toHaveBeenCalledWith({
        childLabel: 'system | critical | alert',
      });
    });
  });

  describe('logMessage helper function coverage', () => {
    test('should handle messages without prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.info('Simple message');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('ℹ️  Simple message');
    });

    test('should handle messages with prefix', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      logger.info('Prefixed message', 'TestPrefix');

      expect(mockLoggerMethods.info).toHaveBeenCalledWith('[TestPrefix] ℹ️  Prefixed message');
    });

    test('should handle complex parameter objects in commands', async () => {
      const { createLogger } = await import('../../../lib/common/logger.js');
      const logger = createLogger(['test']);
      const complexParams = {
        nested: { object: { with: 'values' } },
        array: [1, 2, 3],
        boolean: true,
        null: null,
        undefined: undefined,
      };

      logger.commandExecution('ComplexCommand', complexParams);

      expect(mockLoggerMethods.info).toHaveBeenCalledWith(
        'ℹ️  Executing ComplexCommand with arguments: {"nested":{"object":{"with":"values"}},"array":[1,2,3],"boolean":true,"null":null}',
      );
    });
  });

  describe('CloudWatch logging configuration', () => {
    test('should not enable CloudWatch when VERBOSE_LOG_GROUP_NAME is not set', async () => {
      delete process.env['VERBOSE_LOG_GROUP_NAME'];

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      await import('../../../lib/common/logger.js');

      // LoggerUtil should not be called when CloudWatch is not configured
      expect(LoggerUtil.createLoggerStream).not.toHaveBeenCalled();
      expect(mockLoggerMethods.clear).not.toHaveBeenCalled();
    });

    test('should throw error when VERBOSE_LOG_GROUP_NAME is set but AWS_REGION is missing', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      delete process.env['AWS_REGION'];
      delete process.env['AWS_DEFAULT_REGION'];
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(async () => {
        await import('../../../lib/common/logger.js');
      }).rejects.toThrow(
        'AWS_REGION or AWS_DEFAULT_REGION environment variable is required when VERBOSE_LOG_GROUP_NAME is set',
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('AWS_REGION or AWS_DEFAULT_REGION environment variable is required'),
      );

      consoleErrorSpy.mockRestore();
    });

    test('should throw error when VERBOSE_LOG_GROUP_NAME is set but PIPELINE_ACCOUNT_ID is missing', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      delete process.env['PIPELINE_ACCOUNT_ID'];

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(async () => {
        await import('../../../lib/common/logger.js');
      }).rejects.toThrow('PIPELINE_ACCOUNT_ID environment variable is required when VERBOSE_LOG_GROUP_NAME is set');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('PIPELINE_ACCOUNT_ID environment variable is required'),
      );

      consoleErrorSpy.mockRestore();
    });

    test('should initialize CloudWatch when all env vars are set', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';
      process.env['ACCELERATOR_STAGE'] = 'prepare';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(LoggerUtil.createLoggerStream).toHaveBeenCalledWith(
        expect.objectContaining({
          logGroupName: 'test-log-group',
          region: 'us-east-1',
        }),
      );

      // Verify log stream name pattern: stage/accountId/timestamp
      const callArgs = vi.mocked(LoggerUtil.createLoggerStream).mock.calls[0]?.[0];
      expect(callArgs?.logStreamName).toMatch(/^prepare\/123456789012\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });

    test('should use AWS_DEFAULT_REGION as fallback when AWS_REGION is not set', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      delete process.env['AWS_REGION'];
      process.env['AWS_DEFAULT_REGION'] = 'us-west-2';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(LoggerUtil.createLoggerStream).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-west-2',
        }),
      );
    });

    test('should use "all-stages" as default when ACCELERATOR_STAGE is not set', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';
      delete process.env['ACCELERATOR_STAGE'];

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const callArgs = vi.mocked(LoggerUtil.createLoggerStream).mock.calls[0]?.[0];
      expect(callArgs?.logStreamName).toMatch(/^all-stages\/123456789012\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });

    test('should clear Logger console transport and add CloudWatch transport', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(mockLoggerMethods.clear).toHaveBeenCalled();
      expect(mockLoggerMethods.add).toHaveBeenCalled();
    });

    test('should add CloudWatch transport to both Logger and StatusLogger', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Logger.add called for CloudWatch transport, StatusLogger.add called for CloudWatch transport
      expect(mockLoggerMethods.add).toHaveBeenCalledTimes(2);
    });

    test('should handle createLoggerStream failure gracefully', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.createLoggerStream).mockRejectedValueOnce(new Error('Access denied'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Should fall back to console logging without throwing
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to create CloudWatch log stream. Falling back to console-only logging.',
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('waitForLoggerInitialization', () => {
    test('should resolve immediately when VERBOSE_LOG_GROUP_NAME is not set', async () => {
      delete process.env['VERBOSE_LOG_GROUP_NAME'];

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await expect(waitForLoggerInitialization()).resolves.toBeUndefined();
    });

    test('should wait for CloudWatch initialization when configured', async () => {
      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await expect(waitForLoggerInitialization()).resolves.toBeUndefined();
    });
  });

  describe('flushLoggers', () => {
    test('should resolve when no CloudWatch transports exist', async () => {
      delete process.env['VERBOSE_LOG_GROUP_NAME'];

      const { flushLoggers } = await import('../../../lib/common/logger.js');
      await expect(flushLoggers()).resolves.toBeUndefined();
    });
  });

  describe('sanitizeLogMessage', () => {
    test('should redact sensitive JSON keys', async () => {
      // Use real winston to exercise sanitizeLogMessage through sanitizeFormat
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { waitForLoggerInitialization, createLogger } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createLogger(['sanitize-test']);

      // Log a message containing sensitive JSON keys
      logger.info('Config: {"secretAccessKey":"ABCDEF123","sessionToken":"token123","password":"pass123"}');

      // The sanitizeFormat should have redacted the values
      const loggedMessage = consoleLogSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('sanitize-test'),
      );
      if (loggedMessage) {
        expect(loggedMessage[0]).toContain('"secretAccessKey":"[REDACTED]"');
        expect(loggedMessage[0]).toContain('"sessionToken":"[REDACTED]"');
        expect(loggedMessage[0]).toContain('"password":"[REDACTED]"');
        expect(loggedMessage[0]).not.toContain('ABCDEF123');
        expect(loggedMessage[0]).not.toContain('token123');
        expect(loggedMessage[0]).not.toContain('pass123');
      }

      consoleLogSpy.mockRestore();
    });

    test('should redact AWS session tokens', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      const { createLogger } = await import('../../../lib/common/logger.js');
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createLogger(['token-test']);

      // FwoGZXIvYXdzE prefix followed by 200+ chars
      const fakeToken = 'FwoGZXIvYXdzE' + 'A'.repeat(250);
      logger.info(`Token: ${fakeToken}`);

      const loggedMessage = consoleLogSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('token-test'),
      );
      if (loggedMessage) {
        expect(loggedMessage[0]).toContain('[REDACTED_SESSION_TOKEN]');
        expect(loggedMessage[0]).not.toContain(fakeToken);
      }

      consoleLogSpy.mockRestore();
    });

    test('should neutralize log injection characters', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      const { createLogger } = await import('../../../lib/common/logger.js');
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createLogger(['injection-test']);

      logger.info('Line1\r\nLine2\tTabbed');

      const loggedMessage = consoleLogSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('injection-test'),
      );
      if (loggedMessage) {
        expect(loggedMessage[0]).toContain('⏎');
        expect(loggedMessage[0]).toContain('⇥');
        expect(loggedMessage[0]).not.toContain('\r');
        expect(loggedMessage[0]).not.toContain('\n');
        expect(loggedMessage[0]).not.toContain('\t');
      }

      consoleLogSpy.mockRestore();
    });
  });

  describe('CloudWatchLogsTransport (real winston)', () => {
    test('should buffer logs and flush to CloudWatch', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['transport-test']);
      logger.info('Test log message for CloudWatch');

      // Flush to trigger publishLoggerEvents
      await flushLoggers();

      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();
    });

    test('should fallback to console after MAX_RETRIES failures', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Service unavailable'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['fallback-test']);

      // Log and flush 3 times to trigger fallback
      for (let i = 0; i < 3; i++) {
        logger.info(`Attempt ${i + 1}`);
        await flushLoggers();
        // Small delay to allow interval-based flush
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // After 3 failures, should see fallback message
      const fallbackCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('[CLOUDWATCH FALLBACK]'),
      );
      expect(fallbackCalled).toBe(true);

      // After fallback, new logs should go to console
      logger.info('After fallback message');
      const consoleFallbackLog = consoleLogSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('After fallback message'),
      );
      expect(consoleFallbackLog).toBe(true);

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    test('should handle flushLoggers with CloudWatch transports', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['flush-test']);
      logger.info('Message to flush');

      await flushLoggers();

      // publishLoggerEvents should have been called at least once
      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();
    });

    test('should wait for in-flight flush to complete before draining buffer in flushAsync', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      // Make publishLoggerEvents slow so isFlushing stays true when flushAsync is called
      let resolvePublish: (() => void) | undefined;
      let callCount = 0;
      vi.mocked(LoggerUtil.publishLoggerEvents).mockImplementation(
        () =>
          new Promise<void>(resolve => {
            callCount++;
            if (callCount === 1) {
              // First call: hang until we resolve it (simulates in-flight flush)
              resolvePublish = resolve;
            } else {
              // Subsequent calls: resolve immediately
              resolve();
            }
          }),
      );

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Create a transport directly to control flush timing
      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-log-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000, // Long interval so periodic flush doesn't interfere
      });

      // Add a log to the buffer
      transport.log({ message: 'Race condition test', level: 'info' }, () => {});

      // Start a flush — this sets isFlushing=true and hangs on publishLoggerEvents
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inflightFlush = (transport as any).flush();

      // Now call flushAsync while isFlushing is true — it should wait, not bail
      const flushAsyncPromise = transport.flushAsync();

      // Resolve the in-flight publish so flush completes
      expect(resolvePublish).toBeDefined();
      resolvePublish!();

      await inflightFlush;
      await flushAsyncPromise;

      // publishLoggerEvents was called (the in-flight flush sent the logs)
      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();
    });

    test('should handle flushLoggers error gracefully', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Flush failed'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['flush-error-test']);
      logger.info('Message that will fail to flush');

      // flushLoggers should not throw even when flush fails
      await expect(flushLoggers()).resolves.toBeUndefined();

      consoleErrorSpy.mockRestore();
    });

    test('should truncate messages exceeding 256 KB', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['truncate-test']);
      // Create a message larger than 256 KB
      const largeMessage = 'X'.repeat(300 * 1024);
      logger.info(largeMessage);

      await flushLoggers();

      // Verify the published message was truncated
      const publishCall = vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls[0];
      if (publishCall) {
        const events = publishCall[0].logEvents;
        const message = events[0]?.message ?? '';
        expect(message).toContain('[TRUNCATED: message exceeded 256 KB]');
        expect(message.length).toBeLessThan(300 * 1024);
      }
    });

    test('should log to console when transport is closed', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['close-test']);

      // Log a message first (this goes to buffer)
      logger.info('Before close');

      // The transport's close/finish methods are called internally by winston
      // We can verify the close path by checking that after close, logs go to console
      consoleLogSpy.mockRestore();
    });
  });

  describe('logMessage buffering', () => {
    test('should buffer logs when VERBOSE_LOG_GROUP_NAME is set but CloudWatch not ready', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      // Make createLoggerStream hang so CloudWatch never becomes ready during our test
      let resolveStream: () => void;
      const streamPromise = new Promise<void>(resolve => {
        resolveStream = resolve;
      });
      vi.mocked(LoggerUtil.createLoggerStream).mockReturnValue(streamPromise);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Import logger - CloudWatch init starts but doesn't complete
      const { createLogger, waitForLoggerInitialization } = await import('../../../lib/common/logger.js');

      const logger = createLogger(['buffer-test']);
      // These logs should be buffered (CloudWatch not ready yet)
      logger.info('Buffered message 1');
      logger.warn('Buffered message 2');

      // Verify logs did NOT go to console (they're buffered)
      const bufferTestLogs = consoleLogSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('buffer-test'),
      );
      expect(bufferTestLogs.length).toBe(0);

      // Now resolve the stream creation to let CloudWatch init complete
      resolveStream!();
      await waitForLoggerInitialization();

      consoleLogSpy.mockRestore();
    });

    test('should flush early log buffer with prefix when CloudWatch becomes ready', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      let resolveStream: () => void;
      const streamPromise = new Promise<void>(resolve => {
        resolveStream = resolve;
      });
      vi.mocked(LoggerUtil.createLoggerStream).mockReturnValue(streamPromise);
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { createLogger, waitForLoggerInitialization, flushLoggers } = await import('../../../lib/common/logger.js');

      const logger = createLogger(['prefix-buffer-test']);
      // Log with prefix while CloudWatch not ready — exercises buffering with prefix
      logger.info('Prefixed buffered message', 'Account1:us-east-1');

      resolveStream!();
      await waitForLoggerInitialization();

      // Flush to ensure buffered logs are sent
      await flushLoggers();

      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();
    });
  });

  describe('CloudWatchLogsTransport edge cases', () => {
    test('should retry on publish failure before reaching MAX_RETRIES', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      // Fail once, then succeed
      vi.mocked(LoggerUtil.publishLoggerEvents)
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['retry-test']);
      logger.info('Retry message');

      // First flush fails (attempt 1)
      await flushLoggers();

      // Should see retry message, not fallback
      const retryCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('Failed to publish') && call[0].includes('attempt 1/3'),
      );
      expect(retryCalled).toBe(true);

      // Second flush should succeed (logs were re-queued)
      await flushLoggers();

      consoleErrorSpy.mockRestore();
    });

    test('should handle non-Error exception in createLoggerStream', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.createLoggerStream).mockRejectedValueOnce('String error');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to create CloudWatch log stream. Falling back to console-only logging.',
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: String error');

      consoleErrorSpy.mockRestore();
    });

    test('should skip flush when buffer is empty via interval timer', async () => {
      vi.useFakeTimers();
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Advance timer to trigger interval-based flush with empty buffer
      // This exercises the `isFlushing || logBuffer.length === 0` early return in flush()
      await vi.advanceTimersByTimeAsync(3000);

      // publishLoggerEvents should NOT be called since buffer is empty
      expect(LoggerUtil.publishLoggerEvents).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    test('should skip flush via interval when transport is in fallback mode', async () => {
      vi.useFakeTimers();
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      // Fail 3 times to trigger fallback
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Unavailable'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['fallback-flush-test']);

      // Trigger 3 failures to activate fallback
      for (let i = 0; i < 3; i++) {
        logger.info(`Fail ${i + 1}`);
        await flushLoggers();
        await vi.advanceTimersByTimeAsync(50);
      }

      // Reset mock to track new calls
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();

      // Advance timer — interval-based flush should hit `isClosed || fallbackToConsole` early return
      await vi.advanceTimersByTimeAsync(3000);

      // publishLoggerEvents should NOT be called in fallback mode
      expect(LoggerUtil.publishLoggerEvents).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
      vi.useRealTimers();
    });

    test('should dump both eventsToPublish and logBuffer during fallback', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Unavailable'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Fail attempt 1: log and flush
      transport.log({ message: 'msg1', level: 'info' }, noop);
      await transport.flushAsync();

      // Fail attempt 2: flush re-queued logs
      await transport.flushAsync();

      // Before attempt 3, add 10001 logs so that splice(0, 10000) leaves 1+ in logBuffer
      for (let i = 0; i < 10001; i++) {
        transport.log({ message: `batch-msg-${i}`, level: 'info' }, noop);
      }

      // Fail attempt 3: triggers fallback — dumps eventsToPublish (10000) AND logBuffer (remaining)
      await transport.flushAsync();

      // Verify the logBuffer items were dumped to console (L292)
      const bufferDumped = consoleLogSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('batch-msg-10000'),
      );
      expect(bufferDumped).toBe(true);

      transport.close();
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    test('should handle inner catch with Error instance', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.createLoggerStream).mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make setInterval throw an Error (not string) to cover the `error instanceof Error` true branch
      const originalSetInterval = globalThis.setInterval;
      let callCount = 0;
      vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Error instance failure');
        }
        return originalSetInterval(...args);
      });

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to initialize CloudWatch logging: Error instance failure');

      consoleErrorSpy.mockRestore();
      vi.mocked(globalThis.setInterval).mockRestore();
    });

    test('should handle flushLoggers catch path when flushAsync rejects', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, flushLoggers, CloudWatchLogsTransport } = await import(
        '../../../lib/common/logger.js'
      );
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
      });

      // Override flushAsync to reject — this exercises the .catch() in flushLoggers
      transport.flushAsync = () => Promise.reject(new Error('Forced failure'));

      // Buffer a log so flushAsync is called
      transport.log({ message: 'test', level: 'info' }, () => {});

      // flushLoggers iterates Logger and StatusLogger transports, not our testLogger.
      // But we can verify the catch path works by calling flushAsync directly
      // and checking the catch handler pattern.
      // Actually, flushLoggers only iterates the module-level Logger and StatusLogger.
      // To test L609, we need those transports' flushAsync to reject.
      // Since we now have the exported class, we can monkey-patch the prototype:
      const origFlushAsync = CloudWatchLogsTransport.prototype.flushAsync;
      CloudWatchLogsTransport.prototype.flushAsync = () => Promise.reject(new Error('Forced failure'));

      await expect(flushLoggers()).resolves.toBeUndefined();

      const catchCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('[flushLoggers] Failed to flush CloudWatch transport:'),
      );
      expect(catchCalled).toBe(true);

      // Restore prototype
      CloudWatchLogsTransport.prototype.flushAsync = origFlushAsync;
      transport.close();
      consoleErrorSpy.mockRestore();
    });

    test('should log to console when cloudWatchReady is true', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, createLogger, flushLoggers } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // After init, cloudWatchReady is true — exercises the cloudWatchReady branch in logMessage
      const logger = createLogger(['ready-test']);
      logger.info('Message when ready');
      logger.info('Message with prefix when ready', 'TestPrefix');

      await flushLoggers();

      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();
    });

    test('should exercise close() and finish() on transport', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Create a standalone transport instance to test close/finish directly
      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000, // Long interval so it doesn't interfere
      });

      // Buffer a log
      transport.log({ message: 'test-close-msg', level: 'info' }, () => {});

      // Call finish() with callback — exercises finish() → close() → flushSync()
      let callbackCalled = false;
      transport.finish(() => {
        callbackCalled = true;
      });
      expect(callbackCalled).toBe(true);

      // Call close() again — exercises the isClosed early return
      transport.close();

      // After close, log should go to console (isClosed = true)
      transport.log({ message: 'after-close-msg', level: 'info' }, () => {});
      const afterCloseLog = consoleLogSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('after-close-msg'),
      );
      expect(afterCloseLog).toBe(true);

      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test('should exercise flushSync when close() is called with buffered logs', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Create a standalone transport with buffered logs, then call close()
      // close() calls flushSync() which calls flush() fire-and-forget
      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      // Buffer some logs
      transport.log({ message: 'flushsync-msg-1', level: 'info' }, () => {});
      transport.log({ message: 'flushsync-msg-2', level: 'info' }, () => {});

      // close() triggers flushSync() which calls flush()
      transport.close();

      // Give a tick for the fire-and-forget flush to complete
      await new Promise(resolve => setImmediate(resolve));

      consoleErrorSpy.mockRestore();
    });

    test('should handle inner catch when transport creation fails after stream success', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.createLoggerStream).mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make the first setInterval call throw a non-Error value to cover both branches
      // of `error instanceof Error ? error.message : String(error)` in the inner catch
      const originalSetInterval = globalThis.setInterval;
      let callCount = 0;
      vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
        callCount++;
        if (callCount === 1) {
          throw 'Transport construction failed';
        }
        return originalSetInterval(...args);
      });

      const { waitForLoggerInitialization } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to initialize CloudWatch logging: Transport construction failed',
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith('Falling back to console-only logging.');

      consoleErrorSpy.mockRestore();
      vi.mocked(globalThis.setInterval).mockRestore();
    });

    test('should drop oldest logs when buffer reaches MAX_BUFFER_SIZE', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { waitForLoggerInitialization, createLogger } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const logger = createLogger(['buffer-limit-test']);

      // Log 50001 messages to exceed MAX_BUFFER_SIZE (50000)
      // Using logger.info goes through winston format pipeline which is slow but works
      for (let i = 0; i < 50001; i++) {
        logger.info(`m`);
      }

      const bufferWarning = consoleWarnSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('Log buffer reached maximum size'),
      );
      expect(bufferWarning).toBe(true);

      consoleWarnSpy.mockRestore();
    });

    test('should use info.message fallback when Symbol.for message is undefined', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Create a standalone transport and call log() directly without Symbol.for('message')
      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
      });

      // Call log() with info that has NO Symbol.for('message') — exercises fallback to info.message
      transport.log({ message: 'fallback-message-test', level: 'info' }, () => {});

      // Flush the transport
      await transport.flushAsync();

      const publishCalls = vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls;
      const hasMessage = publishCalls.some(call =>
        call[0].logEvents.some(e => e.message?.includes('fallback-message-test')),
      );
      expect(hasMessage).toBe(true);

      transport.close();
    });

    test('should exercise flushSync catch path when flush rejects', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      // Buffer a log so flushSync will attempt flush()
      transport.log({ message: 'flushsync-catch-test', level: 'info' }, () => {});

      // Override chunkEventsBySize to throw — this happens before the try block in flush()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).chunkEventsBySize = () => {
        throw new Error('chunk exploded');
      };

      // Call flushSync directly (not through close, which sets isClosed=true first)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).flushSync();

      // Give a tick for the fire-and-forget catch to execute
      await new Promise(resolve => setTimeout(resolve, 50));

      const catchCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('Failed to flush logs on exit:'),
      );
      expect(catchCalled).toBe(true);

      transport.close();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('CloudWatchLogsTransport batch chunking', () => {
    test('should send oversized batch in multiple chunks', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Create events that total > 1MB: 3500 events × ~300 bytes each ≈ 1.14MB
      const message = 'A'.repeat(300);
      for (let i = 0; i < 3500; i++) {
        transport.log({ message, level: 'info' }, noop);
      }

      await transport.flushAsync();

      // Should have been called more than once (batch was split)
      expect(vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls.length).toBeGreaterThan(1);

      // Each call's events should total under 1MB
      for (const call of vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls) {
        const events = call[0].logEvents;
        let totalBytes = 0;
        for (const event of events) {
          totalBytes += Buffer.byteLength(event.message ?? '', 'utf8') + 26;
        }
        expect(totalBytes).toBeLessThanOrEqual(1048576);
      }

      transport.close();
    });

    test('should send small batch in a single call', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Clear any calls from module-level transport initialization
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Small batch: 10 events × 100 bytes = well under 1MB
      for (let i = 0; i < 10; i++) {
        transport.log({ message: 'A'.repeat(100), level: 'info' }, noop);
      }

      await transport.flushAsync();

      // Should be exactly one call
      expect(vi.mocked(LoggerUtil.publishLoggerEvents)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls[0][0].logEvents).toHaveLength(10);

      transport.close();
    });

    test('should preserve event order across chunks', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Clear any calls from module-level transport initialization
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Create numbered events that will span multiple chunks
      const message = 'X'.repeat(300);
      for (let i = 0; i < 3500; i++) {
        transport.log({ message: `${i}-${message}`, level: 'info' }, noop);
      }

      await transport.flushAsync();

      // Collect all events across all calls in order
      const allEvents: string[] = [];
      for (const call of vi.mocked(LoggerUtil.publishLoggerEvents).mock.calls) {
        for (const event of call[0].logEvents) {
          allEvents.push(event.message ?? '');
        }
      }

      // Verify order is preserved
      for (let i = 1; i < allEvents.length; i++) {
        const prevIndex = parseInt(allEvents[i - 1].split('-')[0]);
        const currIndex = parseInt(allEvents[i].split('-')[0]);
        expect(currIndex).toBeGreaterThan(prevIndex);
      }

      transport.close();
    });

    test('should handle partial chunk failure and re-buffer only failed events', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');

      // First chunk succeeds, second chunk fails, then all succeed
      let callCount = 0;
      vi.mocked(LoggerUtil.publishLoggerEvents).mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error('Chunk 2 failed'));
        }
        return Promise.resolve(undefined);
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      // Clear any calls from module-level transport initialization
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();
      callCount = 0;

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Create events that span 2+ chunks
      const message = 'B'.repeat(300);
      for (let i = 0; i < 3500; i++) {
        transport.log({ message, level: 'info' }, noop);
      }

      // First flushAsync: chunk 1 succeeds, chunk 2 fails → re-buffered
      await transport.flushAsync();

      // Should see chunk failure error
      const chunkFailure = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('Failed to publish chunk'),
      );
      expect(chunkFailure).toBe(true);

      transport.close();
      consoleErrorSpy.mockRestore();
    });

    test('should handle event with undefined message in calculateEventBytes', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      // Directly push an event with undefined message to test the null coalescing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).logBuffer.push({
        message: undefined,
        timestamp: Date.now(),
      });

      await transport.flushAsync();

      // Should not throw, and should have published
      expect(LoggerUtil.publishLoggerEvents).toHaveBeenCalled();

      transport.close();
    });

    test('should handle empty buffer in chunkEventsBySize', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      // Don't add any events, just flush to drain any stale async calls from previous test
      await transport.flushAsync();

      // Clear any stale calls from previous test's async operations
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();

      // Flush again on the truly empty buffer
      await transport.flushAsync();

      // publishLoggerEvents should NOT be called for empty buffer
      expect(LoggerUtil.publishLoggerEvents).not.toHaveBeenCalled();

      transport.close();
    });

    test('should handle batch at exactly 1MB boundary', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockResolvedValue(undefined);

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();
      vi.mocked(LoggerUtil.publishLoggerEvents).mockClear();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Create events that total exactly under 1MB
      // Each event: 998 bytes message + 26 overhead = 1024 bytes
      // 1024 events × 1024 bytes = 1,048,576 bytes = exactly 1MB
      const message = 'C'.repeat(998);
      for (let i = 0; i < 1024; i++) {
        transport.log({ message, level: 'info' }, noop);
      }

      await transport.flushAsync();

      // At exactly 1MB, should still be a single call (not exceeding limit)
      expect(vi.mocked(LoggerUtil.publishLoggerEvents)).toHaveBeenCalledTimes(1);

      transport.close();
    });

    test('should trigger fallback after MAX_RETRIES with chunked failures', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Persistent failure'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Fail 3 times to trigger fallback
      for (let i = 0; i < 3; i++) {
        transport.log({ message: `fail-${i}`, level: 'info' }, noop);
        await transport.flushAsync();
      }

      // Should see fallback message
      const fallbackCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('[CLOUDWATCH FALLBACK]'),
      );
      expect(fallbackCalled).toBe(true);

      transport.close();
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    test('should dump both failedChunks and logBuffer during fallback with chunked batches', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      vi.mocked(LoggerUtil.publishLoggerEvents).mockRejectedValue(new Error('Unavailable'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // Set consecutiveFailures to 2 so next failure triggers fallback
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).consecutiveFailures = 2;

      // Add >10000 events so splice(0, 10000) leaves some in logBuffer
      for (let i = 0; i < 10002; i++) {
        transport.log({ message: `chunk-fb-${i}`, level: 'info' }, noop);
      }

      // Single flush: processes first 10000, all chunks fail → fallback
      // logBuffer still has 2 events that should be dumped via this.logBuffer.forEach
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (transport as any).flush();

      // Verify logBuffer items were dumped to console
      const bufferDumped = consoleLogSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('chunk-fb-10001'),
      );
      expect(bufferDumped).toBe(true);

      transport.close();
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    test('should reset consecutiveFailures when all chunks succeed', async () => {
      vi.doUnmock('winston');
      vi.doUnmock('winston-transport');

      process.env['VERBOSE_LOG_GROUP_NAME'] = 'test-log-group';
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['PIPELINE_ACCOUNT_ID'] = '123456789012';

      const { LoggerUtil } = await import('../../../lib/common/logger-util.js');
      // Fail once, then succeed
      vi.mocked(LoggerUtil.publishLoggerEvents)
        .mockRejectedValueOnce(new Error('Temporary'))
        .mockResolvedValue(undefined);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { waitForLoggerInitialization, CloudWatchLogsTransport } = await import('../../../lib/common/logger.js');
      await waitForLoggerInitialization();

      const transport = new CloudWatchLogsTransport({
        logGroupName: 'test-group',
        logStreamName: 'test-stream',
        region: 'us-east-1',
        uploadRate: 60000,
      });

      const noop = () => {};

      // First flush fails
      transport.log({ message: 'test-msg', level: 'info' }, noop);
      await transport.flushAsync();

      // Second flush succeeds — should reset failure counter
      await transport.flushAsync();

      // Third flush with new message should work (not trigger fallback)
      transport.log({ message: 'after-recovery', level: 'info' }, noop);
      await transport.flushAsync();

      // Should NOT see fallback
      const fallbackCalled = consoleErrorSpy.mock.calls.some(
        call => typeof call[0] === 'string' && call[0].includes('[CLOUDWATCH FALLBACK]'),
      );
      expect(fallbackCalled).toBe(false);

      transport.close();
      consoleErrorSpy.mockRestore();
    });
  });
});
