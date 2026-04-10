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
 * CLI wrapper for diff-viewer HTML generation.
 * Placed at package root for ts-node compatibility in CodeBuild.
 *
 * Usage: yarn run ts-node --transpile-only generate-diff-viewer-cli.ts <diffDir> <outputFile>
 */
import * as fs from 'fs';
import { generateHtml } from './lib/diff-viewer/generate-diff-viewer';

const [diffDir, outputFile] = process.argv.slice(2);

if (!diffDir || !outputFile) {
  console.error('Usage: generate-diff-viewer-cli.ts <diffDir> <outputFile>');
  process.exit(1);
}

try {
  const html = generateHtml(diffDir);
  fs.writeFileSync(outputFile, html);
  console.log(`Generated ${outputFile}`);
} catch (e) {
  console.error(`Error generating diff viewer: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
