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

import { AccessDeniedException, ConflictException, Macie2Client, MacieStatus } from '@aws-sdk/client-macie2';
import { InvalidInputException } from '@aws-sdk/client-organizations';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  disableMacie,
  enableMacie,
  isMacieAvailableInPartition,
  isMacieEnabled,
  listAdminAccounts,
  MACIE_SERVICE_NAME,
} from '../../../lib/amazon-macie/functions';

vi.mock('@aws-sdk/client-macie2', () => ({
  Macie2Client: vi.fn(),
  EnableMacieCommand: vi.fn(),
  DisableMacieCommand: vi.fn(),
  GetMacieSessionCommand: vi.fn(),
  paginateListOrganizationAdminAccounts: vi.fn(),
  MacieStatus: { ENABLED: 'ENABLED', PAUSED: 'PAUSED' },
  AccessDeniedException: vi.fn(),
  ConflictException: class ConflictException extends Error {
    constructor(params: { message: string }) {
      super(params.message);
      this.name = 'ConflictException';
    }
  },
}));

vi.mock('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  InvalidInputException: vi.fn().mockImplementation(function (this: any, params: { message: string }) {
    const error = new Error(params.message);
    error.name = 'InvalidInputException';
    Object.setPrototypeOf(error, InvalidInputException.prototype);
    return error;
  }),
}));

vi.mock('../../../lib/common/organizations-functions', () => ({
  getDelegatedAdministratorAccountId: vi.fn(),
}));

vi.mock('../../../lib/common/utility', () => ({
  executeApi: vi.fn(),
  waitUntil: vi.fn(),
  setRetryStrategy: vi.fn(),
}));

vi.mock('../../../lib/common/logger', () => ({
  createLogger: vi.fn(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      dryRun: vi.fn(),
      commandExecution: vi.fn(),
      commandSuccess: vi.fn(),
    };
  }),
}));

describe('amazon-macie functions', () => {
  let mockExecuteApi: ReturnType<typeof vi.fn>;
  let mockWaitUntil: ReturnType<typeof vi.fn>;
  let mockPaginate: ReturnType<typeof vi.fn>;
  const mockClient = new Macie2Client({});
  const logPrefix = 'test';

  beforeEach(async () => {
    vi.clearAllMocks();
    const utility = await import('../../../lib/common/utility.js');
    const macie = await import('@aws-sdk/client-macie2');
    mockExecuteApi = vi.mocked(utility.executeApi);
    mockWaitUntil = vi.mocked(utility.waitUntil);
    mockPaginate = vi.mocked(macie.paginateListOrganizationAdminAccounts);
  });

  describe('enableMacie', () => {
    test('should enable Macie successfully', async () => {
      mockExecuteApi.mockResolvedValue({});
      mockWaitUntil.mockResolvedValue(undefined);

      await enableMacie(mockClient, false, logPrefix);

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'EnableMacieCommand',
        { status: MacieStatus.ENABLED },
        expect.any(Function),
        expect.anything(),
        logPrefix,
        [ConflictException],
      );
      expect(mockWaitUntil).toHaveBeenCalled();
    });

    test('should handle dry run', async () => {
      await enableMacie(mockClient, true, logPrefix);
      expect(mockExecuteApi).not.toHaveBeenCalled();
    });

    test('should treat ConflictException as success and skip the confirmation poll', async () => {
      const error = new ConflictException({ message: 'Macie has already been enabled' });
      mockExecuteApi.mockRejectedValue(error);

      await expect(enableMacie(mockClient, false, logPrefix)).resolves.toBeUndefined();

      expect(mockWaitUntil).not.toHaveBeenCalled();
    });

    test('should rethrow non-ConflictException errors', async () => {
      const error = new Error('Some other error');
      mockExecuteApi.mockRejectedValue(error);

      await expect(enableMacie(mockClient, false, logPrefix)).rejects.toThrow('Some other error');
      expect(mockWaitUntil).not.toHaveBeenCalled();
    });

    test('should call waitUntil after enabling Macie', async () => {
      mockExecuteApi.mockResolvedValue({});
      mockWaitUntil.mockImplementation(async predicate => {
        await predicate(); // Execute the predicate to cover the waitUntil call
      });

      await enableMacie(mockClient, false, logPrefix);

      expect(mockWaitUntil).toHaveBeenCalledWith(
        expect.any(Function),
        'Could not get confirmation that macie was enabled',
        expect.objectContaining({
          info: expect.any(Function),
          dryRun: expect.any(Function),
          commandExecution: expect.any(Function),
          commandSuccess: expect.any(Function),
        }),
        logPrefix,
      );
    });
  });

  describe('isMacieEnabled', () => {
    test('should return true when Macie is enabled', async () => {
      mockExecuteApi.mockResolvedValue({ status: MacieStatus.ENABLED });

      const result = await isMacieEnabled(mockClient, logPrefix);

      expect(result).toBe(true);
    });

    test('should return false when Macie is not enabled', async () => {
      mockExecuteApi.mockResolvedValue({ status: MacieStatus.PAUSED });

      const result = await isMacieEnabled(mockClient, logPrefix);

      expect(result).toBe(false);
    });

    test('should return false when AccessDeniedException is thrown', async () => {
      const error = new AccessDeniedException({ message: 'Access denied', $metadata: {} });
      mockExecuteApi.mockRejectedValue(error);

      const result = await isMacieEnabled(mockClient, logPrefix);

      expect(result).toBe(false);
    });

    test('should rethrow other errors', async () => {
      const error = new Error('Other error');
      mockExecuteApi.mockRejectedValue(error);

      await expect(isMacieEnabled(mockClient, logPrefix)).rejects.toThrow('Other error');
    });
  });

  describe('disableMacie', () => {
    test('should disable Macie successfully', async () => {
      mockExecuteApi.mockResolvedValue({});

      await disableMacie(mockClient, false, logPrefix);

      expect(mockExecuteApi).toHaveBeenCalledWith(
        'DisableMacieCommand',
        {},
        expect.any(Function),
        expect.anything(),
        logPrefix,
      );
    });

    test('should handle dry run', async () => {
      await disableMacie(mockClient, true, logPrefix);
      expect(mockExecuteApi).not.toHaveBeenCalled();
    });
  });

  describe('listAdminAccounts', () => {
    test('should list admin accounts successfully', async () => {
      const mockAccounts = [
        { accountId: 'XXXXXXXXXXXX', status: 'ENABLED' },
        { accountId: 'YYYYYYYYYYYY', status: 'ENABLED' },
      ];

      const mockPaginator = {
        [Symbol.asyncIterator]: async function* () {
          yield { adminAccounts: [mockAccounts[0]] };
          yield { adminAccounts: [mockAccounts[1]] };
        },
      };

      mockPaginate.mockReturnValue(mockPaginator);

      const result = await listAdminAccounts(mockClient, logPrefix);

      expect(result).toEqual(mockAccounts);
    });

    test('should handle empty admin accounts', async () => {
      const mockPaginator = {
        [Symbol.asyncIterator]: async function* () {
          yield { adminAccounts: [] };
        },
      };

      mockPaginate.mockReturnValue(mockPaginator);

      const result = await listAdminAccounts(mockClient, logPrefix);

      expect(result).toEqual([]);
    });

    test('should handle undefined admin accounts', async () => {
      const mockPaginator = {
        [Symbol.asyncIterator]: async function* () {
          yield { adminAccounts: undefined };
          yield { adminAccounts: [{ accountId: 'XXXXXXXXXXXX', status: 'ENABLED' }] };
        },
      };

      mockPaginate.mockReturnValue(mockPaginator);

      const result = await listAdminAccounts(mockClient, logPrefix);

      expect(result).toEqual([{ accountId: 'XXXXXXXXXXXX', status: 'ENABLED' }]);
    });
  });

  describe('isMacieAvailableInPartition', () => {
    const props = {
      region: 'us-east-1',
      solutionId: 'SO0199',
      credentials: undefined,
    };

    let mockGetDelegatedAdmin: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const orgFunctions = await import('../../../lib/common/organizations-functions.js');
      mockGetDelegatedAdmin = vi.mocked(orgFunctions.getDelegatedAdministratorAccountId);
    });

    test('should return true when Macie is available in the partition', async () => {
      mockGetDelegatedAdmin.mockResolvedValue(undefined);

      const result = await isMacieAvailableInPartition(props, logPrefix);

      expect(result).toBe(true);
      expect(mockGetDelegatedAdmin).toHaveBeenCalledWith(expect.anything(), MACIE_SERVICE_NAME, logPrefix);
    });

    test('should return false when InvalidInputException with unrecognized service principal is thrown', async () => {
      const error = new InvalidInputException({
        message: 'You specified an unrecognized service principal.',
        $metadata: {},
      });
      mockGetDelegatedAdmin.mockRejectedValue(error);

      const result = await isMacieAvailableInPartition(props, logPrefix);

      expect(result).toBe(false);
    });

    test('should rethrow InvalidInputException with other messages', async () => {
      const error = new InvalidInputException({
        message: 'You specified an invalid account ID.',
        $metadata: {},
      });
      mockGetDelegatedAdmin.mockRejectedValue(error);

      await expect(isMacieAvailableInPartition(props, logPrefix)).rejects.toThrow(InvalidInputException);
    });

    test('should rethrow non-InvalidInputException errors', async () => {
      const error = new Error('Network error');
      mockGetDelegatedAdmin.mockRejectedValue(error);

      await expect(isMacieAvailableInPartition(props, logPrefix)).rejects.toThrow('Network error');
    });
  });
});
