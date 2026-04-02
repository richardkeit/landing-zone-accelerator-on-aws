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

import * as fs from 'node:fs';
import { createLogger } from 'aws-lza';
import path from 'node:path';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Account entry from the environment manifest.
 */
interface ManifestAccount {
  name: string;
  id: string;
}

/**
 * Environment manifest structure (matches @aws-lza test helpers pattern).
 */
interface EnvironmentManifest {
  environments: Array<{
    name: string;
    partition: string;
    description?: string;
    accounts: ManifestAccount[];
  }>;
}

/**
 * Resolves logical account names (e.g., "Audit", "Management") to real account IDs
 * using the ENV_MANIFEST file. Follows the same pattern as the existing
 * IntegrationTest class in @aws-lza/test/helpers.
 */
export class AccountResolver {
  private readonly accounts: Map<string, string>;

  constructor(
    private readonly environmentName: string,
    private readonly partition: string,
  ) {
    this.accounts = this.loadAccountMappings();
  }

  /**
   * Resolve a logical account name to its account ID.
   * @throws Error if the account name is not found in the manifest.
   */
  resolveAccountId(logicalName: string): string {
    const accountId = this.accounts.get(logicalName);
    if (!accountId) {
      const available = Array.from(this.accounts.keys()).join(', ');
      throw new Error(`Account "${logicalName}" not found in environment manifest. Available accounts: [${available}]`);
    }
    return accountId;
  }

  /**
   * Get the full account name → ID map.
   */
  getAccountMap(): Map<string, string> {
    return new Map(this.accounts);
  }

  /**
   * Load account mappings from ENV_MANIFEST file.
   * Reuses the same pattern as IntegrationTest.getEnvironmentManifest().
   */
  private loadAccountMappings(): Map<string, string> {
    const envManifestPath = process.env['ENV_MANIFEST'];
    if (!envManifestPath) {
      throw new Error('Missing environment variable ENV_MANIFEST');
    }

    if (!fs.existsSync(envManifestPath)) {
      throw new Error(`Environment manifest file not found: ${envManifestPath}`);
    }

    logger.info(`Loading environment manifest from ${envManifestPath}`);
    const content = fs.readFileSync(envManifestPath, 'utf-8');
    const manifest: EnvironmentManifest = JSON.parse(content);

    // Find matching environment by name + partition
    const env = manifest.environments.find(e => e.name === this.environmentName && e.partition === this.partition);

    if (!env) {
      throw new Error(`Environment [${this.environmentName}:${this.partition}] not found in manifest`);
    }

    const accountMap = new Map<string, string>();
    for (const account of env.accounts) {
      accountMap.set(account.name, account.id);
      logger.info(`Resolved account: ${account.name} → ${account.id}`);
    }

    // Validate Management account exists
    if (!accountMap.has('Management')) {
      throw new Error(`Missing "Management" account in environment manifest for ${this.environmentName}`);
    }

    logger.info(`Loaded ${accountMap.size} account mappings`);
    return accountMap;
  }
}
