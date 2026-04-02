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
 * @fileoverview Generic integration test factory.
 *
 * Creates a Vitest describe block with per-manifest test cases for any module plugin.
 * Discovers manifests synchronously at module load time so Vitest registers one test
 * case per manifest. The full suite executes serially in beforeAll, then each
 * per-manifest test looks up its result from the shared results map.
 *
 * Usage (in a module's index.test.integration.ts):
 *   import { createModuleIntegrationTest } from '../../framework/create-module-test';
 *   import { maciePlugin } from './plugin';
 *   createModuleIntegrationTest('Macie', maciePlugin, __dirname);
 */

import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { loadManifests } from './manifest-loader';
import { buildTestEnvironment } from './test-environment';
import { runModuleIntegrationTests } from './runner';
import { ManifestExecutionResult, ModuleTestPlugin } from './types';

/**
 * Create a full integration test suite for a module.
 *
 * @param moduleName - Human-readable module name for the describe block (e.g., "Macie")
 * @param plugin - Module test plugin implementing buildParams, execute, assert
 * @param moduleDir - __dirname of the module test folder (manifests/ must be a subdirectory)
 */
export function createModuleIntegrationTest(moduleName: string, plugin: ModuleTestPlugin, moduleDir: string): void {
  const manifestDir = path.join(moduleDir, 'manifests');
  const manifests = loadManifests(manifestDir);

  describe(`${moduleName} Module Integration Tests`, () => {
    const resultsByName = new Map<string, ManifestExecutionResult>();

    beforeAll(async () => {
      const environment = await buildTestEnvironment();
      const results = await runModuleIntegrationTests(plugin, manifestDir, environment);
      for (const result of results) {
        resultsByName.set(result.manifest.name, result);
      }
    });

    for (const manifest of manifests) {
      it(`[${manifest.name}] should execute successfully`, () => {
        const result = resultsByName.get(manifest.name);
        expect(result, `No result found for manifest "${manifest.name}"`).toBeDefined();
        expect(
          result!.executionSuccess,
          `Manifest "${manifest.name}" execution failed: ${result!.error?.message}`,
        ).toBe(true);
      });

      it(`[${manifest.name}] should pass all assertions`, () => {
        const result = resultsByName.get(manifest.name);
        expect(result, `No result found for manifest "${manifest.name}"`).toBeDefined();
        const failures = result!.assertions.filter(a => !a.passed).map(a => `${a.name}: ${a.message}`);
        expect(failures, `Failed assertions:\n${failures.join('\n')}`).toHaveLength(0);
      });
    }
  });
}
