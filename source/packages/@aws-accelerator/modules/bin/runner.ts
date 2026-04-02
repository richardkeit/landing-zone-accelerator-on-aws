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

import path from 'path';
import { createStatusLogger } from '../../../@aws-lza/common/logger';
import { ModuleRunner } from '../index';
import { validateAndGetRunnerParameters } from '../lib/functions';

const statusLogger = createStatusLogger([path.parse(path.basename(__filename)).name]);

process.on('unhandledRejection', reason => {
  console.error(reason);

  process.exit(1);
});

/**
 * Main function to invoke accelerator runner
 * @returns status string
 */
async function main(): Promise<string> {
  if (process.env['USE_LZA_MODULES'] === 'no') {
    return 'Skipping execution of LZA Modules';
  }
  //validate and get runner parameters
  const runnerParams = validateAndGetRunnerParameters();

  return await ModuleRunner.execute(runnerParams);
}

/**
 * Call Main function
 */
(async () => {
  try {
    const status = await main();
    statusLogger.info(status);
    // Exit cleanly — ModuleRunner transitively loads @aws-lza/lib/common/logger via
    // modules/index.ts -> @aws-lza/index, which initializes a CloudWatchLogsTransport
    // with setInterval when VERBOSE_LOG_GROUP_NAME is set. Without process.exit(),
    // that interval keeps the Node.js event loop alive indefinitely.

    process.exit(0);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    statusLogger.error(errorMessage);
    throw err;
  }
})();

process.on('unhandledRejection', reason => {
  console.error(reason);

  process.exit(1);
});
