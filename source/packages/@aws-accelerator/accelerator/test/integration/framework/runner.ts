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

import path from 'node:path';
import { createLogger } from 'aws-lza';
import { loadManifests } from './manifest-loader';
import { ManifestExecutionResult, ModuleTestPlugin, ResolvedEnvironment, TestManifest } from './types';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Runner options for controlling execution behavior.
 */
export interface RunnerOptions {
  /** If true, stop on first execution error. Default: true */
  failFastOnExecutionError?: boolean;
  /** If true, stop on first assertion failure. Default: false */
  failFastOnAssertionFailure?: boolean;
}

const DEFAULT_OPTIONS: Required<RunnerOptions> = {
  failFastOnExecutionError: true,
  failFastOnAssertionFailure: false,
};

/**
 * Executes all manifests for a module plugin serially through the
 * prepare → execute → assert → cleanup lifecycle.
 *
 * @param plugin - Module test plugin providing handler, assertions, and lifecycle hooks
 * @param manifestDir - Path to the directory containing *.manifest.json files
 * @param environment - Resolved test environment
 * @param options - Runner behavior options
 * @returns Array of execution results, one per manifest
 */
export async function runModuleIntegrationTests(
  plugin: ModuleTestPlugin,
  manifestDir: string,
  environment: ResolvedEnvironment,
  options?: RunnerOptions,
): Promise<ManifestExecutionResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const manifests = loadManifests(manifestDir);
  const results: ManifestExecutionResult[] = [];

  logger.info(`Starting integration tests for module: ${plugin.moduleName}`);
  logger.info(`Executing ${manifests.length} manifest(s) serially`);

  for (const manifest of manifests) {
    const result = await executeManifest(plugin, manifest, environment);
    results.push(result);

    // Log result summary
    const assertionSummary = summarizeAssertions(result);
    if (result.executionSuccess) {
      logger.info(`[${manifest.name}] Execution: SUCCESS | Assertions: ${assertionSummary}`);
    } else {
      logger.error(`[${manifest.name}] Execution: FAILED | ${result.error?.message}`);
    }

    // Fail-fast checks
    if (!result.executionSuccess && opts.failFastOnExecutionError) {
      logger.error(`Stopping execution due to fail-fast on execution error`);
      break;
    }

    const hasFailedAssertions = result.assertions.some(a => !a.passed);
    if (hasFailedAssertions && opts.failFastOnAssertionFailure) {
      logger.error(`Stopping execution due to fail-fast on assertion failure`);
      break;
    }
  }

  // Final summary
  const passed = results.filter(r => r.executionSuccess && r.assertions.every(a => a.passed)).length;
  logger.info(`Integration test complete: ${passed}/${results.length} manifest(s) passed`);

  return results;
}

/**
 * Execute a single manifest through the full lifecycle:
 * prepare → execute → assert → cleanup
 */
async function executeManifest(
  plugin: ModuleTestPlugin,
  manifest: TestManifest,
  environment: ResolvedEnvironment,
): Promise<ManifestExecutionResult> {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`Manifest: ${manifest.name} (order: ${manifest.order})`);
  logger.info(`Description: ${manifest.description}`);
  logger.info(`${'='.repeat(60)}`);

  const result: ManifestExecutionResult = {
    manifest,
    assertions: [],
    executionSuccess: false,
  };

  try {
    // PREPARE
    if (plugin.prepare) {
      logger.info(`[${manifest.name}] PREPARE phase`);
      await plugin.prepare(manifest, environment);
      logger.info(`[${manifest.name}] PREPARE complete`);
    }

    // EXECUTE
    logger.info(`[${manifest.name}] EXECUTE phase`);
    const params = await plugin.buildParams(manifest, environment);
    const response = await plugin.execute(params);
    result.moduleResponse = response;
    result.executionSuccess = true;
    logger.info(`[${manifest.name}] EXECUTE complete — status: ${response.status}`);

    // ASSERT
    logger.info(`[${manifest.name}] ASSERT phase`);
    result.assertions = await plugin.assert(manifest, environment);
    for (const assertion of result.assertions) {
      const icon = assertion.passed ? '✓' : '✗';
      logger.info(`[${manifest.name}]   ${icon} ${assertion.name}: ${assertion.message}`);
    }
    logger.info(`[${manifest.name}] ASSERT complete`);
  } catch (error: unknown) {
    result.error = error instanceof Error ? error : new Error(String(error));
    result.executionSuccess = false;
    logger.error(`[${manifest.name}] FAILED: ${result.error.message}`);
  } finally {
    // CLEANUP (unless skipped)
    if (!manifest.skipCleanup && plugin.cleanup) {
      try {
        logger.info(`[${manifest.name}] CLEANUP phase`);
        await plugin.cleanup(manifest, environment);
        logger.info(`[${manifest.name}] CLEANUP complete`);
      } catch (cleanupError: unknown) {
        const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logger.warn(`[${manifest.name}] CLEANUP failed (non-fatal): ${msg}`);
      }
    } else if (manifest.skipCleanup) {
      logger.info(`[${manifest.name}] CLEANUP skipped (skipCleanup=true)`);
    }
  }

  return result;
}

/**
 * Summarize assertion results as a compact string.
 */
function summarizeAssertions(result: ManifestExecutionResult): string {
  if (result.assertions.length === 0) {
    return 'none';
  }
  const passed = result.assertions.filter(a => a.passed).length;
  return `${passed}/${result.assertions.length} passed`;
}
