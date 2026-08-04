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

import { describe, beforeEach, expect, test, vi } from 'vitest';
import {
  OrganizationsClient,
  DescribeAccountCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-organizations';
import { ManageAccountTags } from '../../../../lib/aws-organizations/manage-account-tags';
import { IManageAccountTagsHandlerParameter } from '../../../../interfaces/aws-organizations/manage-account-tags';
import { MODULE_EXCEPTIONS } from '../../../../common/enums';

const MARKER_KEY = 'accelerator:managed-tags';

vi.mock('@aws-sdk/client-organizations', () => {
  return {
    OrganizationsClient: vi.fn(),
    DescribeAccountCommand: vi.fn(),
    ListTagsForResourceCommand: vi.fn(),
    TagResourceCommand: vi.fn(),
    UntagResourceCommand: vi.fn(),
  };
});

vi.mock('../../../../common/throttle', () => ({
  throttlingBackOff: vi.fn(fn => fn()),
}));

vi.mock('../../../../common/functions', async () => {
  return {
    ...(await vi.importActual('../../../../common/functions')),
    setRetryStrategy: vi.fn(function () {
      return {};
    }),
  };
});

describe('ManageAccountTags', () => {
  const mockSend = vi.fn();

  const baseParams: IManageAccountTagsHandlerParameter = {
    operation: 'manage-account-tags',
    partition: 'aws',
    region: 'us-east-1',
    configuration: {
      accountId: '111111111111',
      tags: [
        { key: 'Environment', value: 'Production' },
        { key: 'CostCenter', value: 'Engineering' },
      ],
      removalPolicy: 'managed',
    },
  };

  /**
   * Configure mockSend so ListTagsForResource returns the given tag map, DescribeAccount
   * succeeds, and Tag/Untag resolve.
   */
  const withCurrentTags = (current: Record<string, string>) => {
    mockSend.mockImplementation(command => {
      if (command instanceof ListTagsForResourceCommand) {
        return Promise.resolve({
          Tags: Object.entries(current).map(([Key, Value]) => ({ Key, Value })),
        });
      }
      if (command instanceof DescribeAccountCommand) {
        return Promise.resolve({ Account: { Id: '111111111111' } });
      }
      if (command instanceof TagResourceCommand || command instanceof UntagResourceCommand) {
        return Promise.resolve({});
      }
      return Promise.reject(new Error('Unknown command'));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();

    (OrganizationsClient as vi.Mock).mockImplementation(function () {
      return {
        send: mockSend,
      };
    });
  });

  describe('managed policy', () => {
    test('applies all tags and writes the marker when none exist', async () => {
      withCurrentTags({});

      const result = await new ManageAccountTags().handler(baseParams);

      // Status reports only the user tags, not the internal marker
      expect(result).toBe('Successfully applied 2 tag(s) [Environment, CostCenter] to account "111111111111"');
      // A single TagResource call carries the user tags plus the marker
      expect(TagResourceCommand).toHaveBeenCalledTimes(1);
      expect(TagResourceCommand).toHaveBeenCalledWith({
        ResourceId: '111111111111',
        Tags: [
          { Key: 'Environment', Value: 'Production' },
          { Key: 'CostCenter', Value: 'Engineering' },
          { Key: MARKER_KEY, Value: 'CostCenter+Environment' },
        ],
      });
      expect(UntagResourceCommand).toHaveBeenCalledTimes(0);
    });

    test('reports no changes when tags and marker already match', async () => {
      withCurrentTags({
        Environment: 'Production',
        CostCenter: 'Engineering',
        [MARKER_KEY]: 'CostCenter+Environment',
      });

      const result = await new ManageAccountTags().handler(baseParams);

      expect(result).toBe('No tag changes required for account "111111111111"');
      expect(TagResourceCommand).toHaveBeenCalledTimes(0);
      expect(UntagResourceCommand).toHaveBeenCalledTimes(0);
    });

    test('never removes a foreign tag that the accelerator did not apply', async () => {
      withCurrentTags({
        Environment: 'Production',
        'sca:inspector': 'true', // applied by another system, not in the marker
      });

      const result = await new ManageAccountTags().handler({
        ...baseParams,
        configuration: {
          accountId: '111111111111',
          tags: [{ key: 'Environment', value: 'Production' }],
          removalPolicy: 'managed',
        },
      });

      // Foreign tag is left alone; only the marker is (silently) written
      expect(UntagResourceCommand).toHaveBeenCalledTimes(0);
      expect(TagResourceCommand).toHaveBeenCalledTimes(1);
      expect(TagResourceCommand).toHaveBeenCalledWith({
        ResourceId: '111111111111',
        Tags: [{ Key: MARKER_KEY, Value: 'Environment' }],
      });
      expect(result).toBe('No tag changes required for account "111111111111"');
    });

    test('removes a previously managed tag dropped from config but keeps foreign tags', async () => {
      withCurrentTags({
        Environment: 'Production',
        CostCenter: 'Engineering', // was managed, now dropped from config
        'sca:inspector': 'true', // foreign, must be preserved
        [MARKER_KEY]: 'CostCenter+Environment',
      });

      const result = await new ManageAccountTags().handler({
        ...baseParams,
        configuration: {
          accountId: '111111111111',
          tags: [{ key: 'Environment', value: 'Production' }],
          removalPolicy: 'managed',
        },
      });

      expect(result).toBe('Successfully removed 1 tag(s) [CostCenter] from account "111111111111"');
      // Only CostCenter is removed; sca:inspector is never passed to Untag
      expect(UntagResourceCommand).toHaveBeenCalledTimes(1);
      expect(UntagResourceCommand).toHaveBeenCalledWith({ ResourceId: '111111111111', TagKeys: ['CostCenter'] });
      // Marker is updated to reflect the new managed set
      expect(TagResourceCommand).toHaveBeenCalledWith({
        ResourceId: '111111111111',
        Tags: [{ Key: MARKER_KEY, Value: 'Environment' }],
      });
    });
  });

  describe('authoritative policy', () => {
    test('removes any tag not present in config, except the marker', async () => {
      withCurrentTags({
        Environment: 'Production',
        'sca:inspector': 'true',
        [MARKER_KEY]: 'Environment',
      });

      const result = await new ManageAccountTags().handler({
        ...baseParams,
        configuration: {
          accountId: '111111111111',
          tags: [{ key: 'Environment', value: 'Production' }],
          removalPolicy: 'authoritative',
        },
      });

      expect(result).toBe('Successfully removed 1 tag(s) [sca:inspector] from account "111111111111"');
      expect(UntagResourceCommand).toHaveBeenCalledTimes(1);
      expect(UntagResourceCommand).toHaveBeenCalledWith({ ResourceId: '111111111111', TagKeys: ['sca:inspector'] });
    });
  });

  describe('additive policy', () => {
    test('adds and updates but never removes', async () => {
      withCurrentTags({
        Environment: 'Staging', // value differs -> update
        'sca:inspector': 'true', // would be removed under other policies
      });

      const result = await new ManageAccountTags().handler({
        ...baseParams,
        configuration: {
          accountId: '111111111111',
          tags: [{ key: 'Environment', value: 'Production' }],
          removalPolicy: 'additive',
        },
      });

      expect(result).toBe('Successfully applied 1 tag(s) [Environment] to account "111111111111"');
      expect(UntagResourceCommand).toHaveBeenCalledTimes(0);
    });
  });

  describe('common handler behaviour', () => {
    test('paginates when listing current tags', async () => {
      let listCall = 0;
      mockSend.mockImplementation(command => {
        if (command instanceof ListTagsForResourceCommand) {
          listCall++;
          if (listCall === 1) {
            return Promise.resolve({ Tags: [{ Key: 'Environment', Value: 'Production' }], NextToken: 'token' });
          }
          return Promise.resolve({
            Tags: [
              { Key: 'CostCenter', Value: 'Engineering' },
              { Key: MARKER_KEY, Value: 'CostCenter+Environment' },
            ],
          });
        }
        if (command instanceof DescribeAccountCommand) {
          return Promise.resolve({ Account: { Id: '111111111111' } });
        }
        return Promise.reject(new Error('Unknown command'));
      });

      const result = await new ManageAccountTags().handler(baseParams);

      expect(listCall).toBe(2);
      expect(result).toBe('No tag changes required for account "111111111111"');
    });

    test('throws when the account cannot be described', async () => {
      mockSend.mockImplementation(command => {
        if (command instanceof ListTagsForResourceCommand) {
          return Promise.resolve({ Tags: [] });
        }
        if (command instanceof DescribeAccountCommand) {
          return Promise.reject(new Error('AccountNotFoundException'));
        }
        return Promise.reject(new Error('Unknown command'));
      });

      await expect(new ManageAccountTags().handler(baseParams)).rejects.toThrow(/not found or not accessible/);
    });
  });

  describe('validateTags', () => {
    const validate = (tags: { key: string; value: string }[]) =>
      new ManageAccountTags().handler({
        ...baseParams,
        configuration: { accountId: '111111111111', tags, removalPolicy: 'managed' },
      });

    beforeEach(() => withCurrentTags({}));

    test('rejects a reserved aws: tag key', async () => {
      const result = await validate([{ key: 'aws:foo', value: 'bar' }]);
      expect(result).toMatch(new RegExp(`${MODULE_EXCEPTIONS.INVALID_INPUT}.*reserved "aws:" prefix`));
      expect(TagResourceCommand).toHaveBeenCalledTimes(0);
    });

    test('rejects duplicate tag keys', async () => {
      const result = await validate([
        { key: 'Environment', value: 'Production' },
        { key: 'Environment', value: 'Staging' },
      ]);
      expect(result).toMatch(new RegExp(`${MODULE_EXCEPTIONS.INVALID_INPUT}.*duplicate tag key`));
    });

    test('rejects more than 50 tags', async () => {
      const tags = Array.from({ length: 51 }, (_, i) => ({ key: `key${i}`, value: `value${i}` }));
      const result = await validate(tags);
      expect(result).toMatch(new RegExp(`${MODULE_EXCEPTIONS.INVALID_INPUT}.*maximum of 50 tags`));
    });

    test('rejects a tag value containing a comma (not allowed by the Organizations pattern)', async () => {
      const result = await validate([{ key: 'Owners', value: 'alice,bob' }]);
      expect(result).toMatch(new RegExp(`${MODULE_EXCEPTIONS.INVALID_INPUT}.*tag value "alice,bob".*unsupported`));
      expect(TagResourceCommand).toHaveBeenCalledTimes(0);
    });

    test('rejects a tag key containing an unsupported character', async () => {
      const result = await validate([{ key: 'bad key!', value: 'ok' }]);
      expect(result).toMatch(new RegExp(`${MODULE_EXCEPTIONS.INVALID_INPUT}.*tag key "bad key!".*unsupported`));
    });
  });

  describe('dry run mode', () => {
    const dryRun = (
      current: Record<string, string>,
      configuration: IManageAccountTagsHandlerParameter['configuration'],
    ) => {
      withCurrentTags(current);
      return new ManageAccountTags().handler({ ...baseParams, dryRun: true, configuration });
    };

    test('reports apply and remove without the internal marker and without mutating', async () => {
      const result = await dryRun(
        { Environment: 'Staging', CostCenter: 'Engineering', [MARKER_KEY]: 'CostCenter+Environment' },
        { accountId: '111111111111', tags: [{ key: 'Environment', value: 'Production' }], removalPolicy: 'managed' },
      );

      expect(result).toMatch('Will apply tags [Environment] and remove tags [CostCenter] for account "111111111111"');
      // No DescribeAccount / Tag / Untag calls in dry run
      expect(DescribeAccountCommand).toHaveBeenCalledTimes(0);
      expect(TagResourceCommand).toHaveBeenCalledTimes(0);
      expect(UntagResourceCommand).toHaveBeenCalledTimes(0);
    });

    test('reports up to date when nothing changes', async () => {
      const result = await dryRun(
        { Environment: 'Production', [MARKER_KEY]: 'Environment' },
        { accountId: '111111111111', tags: [{ key: 'Environment', value: 'Production' }], removalPolicy: 'managed' },
      );

      expect(result).toMatch('Account "111111111111" tags are already up to date, no changes required');
    });

    test('surfaces validation errors', async () => {
      const result = await dryRun(
        {},
        { accountId: '111111111111', tags: [{ key: 'aws:foo', value: 'bar' }], removalPolicy: 'managed' },
      );

      expect(result).toMatch(new RegExp(`Will experience ${MODULE_EXCEPTIONS.INVALID_INPUT}`));
    });
  });
});
