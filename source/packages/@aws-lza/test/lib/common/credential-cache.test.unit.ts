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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CredentialCache } from '../../../lib/common/credential-cache';
import { IAssumeRoleCredential } from '../../../lib/common/interfaces';

vi.mock('../../../lib/common/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const MOCK_CONSTANTS = {
  cacheKey: '123456789012-us-east-1-arn:aws:iam::123456789012:role/TestRole',
  logPrefix: 'test-prefix',
  credentials: {
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secretTest',
    sessionToken: 'tokenTest',
    expiration: new Date(Date.now() + 3600 * 1000), // 1 hour from now
  } as IAssumeRoleCredential,
};

describe('credential-cache', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe('CredentialCache constructor', () => {
    test('should enable cache by default', () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      const stats = cache.getStats();
      expect(stats.enabled).toBe(true);
    });

    test('should disable cache when environment variable is set', () => {
      process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] = 'true';
      const cache = new CredentialCache();

      const stats = cache.getStats();
      expect(stats.enabled).toBe(false);
    });

    test('should enable cache when environment variable is not true', () => {
      process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] = 'false';
      const cache = new CredentialCache();

      const stats = cache.getStats();
      expect(stats.enabled).toBe(true);
    });
  });

  describe('getOrFetch with cache enabled', () => {
    test('should fetch credentials when cache is empty', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result).toEqual(MOCK_CONSTANTS.credentials);
    });

    test('should return cached credentials on second call', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      // First call - should fetch
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      vi.clearAllMocks();

      // Second call - should use cache
      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).not.toHaveBeenCalled();
      expect(result).toEqual(MOCK_CONSTANTS.credentials);
    });

    test('should deduplicate concurrent requests for same key', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      // Start two concurrent requests
      const promise1 = cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);
      const promise2 = cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Fetcher should only be called once
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(MOCK_CONSTANTS.credentials);
      expect(result2).toEqual(MOCK_CONSTANTS.credentials);
    });

    test('should handle fetcher returning undefined', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(undefined);

      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(result).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('should not cache credentials when fetcher returns undefined', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(undefined);

      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    test('should handle fetcher errors and allow retry', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const error = new Error('STS API error');
      const fetcher = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(MOCK_CONSTANTS.credentials);

      // First call should fail
      await expect(cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix)).rejects.toThrow(
        'STS API error',
      );

      // Second call should succeed
      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(result).toEqual(MOCK_CONSTANTS.credentials);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('should handle non-Error objects in catch block', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockRejectedValue('string error');

      await expect(cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix)).rejects.toBe(
        'string error',
      );
    });

    test('should clean up in-flight requests after delay', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      // In-flight should still exist immediately
      let stats = cache.getStats();
      expect(stats.inFlight).toBe(1);

      // Advance timers by 100ms
      vi.advanceTimersByTime(100);

      // In-flight should be cleaned up
      stats = cache.getStats();
      expect(stats.inFlight).toBe(0);
    });
  });

  describe('getOrFetch with cache disabled', () => {
    test('should always call fetcher when cache is disabled', async () => {
      process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] = 'true';
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      // First call
      const result1 = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      // Second call
      const result2 = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result1).toEqual(MOCK_CONSTANTS.credentials);
      expect(result2).toEqual(MOCK_CONSTANTS.credentials);
    });

    test('should not cache credentials when disabled', async () => {
      process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] = 'true';
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('credential expiration handling', () => {
    test('should return cached credentials that are not expiring soon', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      // Create credentials expiring in 10 minutes (more than 5-minute threshold)
      const validCredentials = {
        ...MOCK_CONSTANTS.credentials,
        expiration: new Date(Date.now() + 10 * 60 * 1000),
      };

      const fetcher = vi.fn().mockResolvedValue(validCredentials);

      // First call - cache valid credentials
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      vi.clearAllMocks();

      // Second call - should return cached credentials without calling fetcher
      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).not.toHaveBeenCalled();
      expect(result).toEqual(validCredentials);
    });

    test('should not cache credentials without expiration', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      const credentialsWithoutExpiration = {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secretTest',
        sessionToken: 'tokenTest',
        expiration: undefined,
      } as IAssumeRoleCredential;

      const fetcher = vi.fn().mockResolvedValue(credentialsWithoutExpiration);

      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    test('should remove cached credentials without expiration on retrieval', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      // First, cache valid credentials
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      // Verify credentials were cached
      let stats = cache.getStats();
      expect(stats.size).toBe(1);

      // Manually corrupt the cache entry by removing expiration
      const cacheInternal = cache as unknown as {
        cache: Map<string, { credentials: IAssumeRoleCredential; expiration: Date }>;
      };
      cacheInternal.cache.set(MOCK_CONSTANTS.cacheKey, {
        credentials: {
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'secretTest',
          sessionToken: 'tokenTest',
          expiration: undefined,
        } as IAssumeRoleCredential,
        expiration: undefined as unknown as Date,
      });

      // Advance timers to clean up in-flight requests
      vi.advanceTimersByTime(100);

      vi.clearAllMocks();

      // Try to retrieve - should detect missing expiration, remove from cache, and fetch fresh
      const freshCredentials = {
        ...MOCK_CONSTANTS.credentials,
        expiration: new Date(Date.now() + 60 * 60 * 1000),
      };
      fetcher.mockResolvedValue(freshCredentials);

      const result = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result).toEqual(freshCredentials);

      // Verify the corrupted entry was removed and fresh one was cached
      stats = cache.getStats();
      expect(stats.size).toBe(1);
    });

    test('should not cache credentials without expiration on initial fetch', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      const credentialsWithoutExpiration = {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secretTest',
        sessionToken: 'tokenTest',
        expiration: undefined,
      } as IAssumeRoleCredential;

      const fetcher = vi.fn().mockResolvedValue(credentialsWithoutExpiration);

      // First call - should fetch but not cache
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      let stats = cache.getStats();
      expect(stats.size).toBe(0);

      // Advance timers to clean up in-flight requests
      vi.advanceTimersByTime(100);

      vi.clearAllMocks();

      // Second call - should fetch again since nothing was cached
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).toHaveBeenCalledTimes(1);
      stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    test('should detect and refresh credentials expiring soon', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];

      // Use real timers for this test to ensure Date.now() and new Date() are consistent
      vi.useRealTimers();

      const cache = new CredentialCache();

      // Create credentials expiring in 4 minutes (less than 5-minute threshold)
      const expiringCredentials = {
        ...MOCK_CONSTANTS.credentials,
        expiration: new Date(Date.now() + 4 * 60 * 1000),
      };

      const freshCredentials = {
        ...MOCK_CONSTANTS.credentials,
        expiration: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      };

      const fetcher = vi.fn().mockResolvedValueOnce(expiringCredentials).mockResolvedValueOnce(freshCredentials);

      // First call - cache expiring credentials
      const result1 = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);
      expect(result1).toEqual(expiringCredentials);

      // Wait for in-flight cleanup
      await new Promise(resolve => setTimeout(resolve, 150));

      vi.clearAllMocks();

      // Second call - should detect expiring credentials and refresh
      const result2 = await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result2).toEqual(freshCredentials);

      // Restore fake timers
      vi.useFakeTimers();
    });
  });

  describe('LRU eviction', () => {
    test('should evict oldest entry when cache is full', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();

      // Fill cache to max size (100 entries)
      const fetcher = vi.fn();
      for (let i = 0; i < 100; i++) {
        const key = `account-${i}-us-east-1-arn:aws:iam::${i}:role/TestRole`;
        fetcher.mockResolvedValueOnce({
          ...MOCK_CONSTANTS.credentials,
          accessKeyId: `AKIA${i}`,
        });
        await cache.getOrFetch(key, fetcher, MOCK_CONSTANTS.logPrefix);
      }

      let stats = cache.getStats();
      expect(stats.size).toBe(100);

      vi.clearAllMocks();

      // Add one more entry - should trigger eviction
      const newKey = 'account-100-us-east-1-arn:aws:iam::100:role/TestRole';
      fetcher.mockResolvedValueOnce(MOCK_CONSTANTS.credentials);
      await cache.getOrFetch(newKey, fetcher, MOCK_CONSTANTS.logPrefix);

      stats = cache.getStats();
      expect(stats.size).toBe(100);
    });
  });

  describe('clear', () => {
    test('should clear all cached credentials and in-flight requests', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      // Add some credentials to cache
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);
      await cache.getOrFetch('another-key', fetcher, MOCK_CONSTANTS.logPrefix);

      let stats = cache.getStats();
      expect(stats.size).toBeGreaterThan(0);

      // Clear cache
      cache.clear();

      stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.inFlight).toBe(0);
    });
  });

  describe('getStats', () => {
    test('should return correct cache statistics', async () => {
      delete process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'];
      const cache = new CredentialCache();
      const fetcher = vi.fn().mockResolvedValue(MOCK_CONSTANTS.credentials);

      // Initial stats
      let stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.inFlight).toBe(0);
      expect(stats.enabled).toBe(true);

      // Add credentials
      await cache.getOrFetch(MOCK_CONSTANTS.cacheKey, fetcher, MOCK_CONSTANTS.logPrefix);

      stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.enabled).toBe(true);
    });

    test('should show enabled false when cache is disabled', () => {
      process.env['ACCELERATOR_DISABLE_CREDENTIAL_CACHE'] = 'true';
      const cache = new CredentialCache();

      const stats = cache.getStats();
      expect(stats.enabled).toBe(false);
    });
  });

  describe('credentialCache singleton', () => {
    test('should export a global credential cache instance', async () => {
      const { credentialCache } = await import('../../../lib/common/credential-cache.js');

      expect(credentialCache).toBeDefined();
      expect(credentialCache.getStats).toBeDefined();
      expect(credentialCache.getOrFetch).toBeDefined();
      expect(credentialCache.clear).toBeDefined();
    });
  });
});
