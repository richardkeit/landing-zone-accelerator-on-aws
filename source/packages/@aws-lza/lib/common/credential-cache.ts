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
import { IAssumeRoleCredential } from './interfaces';
import { createLogger } from './logger';

/**
 * Logger
 */
const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Credential cache entry
 */
interface CredentialCacheEntry {
  credentials: IAssumeRoleCredential;
  expiration: Date;
}

/**
 * Thread-safe credential cache with atomic in-flight request tracking
 *
 * @remarks
 * This cache reduces STS API calls when multiple modules execute in parallel.
 * JavaScript's single-threaded event loop ensures atomic check-and-set operations,
 * preventing race conditions when multiple modules request credentials simultaneously.
 *
 * Features:
 * - Atomic in-flight request tracking (prevents duplicate STS calls)
 * - Credential expiration checking (5-minute threshold)
 * - LRU eviction (max 100 entries)
 * - Enabled by default, opt-out via ACCELERATOR_DISABLE_CREDENTIAL_CACHE environment variable
 */
export class CredentialCache {
  private cache = new Map<string, CredentialCacheEntry>();
  private inFlightRequests = new Map<string, Promise<IAssumeRoleCredential | undefined>>();
  private enabled: boolean;
  private readonly maxCacheSize = 100;
  private readonly expirationThresholdMs = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.enabled = process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] !== 'true';
    if (this.enabled) {
      logger.info('Credential cache enabled (reduces STS API calls for parallel module execution)');
    } else {
      logger.info('Credential cache disabled via ACCELERATOR_DISABLE_CREDENTIAL_CACHE (unset to re-enable)');
    }
  }

  /**
   * Get credentials from cache or fetch from STS
   *
   * @remarks
   * This method implements atomic in-flight request tracking to prevent duplicate STS calls
   * when multiple modules request credentials for the same account simultaneously.
   *
   * @param key - Cache key (typically accountId-region-roleArn)
   * @param fetcher - Function to fetch credentials from STS
   * @param logPrefix - Log prefix for context (e.g., "accountId:region")
   * @returns Credentials or undefined
   */
  async getOrFetch(
    key: string,
    fetcher: () => Promise<IAssumeRoleCredential | undefined>,
    logPrefix: string,
  ): Promise<IAssumeRoleCredential | undefined> {
    if (!this.enabled) {
      return await fetcher();
    }

    // Check cache first
    const cached = this.get(key, logPrefix);
    if (cached) {
      return cached;
    }

    // Atomic operation: Check and set in one synchronous block
    // JavaScript's single-threaded event loop ensures this is atomic
    let inFlight = this.inFlightRequests.get(key);

    if (inFlight) {
      logger.info(`Waiting for in-flight credential fetch for ${key}`, logPrefix);
    } else {
      // We're the first! Create the promise and store it immediately
      logger.info(`Starting credential fetch for ${key}`, logPrefix);
      inFlight = this.executeFetch(key, fetcher, logPrefix);
      this.inFlightRequests.set(key, inFlight);
    }

    // Wait for the promise (either ours or someone else's)
    return await inFlight;
  }

  /**
   * Execute the credential fetch and handle caching
   *
   * @param key - Cache key
   * @param fetcher - Function to fetch credentials from STS
   * @param logPrefix - Log prefix for context
   * @returns Credentials or undefined
   */
  private async executeFetch(
    key: string,
    fetcher: () => Promise<IAssumeRoleCredential | undefined>,
    logPrefix: string,
  ): Promise<IAssumeRoleCredential | undefined> {
    try {
      logger.info(`Fetching credentials from STS for ${key}`, logPrefix);
      const credentials = await fetcher();

      // Store in cache if credentials were returned
      if (credentials) {
        this.set(key, credentials, logPrefix);
      }

      return credentials;
    } catch (error: unknown) {
      // Remove from in-flight on error so retry is possible
      this.inFlightRequests.delete(key);
      logger.error(
        `Failed to fetch credentials for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        logPrefix,
      );
      throw error;
    } finally {
      // Clean up in-flight tracking after a short delay
      // This allows concurrent requests to complete
      setTimeout(() => {
        this.inFlightRequests.delete(key);
      }, 100);
    }
  }

  /**
   * Get credentials from cache
   *
   * @param key - Cache key
   * @param logPrefix - Log prefix for context
   * @returns Credentials or undefined if not found or expired
   */
  private get(key: string, logPrefix: string): IAssumeRoleCredential | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check expiration
    if (!entry.expiration) {
      logger.warn(`Credentials for ${key} have no expiration, removing from cache`, logPrefix);
      this.cache.delete(key);
      return undefined;
    }

    const now = new Date();
    const timeUntilExpiration = entry.expiration.getTime() - now.getTime();

    if (timeUntilExpiration < this.expirationThresholdMs) {
      logger.info(
        `Credentials for ${key} expiring soon (${Math.round(timeUntilExpiration / 1000)}s), will refresh`,
        logPrefix,
      );
      this.cache.delete(key);
      return undefined;
    }

    logger.info(`Cache hit for ${key} (expires in ${Math.round(timeUntilExpiration / 1000)}s)`, logPrefix);
    return entry.credentials;
  }

  /**
   * Store credentials in cache
   *
   * @param key - Cache key
   * @param credentials - Credentials to store
   * @param logPrefix - Log prefix for context
   */
  private set(key: string, credentials: IAssumeRoleCredential, logPrefix: string): void {
    if (!credentials.expiration) {
      logger.warn(`Credentials for ${key} have no expiration, not caching`, logPrefix);
      return;
    }

    // Implement LRU eviction
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        logger.info(`Cache full, evicting oldest entry: ${firstKey}`, logPrefix);
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      credentials,
      expiration: credentials.expiration,
    });

    const timeUntilExpiration = credentials.expiration.getTime() - new Date().getTime();
    logger.info(`Cached credentials for ${key} (expires in ${Math.round(timeUntilExpiration / 1000)}s)`, logPrefix);
  }

  /**
   * Clear all cached credentials
   *
   * @remarks
   * Useful for testing or when credentials need to be refreshed
   */
  clear(): void {
    this.cache.clear();
    this.inFlightRequests.clear();
    logger.info('Credential cache cleared');
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  getStats(): { size: number; inFlight: number; enabled: boolean } {
    return {
      size: this.cache.size,
      inFlight: this.inFlightRequests.size,
      enabled: this.enabled,
    };
  }
}

/**
 * Global credential cache instance
 */
export const credentialCache = new CredentialCache();
