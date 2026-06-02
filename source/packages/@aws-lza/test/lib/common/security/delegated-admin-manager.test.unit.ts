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

import { Macie2Client } from '@aws-sdk/client-macie2';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IconLogger } from '../../../../lib/common/logger';
import * as organizationsFunctions from '../../../../lib/common/organizations-functions';
import {
  DelegatedAdminManager,
  DelegatedAdminOperations,
  manageOrganizationsApiDelegatedAdmin,
} from '../../../../lib/common/security/delegated-admin-manager';

describe('DelegatedAdminManager', () => {
  let manager: DelegatedAdminManager<Macie2Client>;
  let mockOrganizationsClient: OrganizationsClient;
  let mockServiceClient: Macie2Client;
  let mockLogger: IconLogger;
  let mockDelegatedAdminOps: DelegatedAdminOperations<Macie2Client>;

  const TEST_SERVICE_NAME = 'macie.amazonaws.com';
  const TEST_TARGET_ACCOUNT = 'target-account-xxx';
  const TEST_CURRENT_ACCOUNT = 'current-account-yyy';
  const TEST_LOG_PREFIX = 'test-prefix';

  beforeEach(() => {
    vi.clearAllMocks();
    // Create mock clients
    mockOrganizationsClient = {} as OrganizationsClient;
    mockServiceClient = {} as Macie2Client;

    // Create mock logger with all required methods
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    } as unknown as IconLogger;

    // Create mock delegated admin operations
    mockDelegatedAdminOps = {
      enable: vi.fn().mockResolvedValue(undefined),
      disable: vi.fn().mockResolvedValue(undefined),
      getCurrent: vi.fn().mockResolvedValue(undefined),
    };

    // Create manager instance
    manager = new DelegatedAdminManager(TEST_SERVICE_NAME, mockOrganizationsClient, mockLogger);

    // Mock organizations functions
    vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);
    vi.spyOn(organizationsFunctions, 'deregisterDelegatedAdministrator').mockResolvedValue(undefined);
  });

  describe('enable', () => {
    it('should skip setup when target account is already delegated admin', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_TARGET_ACCOUNT);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockDelegatedAdminOps.getCurrent).toHaveBeenCalledWith(mockServiceClient, TEST_LOG_PREFIX);
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Delegated admin is already set to ${TEST_TARGET_ACCOUNT}, skipping setup`,
        TEST_LOG_PREFIX,
      );
      expect(mockDelegatedAdminOps.enable).not.toHaveBeenCalled();
    });

    it('should enable delegated admin when no current admin exists', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockDelegatedAdminOps.getCurrent).toHaveBeenCalledWith(mockServiceClient, TEST_LOG_PREFIX);
      expect(mockDelegatedAdminOps.enable).toHaveBeenCalledWith(
        mockServiceClient,
        TEST_TARGET_ACCOUNT,
        false,
        TEST_LOG_PREFIX,
      );
    });

    it('should cleanup existing admin and enable new one', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT) // First call in cleanup
        .mockResolvedValueOnce(undefined); // Second call for validation

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_CURRENT_ACCOUNT,
        TEST_SERVICE_NAME,
        false,
        TEST_LOG_PREFIX,
      );
      expect(mockDelegatedAdminOps.enable).toHaveBeenCalledWith(
        mockServiceClient,
        TEST_TARGET_ACCOUNT,
        false,
        TEST_LOG_PREFIX,
      );
    });

    it('should handle dry run mode correctly', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_CURRENT_ACCOUNT);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, true, TEST_LOG_PREFIX);

      // Verify dry run was called (implementation uses dryRun for validation logging)
      expect(mockLogger.dryRun).toHaveBeenCalled();
      expect(mockDelegatedAdminOps.enable).toHaveBeenCalledWith(
        mockServiceClient,
        TEST_TARGET_ACCOUNT,
        true,
        TEST_LOG_PREFIX,
      );
    });

    it('should throw error when cleanup validation fails', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT) // First call in cleanup
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT); // Second call for validation (still exists)

      await expect(
        manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX),
      ).rejects.toThrow(
        `Failed to deregister delegated admin from Organizations API: ${TEST_CURRENT_ACCOUNT} still exists`,
      );
    });

    it('should warn when service-specific admin needs cleanup', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Service-specific delegated admin cleanup for ${TEST_CURRENT_ACCOUNT} must be handled by the calling service`,
        TEST_LOG_PREFIX,
      );
    });
  });

  describe('disable', () => {
    it('should skip disable when no delegated admin exists', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(undefined);

      await manager.disable(mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'No delegated admin account found, skipping disable operation',
        TEST_LOG_PREFIX,
      );
      expect(mockDelegatedAdminOps.disable).not.toHaveBeenCalled();
    });

    it('should disable delegated admin successfully', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);

      await manager.disable(mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockDelegatedAdminOps.disable).toHaveBeenCalledWith(
        mockServiceClient,
        TEST_CURRENT_ACCOUNT,
        false,
        TEST_LOG_PREFIX,
      );
      // Org-level deregister is handled by manageOrganizationsApiDelegatedAdmin, not per-region disable
      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
    });

    it('should handle dry run mode correctly', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);

      await manager.disable(mockServiceClient, mockDelegatedAdminOps, true, TEST_LOG_PREFIX);

      expect(mockDelegatedAdminOps.disable).toHaveBeenCalledWith(
        mockServiceClient,
        TEST_CURRENT_ACCOUNT,
        true,
        TEST_LOG_PREFIX,
      );
      // Org-level deregister is handled by manageOrganizationsApiDelegatedAdmin, not per-region disable
      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExisting (via enable)', () => {
    it('should cleanup Organizations delegated admin when it differs from target', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT) // First call in cleanup
        .mockResolvedValueOnce(undefined); // Second call for validation

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_CURRENT_ACCOUNT,
        TEST_SERVICE_NAME,
        false,
        TEST_LOG_PREFIX,
      );
    });

    it('should not cleanup Organizations delegated admin when it matches target', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_TARGET_ACCOUNT);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
    });

    it('should log cleanup progress correctly', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT)
        .mockResolvedValueOnce(undefined);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      // Verify cleanup logging occurred (implementation logs multiple messages during cleanup)
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Starting cleanup of existing delegated administrators for ${TEST_SERVICE_NAME}`,
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Successfully completed cleanup of existing delegated administrators`,
        TEST_LOG_PREFIX,
      );
    });
  });

  describe('error handling', () => {
    it('should propagate service enable function errors', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(undefined);
      mockDelegatedAdminOps.enable = vi.fn().mockRejectedValue(new Error('Service enable failed'));

      await expect(
        manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX),
      ).rejects.toThrow('Service enable failed');
    });

    it('should propagate service disable function errors', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      mockDelegatedAdminOps.disable = vi.fn().mockRejectedValue(new Error('Service disable failed'));

      await expect(manager.disable(mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX)).rejects.toThrow(
        'Service disable failed',
      );
    });

    it('should propagate Organizations API errors', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockRejectedValue(
        new Error('Organizations API error'),
      );

      await expect(
        manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX),
      ).rejects.toThrow('Organizations API error');
    });

    it('should throw error when cleanup validation fails after deregistration', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      mockDelegatedAdminOps.disable = vi.fn().mockResolvedValue(undefined);

      // Mock Organizations API to simulate cleanup validation failure
      // Flow: cleanupExisting -> deregisterFromOrganizations -> validation in cleanupExisting
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_CURRENT_ACCOUNT) // 1st call in cleanupExisting: org admin exists
        .mockResolvedValueOnce(undefined) // 2nd call in deregisterFromOrganizations validation: deregistration succeeded
        .mockResolvedValueOnce('999999999999'); // 3rd call in cleanupExisting validation: different account still exists

      await expect(
        manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX),
      ).rejects.toThrow('Failed to clean up Organizations delegated admin: 999999999999 still exists');
    });
  });

  describe('logging', () => {
    it('should log current and target admin accounts', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(TEST_CURRENT_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockLogger.info).toHaveBeenCalledWith(
        `Current delegated admin account id: ${TEST_CURRENT_ACCOUNT}, Target delegated admin: ${TEST_TARGET_ACCOUNT}`,
        TEST_LOG_PREFIX,
      );
    });

    it('should log "none" when no current admin exists', async () => {
      mockDelegatedAdminOps.getCurrent = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manager.enable(TEST_TARGET_ACCOUNT, mockServiceClient, mockDelegatedAdminOps, false, TEST_LOG_PREFIX);

      expect(mockLogger.info).toHaveBeenCalledWith(
        `Current delegated admin account id: none, Target delegated admin: ${TEST_TARGET_ACCOUNT}`,
        TEST_LOG_PREFIX,
      );
    });
  });
});

describe('manageOrganizationsApiDelegatedAdmin', () => {
  let mockOrganizationsClient: OrganizationsClient;
  let mockLogger: IconLogger;

  const TEST_SERVICE_NAME = 'macie.amazonaws.com';
  const TEST_TARGET_ACCOUNT = 'target-account-xxx';
  const TEST_EXISTING_ACCOUNT = 'existing-account-yyy';
  const TEST_LOG_PREFIX = 'test-prefix';

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganizationsClient = {} as OrganizationsClient;

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    } as unknown as IconLogger;

    vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);
    vi.spyOn(organizationsFunctions, 'deregisterDelegatedAdministrator').mockResolvedValue(undefined);
  });

  describe('ENABLE FLOW (enabledRegions.length > 0)', () => {
    it('should deregister existing admin when it does not match target', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT) // Initial check
        .mockResolvedValueOnce(undefined); // Validation after deregistration

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1', 'us-west-2'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_EXISTING_ACCOUNT,
        TEST_SERVICE_NAME,
        false,
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `[ENABLE FLOW] Deregistering existing Organizations delegated admin: ${TEST_EXISTING_ACCOUNT} (doesn't match target ${TEST_TARGET_ACCOUNT})`,
        TEST_LOG_PREFIX,
      );
    });

    it('should not deregister when existing admin matches target', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_TARGET_ACCOUNT);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        `[ENABLE FLOW] Organizations API delegated admin is already set to target ${TEST_TARGET_ACCOUNT}, no cleanup needed`,
        TEST_LOG_PREFIX,
      );
    });

    it('should not deregister when no existing admin found', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ENABLE FLOW] No existing Organizations API delegated admin found, no cleanup needed',
        TEST_LOG_PREFIX,
      );
    });

    it('should throw error when deregistration validation fails', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT) // Initial check
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT); // Validation - still exists

      await expect(
        manageOrganizationsApiDelegatedAdmin(
          mockOrganizationsClient,
          TEST_SERVICE_NAME,
          TEST_TARGET_ACCOUNT,
          ['us-east-1'], // enabledRegions
          [], // disabledRegions
          false,
          TEST_LOG_PREFIX,
          mockLogger,
        ),
      ).rejects.toThrow(
        `Failed to deregister delegated admin from Organizations API: ${TEST_EXISTING_ACCOUNT} still exists`,
      );
    });

    it('should handle mixed enable/disable scenario (enable flow takes precedence)', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT)
        .mockResolvedValueOnce(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        ['us-west-1'], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      // Should execute ENABLE FLOW, not DISABLE FLOW
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('[ENABLE FLOW]'), TEST_LOG_PREFIX);
      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_EXISTING_ACCOUNT,
        TEST_SERVICE_NAME,
        false,
        TEST_LOG_PREFIX,
      );
    });
  });

  describe('DISABLE FLOW (disabledRegions.length > 0 && enabledRegions.length === 0)', () => {
    it('should deregister existing admin when disabling all regions', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT) // Initial check
        .mockResolvedValueOnce(undefined); // Validation after deregistration

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        [], // enabledRegions - empty
        ['us-east-1', 'us-west-2'], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_EXISTING_ACCOUNT,
        TEST_SERVICE_NAME,
        false,
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `[DISABLE FLOW] Deregistering Organizations delegated admin: ${TEST_EXISTING_ACCOUNT} (disabling in all regions)`,
        TEST_LOG_PREFIX,
      );
    });

    it('should not deregister when no existing admin found', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        [], // enabledRegions - empty
        ['us-east-1'], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[DISABLE FLOW] No Organizations API delegated admin found, no deregistration needed',
        TEST_LOG_PREFIX,
      );
    });

    it('should throw error when deregistration validation fails', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT) // Initial check
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT); // Validation - still exists

      await expect(
        manageOrganizationsApiDelegatedAdmin(
          mockOrganizationsClient,
          TEST_SERVICE_NAME,
          TEST_TARGET_ACCOUNT,
          [], // enabledRegions - empty
          ['us-east-1'], // disabledRegions
          false,
          TEST_LOG_PREFIX,
          mockLogger,
        ),
      ).rejects.toThrow(
        `Failed to deregister delegated admin from Organizations API: ${TEST_EXISTING_ACCOUNT} still exists`,
      );
    });
  });

  describe('dry run mode', () => {
    it('should not deregister in dry run mode (ENABLE FLOW)', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_EXISTING_ACCOUNT);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        true, // dryRun
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_EXISTING_ACCOUNT,
        TEST_SERVICE_NAME,
        true, // dryRun passed through
        TEST_LOG_PREFIX,
      );
    });

    it('should not deregister in dry run mode (DISABLE FLOW)', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_EXISTING_ACCOUNT);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        [], // enabledRegions - empty
        ['us-east-1'], // disabledRegions
        true, // dryRun
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledWith(
        mockOrganizationsClient,
        TEST_EXISTING_ACCOUNT,
        TEST_SERVICE_NAME,
        true, // dryRun passed through
        TEST_LOG_PREFIX,
      );
    });
  });

  describe('logging', () => {
    it('should log Organizations API delegated admin status', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT) // Initial check
        .mockResolvedValueOnce(undefined); // Validation after deregistration

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        `Managing Organizations API delegated admin for ${TEST_SERVICE_NAME} in global region`,
        TEST_LOG_PREFIX,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Organizations API delegated admin: ${TEST_EXISTING_ACCOUNT}, Target: ${TEST_TARGET_ACCOUNT}`,
        TEST_LOG_PREFIX,
      );
    });

    it('should log "none" when no existing admin found', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        `Organizations API delegated admin: none, Target: ${TEST_TARGET_ACCOUNT}`,
        TEST_LOG_PREFIX,
      );
    });

    it('should log successful deregistration', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT)
        .mockResolvedValueOnce(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1'], // enabledRegions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        `Successfully deregistered ${TEST_EXISTING_ACCOUNT} from Organizations API`,
        TEST_LOG_PREFIX,
      );
    });
  });

  describe('error handling', () => {
    it('should propagate Organizations API errors', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockRejectedValue(
        new Error('Organizations API error'),
      );

      await expect(
        manageOrganizationsApiDelegatedAdmin(
          mockOrganizationsClient,
          TEST_SERVICE_NAME,
          TEST_TARGET_ACCOUNT,
          ['us-east-1'], // enabledRegions
          [], // disabledRegions
          false,
          TEST_LOG_PREFIX,
          mockLogger,
        ),
      ).rejects.toThrow('Organizations API error');
    });

    it('should propagate deregistration errors', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_EXISTING_ACCOUNT);
      vi.spyOn(organizationsFunctions, 'deregisterDelegatedAdministrator').mockRejectedValue(
        new Error('Deregistration failed'),
      );

      await expect(
        manageOrganizationsApiDelegatedAdmin(
          mockOrganizationsClient,
          TEST_SERVICE_NAME,
          TEST_TARGET_ACCOUNT,
          ['us-east-1'], // enabledRegions
          [], // disabledRegions
          false,
          TEST_LOG_PREFIX,
          mockLogger,
        ),
      ).rejects.toThrow('Deregistration failed');
    });
  });

  describe('edge cases', () => {
    it('should handle empty enabled and disabled regions (no-op)', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId').mockResolvedValue(TEST_EXISTING_ACCOUNT);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        [], // enabledRegions - empty
        [], // disabledRegions - empty
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      // Should not execute either flow
      expect(organizationsFunctions.deregisterDelegatedAdministrator).not.toHaveBeenCalled();
    });

    it('should handle multiple enabled regions', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT)
        .mockResolvedValueOnce(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        ['us-east-1', 'us-west-1', 'us-west-2', 'eu-west-1'], // Multiple enabled regions
        [], // disabledRegions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      // Should still only call deregister once (global operation)
      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple disabled regions', async () => {
      vi.spyOn(organizationsFunctions, 'getDelegatedAdministratorAccountId')
        .mockResolvedValueOnce(TEST_EXISTING_ACCOUNT)
        .mockResolvedValueOnce(undefined);

      await manageOrganizationsApiDelegatedAdmin(
        mockOrganizationsClient,
        TEST_SERVICE_NAME,
        TEST_TARGET_ACCOUNT,
        [], // enabledRegions - empty
        ['us-east-1', 'us-west-1', 'us-west-2', 'eu-west-1'], // Multiple disabled regions
        false,
        TEST_LOG_PREFIX,
        mockLogger,
      );

      // Should still only call deregister once (global operation)
      expect(organizationsFunctions.deregisterDelegatedAdministrator).toHaveBeenCalledTimes(1);
    });
  });
});
