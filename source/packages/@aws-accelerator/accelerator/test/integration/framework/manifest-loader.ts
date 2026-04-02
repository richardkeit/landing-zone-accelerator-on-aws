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

import { createLogger } from 'aws-lza';
import * as fs from 'node:fs';
import path from 'node:path';
import { TestManifest } from './types';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

const MANIFEST_EXTENSION = '.manifest.json';

/**
 * Discovers, parses, validates, and sorts manifest files from a given directory.
 *
 * @param manifestDir - Absolute or relative path to the manifests directory
 * @returns Sorted array of TestManifest objects (ascending by order)
 * @throws Error if directory doesn't exist, no manifests found, or validation fails
 */
export function loadManifests(manifestDir: string): TestManifest[] {
  if (!fs.existsSync(manifestDir)) {
    throw new Error(`Manifest directory not found: ${manifestDir}`);
  }

  // Discover *.manifest.json files
  const files = fs
    .readdirSync(manifestDir)
    .filter(f => f.endsWith(MANIFEST_EXTENSION))
    .sort(); // Sort by filename for predictable discovery order

  if (files.length === 0) {
    throw new Error(`No manifest files (*${MANIFEST_EXTENSION}) found in ${manifestDir}`);
  }

  logger.info(`Discovered ${files.length} manifest file(s) in ${manifestDir}`);

  const manifests: TestManifest[] = [];

  for (const file of files) {
    const filePath = path.join(manifestDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(resolveEnvPlaceholders(content));
    } catch {
      throw new Error(`Invalid JSON in manifest file: ${file}`);
    }

    const manifest = parsed as TestManifest;
    validateManifest(manifest, file);
    manifests.push(manifest);

    logger.info(`Loaded manifest: ${manifest.name} (order: ${manifest.order}) from ${file}`);
  }

  // Sort by order field ascending
  manifests.sort((a, b) => a.order - b.order);

  // Check for duplicate order values
  const orders = manifests.map(m => m.order);
  const duplicates = orders.filter((v, i) => orders.indexOf(v) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate manifest order values: [${[...new Set(duplicates)].join(', ')}]`);
  }

  logger.info(`Loaded ${manifests.length} manifest(s), execution order: ${manifests.map(m => m.name).join(' → ')}`);
  return manifests;
}

/**
 * Validates a parsed manifest has all required fields.
 */
function validateManifest(manifest: TestManifest, filename: string): void {
  const required: (keyof TestManifest)[] = ['name', 'description', 'order', 'moduleConfig', 'expectedAssertions'];

  for (const field of required) {
    if (manifest[field] === undefined || manifest[field] === null) {
      throw new Error(`Manifest "${filename}" missing required field: ${field}`);
    }
  }

  if (typeof manifest.order !== 'number' || manifest.order < 0) {
    throw new Error(`Manifest "${filename}" has invalid order: ${manifest.order} (must be non-negative number)`);
  }

  if (typeof manifest.moduleConfig !== 'object') {
    throw new TypeError(`Manifest "${filename}" has invalid moduleConfig (must be an object)`);
  }

  if (typeof manifest.expectedAssertions !== 'object') {
    throw new TypeError(`Manifest "${filename}" has invalid expectedAssertions (must be an object)`);
  }
}

/**
 * Resolves `${ENV:VAR_NAME}` placeholders in manifest content with process.env values.
 * Throws if a referenced env var is not set.
 */
function resolveEnvPlaceholders(content: string): string {
  return content.replaceAll(/\$\{ENV:([^}]+)\}/g, (match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Manifest references unset environment variable: ${varName} (placeholder: ${match})`);
    }
    return value;
  });
}
