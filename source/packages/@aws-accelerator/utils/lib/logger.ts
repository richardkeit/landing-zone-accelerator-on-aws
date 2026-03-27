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

const logFormat = winston.format.printf(({ message, timestamp, level, mainLabel, childLabel }) => {
  return `${timestamp} | ${level} | ${childLabel || mainLabel} | ${message}`;
});

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const stripAnsi = winston.format(info => {
  info.message = (info.message as string).replace(ANSI_REGEX, '');
  return info;
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
