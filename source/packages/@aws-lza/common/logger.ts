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

import * as winston from 'winston';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const stripAnsi = winston.format(info => {
  if (typeof info.message === 'string') {
    info.message = info.message.replace(ANSI_REGEX, '');
  }
  return info;
});

const logFormat = winston.format.printf(({ message, timestamp, level, mainLabel, childLabel }) => {
  return `${timestamp} | ${level} | ${childLabel || mainLabel} | ${message}`;
});

const statusLogFormat = winston.format.printf(({ message, timestamp, childLabel }) => {
  return `${timestamp} | status | ${childLabel} | ${message}`;
});

const Logger = winston.createLogger({
  defaultMeta: { mainLabel: 'accelerator' },
  level: 'debug',
  format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' })),
  transports: [
    new winston.transports.Console({
      level: process.env['LOG_LEVEL'] ?? 'info',
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: 'debug.log',
      level: 'debug',
      format: winston.format.combine(stripAnsi(), logFormat),
    }),
  ],
});

winston.add(Logger);

export const createLogger = (logInfo: string[]) => {
  const logInfoString = logInfo.join(' | ');
  return Logger.child({ childLabel: logInfoString });
};

const StatusLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' })),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), statusLogFormat),
    }),
    new winston.transports.File({
      filename: 'debug.log',
      level: 'info',
      format: winston.format.combine(stripAnsi(), statusLogFormat),
    }),
  ],
});

winston.add(StatusLogger);

/**
 * Use this logger to log status messages to the console, since this is not dependent on LOG_LEVEL variable this should be used only for summary status.
 *
 * Do not use this logger to log detailed messages, use createLogger instead.
 * @param logInfo string[]
 * @returns
 */
export const createStatusLogger = (logInfo: string[]) => {
  if (!logInfo || logInfo.length === 0) {
    throw new Error('createStatusLogger requires at least one log info item');
  }
  const logInfoString = logInfo.join(' | ');
  return StatusLogger.child({ childLabel: logInfoString });
};

/**
 * Drains and closes all File transports on both loggers.
 * Call before process exit to ensure all buffered writes reach disk.
 */
export async function flushFileTransports(): Promise<void> {
  const allTransports = [...Logger.transports, ...StatusLogger.transports];
  const fileTransports = allTransports.filter(
    (t): t is winston.transports.FileTransportInstance => t instanceof winston.transports.File,
  );
  await Promise.all(
    fileTransports.map(
      t =>
        new Promise<void>(resolve => {
          t.once('finish', () => resolve());
          t.end();
        }),
    ),
  );
}
