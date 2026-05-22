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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEc2Send = vi.fn();

// Captured command inputs so tests can assert on TagSpecifications / Filters / NextToken
const capturedCreateConnect: { input: unknown }[] = [];
const capturedCreateTags: { input: unknown }[] = [];
const capturedDescribeConnects: { input: unknown }[] = [];
const capturedDeleteConnect: { input: unknown }[] = [];

vi.mock('../../../lib/common/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('../../../lib/common/utility', () => ({
  executeApi: vi.fn((_name: string, _params: unknown, fn: () => Promise<unknown>) => fn()),
  setRetryStrategy: vi.fn(),
}));

vi.mock('../../../lib/common/sts-functions', () => ({
  getCredentials: vi.fn().mockResolvedValue({ accessKeyId: 'mock', secretAccessKey: 'mock', sessionToken: 'mock' }),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn(() => ({ send: mockEc2Send })),
  CreateTransitGatewayConnectCommand: vi.fn(input => {
    capturedCreateConnect.push({ input });
    return { input };
  }),
  CreateTagsCommand: vi.fn(input => {
    capturedCreateTags.push({ input });
    return { input };
  }),
  DeleteTransitGatewayConnectCommand: vi.fn(input => {
    capturedDeleteConnect.push({ input });
    return { input };
  }),
  DescribeTransitGatewayConnectsCommand: vi.fn(input => {
    capturedDescribeConnects.push({ input });
    return { input };
  }),
}));

import { TransitGatewayConnect } from '../../../lib/transit-gateway/tgw-connect';
import { ITgwConnectConfig, ITgwModuleRequest, ITgwResolvedContext } from '../../../lib/transit-gateway/interfaces';

const MODULE_TAG = { Key: 'accelerator:module', Value: 'tgw-associations-and-propagations' };
const NAME_TAG = (value: string) => ({ Key: 'Name', Value: value });

function makeRequest(connectAttachments?: ITgwConnectConfig[]): ITgwModuleRequest {
  return {
    invokingAccountId: '111111111111',
    region: 'us-east-1',
    partition: 'aws',
    globalRegion: 'us-east-1',
    operation: 'setup',
    moduleName: 'transit-gateway',
    solutionId: 'AwsSolution/SO0199',
    dryRun: false,
    configuration: {
      enable: true,
      accountAccessRoleName: 'AWSControlTowerExecution',
      transitGateways: [
        { name: 'main-tgw', accountId: '111111111111', region: 'us-east-1', routeTables: [{ name: 'core-rt' }] },
      ],
      attachments: [],
      connectAttachments,
    },
  };
}

function makeContext(): ITgwResolvedContext {
  return {
    transitGatewayIds: new Map([['main-tgw', 'tgw-0abc']]),
    routeTableIds: new Map([['main-tgw_core-rt', 'tgw-rtb-0def']]),
    attachmentIds: new Map([['main-tgw_111111111111_network-vpc', 'tgw-attach-transport']]),
  };
}

const connectConfig: ITgwConnectConfig = {
  name: 'my-connect',
  transitGateway: 'main-tgw',
  transportAttachmentType: 'vpc',
  transportName: 'network-vpc',
  transportAccountId: '111111111111',
  options: { protocol: 'gre' },
};

function resetCaptures() {
  capturedCreateConnect.length = 0;
  capturedCreateTags.length = 0;
  capturedDescribeConnects.length = 0;
  capturedDeleteConnect.length = 0;
}

describe('TransitGatewayConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptures();
  });

  it('should return empty array when no connect configs', async () => {
    const result = await TransitGatewayConnect.createConnectAttachments(makeRequest(), makeContext(), 'test');
    expect(result).toHaveLength(0);
  });

  it('should return exists when Connect already found by Name tag and module-managed', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-connect-existing',
          State: 'available',
          Tags: [NAME_TAG('my-connect'), MODULE_TAG],
        },
      ],
    });

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe('exists');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-connect-existing');
    // Already module-managed — no adoption call
    expect(capturedCreateTags).toHaveLength(0);
  });

  it('should create Connect when not found with atomic TagSpecifications (M2)', async () => {
    // Describe returns empty (not found)
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });
    // Create returns new attachment (tags are applied via TagSpecifications, no separate CreateTags)
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-connect-new' },
    });
    // Poll — available
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'available' }] });

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result[0].operation).toBe('created');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-connect-new');

    // M2 assertions: no separate CreateTagsCommand call
    expect(capturedCreateTags).toHaveLength(0);

    // M2 + M1: Create call carries TagSpecifications with Name + ownership tag
    expect(capturedCreateConnect).toHaveLength(1);
    const createInput = capturedCreateConnect[0].input as {
      TagSpecifications: { ResourceType: string; Tags: { Key: string; Value: string }[] }[];
    };
    expect(createInput.TagSpecifications).toHaveLength(1);
    expect(createInput.TagSpecifications[0].ResourceType).toBe('transit-gateway-attachment');
    const tagKeys = createInput.TagSpecifications[0].Tags.map(t => t.Key);
    expect(tagKeys).toContain('Name');
    expect(tagKeys).toContain('accelerator:module');
    const moduleTag = createInput.TagSpecifications[0].Tags.find(t => t.Key === 'accelerator:module');
    expect(moduleTag?.Value).toBe('tgw-associations-and-propagations');
  });

  it('should include user-provided tags in TagSpecifications on create', async () => {
    const configWithTags: ITgwConnectConfig = {
      ...connectConfig,
      tags: [
        { key: 'Environment', value: 'Production' },
        { key: 'Team', value: 'Networking' },
      ],
    };
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-tagged' },
    });
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'available' }] });

    await TransitGatewayConnect.createConnectAttachments(makeRequest([configWithTags]), makeContext(), 'test');

    const createInput = capturedCreateConnect[0].input as {
      TagSpecifications: { Tags: { Key: string; Value: string }[] }[];
    };
    const tagMap = new Map(createInput.TagSpecifications[0].Tags.map(t => [t.Key, t.Value]));
    expect(tagMap.get('Environment')).toBe('Production');
    expect(tagMap.get('Team')).toBe('Networking');
    expect(tagMap.get('Name')).toBe('my-connect');
    expect(tagMap.get('accelerator:module')).toBe('tgw-associations-and-propagations');
  });

  it('should ignore user-supplied tags that collide with reserved module keys (Wenjie H review)', async () => {
    // Customer tries to override the module ownership tag and the Name tag.
    // The module MUST win: user overrides are filtered out, and module tags are appended last
    // so even if the filter regresses, EC2 TagSpecifications' last-wins semantics protect the values.
    const configWithCollidingTags: ITgwConnectConfig = {
      ...connectConfig,
      tags: [
        { key: 'accelerator:module', value: 'something-else' }, // malicious / accidental
        { key: 'Name', value: 'customer-override-name' }, // would break discovery
        { key: 'Environment', value: 'Production' }, // legitimate, must be kept
      ],
    };

    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-filtered-tags' },
    });
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'available' }] });

    await TransitGatewayConnect.createConnectAttachments(makeRequest([configWithCollidingTags]), makeContext(), 'test');

    const tags = (capturedCreateConnect[0].input as { TagSpecifications: { Tags: { Key: string; Value: string }[] }[] })
      .TagSpecifications[0].Tags;

    // Must be exactly one instance of each reserved key (no duplicates in the TagSpecifications array)
    expect(tags.filter(t => t.Key === 'Name')).toHaveLength(1);
    expect(tags.filter(t => t.Key === 'accelerator:module')).toHaveLength(1);

    // Module-controlled values must win
    expect(tags.find(t => t.Key === 'Name')?.Value).toBe('my-connect');
    expect(tags.find(t => t.Key === 'accelerator:module')?.Value).toBe('tgw-associations-and-propagations');

    // Legitimate user tag still present
    expect(tags.find(t => t.Key === 'Environment')?.Value).toBe('Production');

    // Defense-in-depth: module tags appear LAST in the array (EC2 last-wins safety net)
    const nameIdx = tags.findIndex(t => t.Key === 'Name');
    const moduleIdx = tags.findIndex(t => t.Key === 'accelerator:module');
    const envIdx = tags.findIndex(t => t.Key === 'Environment');
    expect(nameIdx).toBeGreaterThan(envIdx);
    expect(moduleIdx).toBeGreaterThan(envIdx);
  });

  it('should adopt Name-matched Connect by adding ownership tag (M1 upgrade path)', async () => {
    // Existing CDK-created Connect: matches by Name but NO ownership tag
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-cdk-created',
          State: 'available',
          Tags: [NAME_TAG('my-connect')],
        },
      ],
    });
    // Adoption CreateTags call
    mockEc2Send.mockResolvedValueOnce({});

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result[0].operation).toBe('exists');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-cdk-created');

    // Adoption: CreateTags called with ownership tag
    expect(capturedCreateTags).toHaveLength(1);
    const adoptInput = capturedCreateTags[0].input as {
      Resources: string[];
      Tags: { Key: string; Value: string }[];
    };
    expect(adoptInput.Resources).toEqual(['tgw-attach-cdk-created']);
    expect(adoptInput.Tags).toEqual([{ Key: 'accelerator:module', Value: 'tgw-associations-and-propagations' }]);
  });

  it('should continue when adoption tagging fails (graceful degradation)', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-no-perm',
          State: 'available',
          Tags: [NAME_TAG('my-connect')],
        },
      ],
    });
    // Adoption fails (e.g. missing ec2:CreateTags permission)
    mockEc2Send.mockRejectedValueOnce(new Error('UnauthorizedOperation'));

    // Should NOT throw — graceful degradation, log warning and continue
    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result[0].operation).toBe('exists');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-no-perm');
  });

  it('should NOT adopt during DuplicateTransitGatewayAttachment re-query (concurrent execution safety)', async () => {
    // Describe returns empty (no existing Connect from our perspective)
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });
    // Create throws duplicate (concurrent execution beat us to it)
    const duplicateError = new Error('Connect already exists');
    duplicateError.name = 'DuplicateTransitGatewayAttachment';
    mockEc2Send.mockRejectedValueOnce(duplicateError);
    // Re-query finds the concurrently-created Connect — importantly, NOT module-managed here
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-raced',
          State: 'available',
          Tags: [NAME_TAG('my-connect')],
        },
      ],
    });

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result[0].operation).toBe('created');
    // CRITICAL: no CreateTags call — we must not tag a resource a concurrent execution made
    expect(capturedCreateTags).toHaveLength(0);
  });

  it('should skip adoption in dry run mode', async () => {
    // Existing non-module-managed Connect
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-existing',
          State: 'available',
          Tags: [NAME_TAG('my-connect')],
        },
      ],
    });

    const request = { ...makeRequest([connectConfig]), dryRun: true };
    await TransitGatewayConnect.createConnectAttachments(request, makeContext(), 'test');

    // Dry run — adoption tagging is skipped
    expect(capturedCreateTags).toHaveLength(0);
  });

  it('should skip creation in dry run mode', async () => {
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });

    const request = { ...makeRequest([connectConfig]), dryRun: true };
    const result = await TransitGatewayConnect.createConnectAttachments(request, makeContext(), 'test');

    expect(result[0].operation).toBe('skipped');
    expect(capturedCreateConnect).toHaveLength(0);
  });

  it('should throw when transport attachment not found', async () => {
    const context = makeContext();
    context.attachmentIds.clear();
    await expect(
      TransitGatewayConnect.createConnectAttachments(makeRequest([connectConfig]), context, 'test'),
    ).rejects.toThrow(/Transport attachment.*not found/);
  });

  it('should throw when TGW not found in config', async () => {
    const badConfig: ITgwConnectConfig = { ...connectConfig, transitGateway: 'nonexistent-tgw' };
    await expect(
      TransitGatewayConnect.createConnectAttachments(makeRequest([badConfig]), makeContext(), 'test'),
    ).rejects.toThrow(/TGW 'nonexistent-tgw' not found/);
  });

  it('should throw when Connect enters failed state during poll', async () => {
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-fail' },
    });
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'failed' }] });

    await expect(
      TransitGatewayConnect.createConnectAttachments(makeRequest([connectConfig]), makeContext(), 'test'),
    ).rejects.toThrow(/terminal state: failed/);
  });

  it('should build correct transport key for DX transport type', async () => {
    const dxConfig: ITgwConnectConfig = {
      name: 'dx-connect',
      transitGateway: 'main-tgw',
      transportAttachmentType: 'dxGateway',
      transportName: 'my-dxgw',
      transportAccountId: '111111111111',
      options: { protocol: 'gre' },
    };
    const context = makeContext();
    context.attachmentIds.set('main-tgw_111111111111_dxgw-my-dxgw', 'tgw-attach-dx-transport');

    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-connect-on-dx',
          State: 'available',
          Tags: [NAME_TAG('dx-connect'), MODULE_TAG],
        },
      ],
    });

    const result = await TransitGatewayConnect.createConnectAttachments(makeRequest([dxConfig]), context, 'test');
    expect(result[0].operation).toBe('exists');
  });

  it('should not match Connect with different Name tag', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-wrong-name',
          State: 'available',
          Tags: [NAME_TAG('other-connect'), MODULE_TAG],
        },
      ],
    });
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-correct' },
    });
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'available' }] });

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );
    expect(result[0].operation).toBe('created');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-correct');
  });

  it('should paginate DescribeTransitGatewayConnects across NextToken (M3)', async () => {
    // Page 1: not the match, returns NextToken
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-other',
          State: 'available',
          Tags: [NAME_TAG('other-connect'), MODULE_TAG],
        },
      ],
      NextToken: 'page-2-token',
    });
    // Page 2: contains the match
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-on-page-2',
          State: 'available',
          Tags: [NAME_TAG('my-connect'), MODULE_TAG],
        },
      ],
      // No NextToken — end of pagination
    });

    const result = await TransitGatewayConnect.createConnectAttachments(
      makeRequest([connectConfig]),
      makeContext(),
      'test',
    );

    expect(result[0].operation).toBe('exists');
    expect(result[0].connectAttachmentId).toBe('tgw-attach-on-page-2');

    // Both Describe calls made — pagination followed
    expect(capturedDescribeConnects).toHaveLength(2);
    expect((capturedDescribeConnects[0].input as { NextToken?: string }).NextToken).toBeUndefined();
    expect((capturedDescribeConnects[1].input as { NextToken?: string }).NextToken).toBe('page-2-token');
  });

  it('should time out after CONNECT_MAX_POLL_RETRIES with clear error (M4)', async () => {
    vi.useFakeTimers();

    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] }); // Describe: not found
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnect: { TransitGatewayAttachmentId: 'tgw-attach-timeout' },
    }); // Create
    // All 36 polls return 'pending' — never reaches 'available'
    for (let i = 0; i < 36; i++) {
      mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [{ State: 'pending' }] });
    }

    const promise = TransitGatewayConnect.createConnectAttachments(makeRequest([connectConfig]), makeContext(), 'test');
    // Attach the rejection expectation BEFORE advancing time to avoid unhandled-rejection warnings
    const expectation = expect(promise).rejects.toThrow(/did not reach 'available' after 36 retries/);

    // Advance time past all poll intervals: 36 * 10_000ms
    await vi.advanceTimersByTimeAsync(36 * 10_000);
    await expectation;

    vi.useRealTimers();
  });

  it('should not affect Connect when config has no connectAttachments', async () => {
    const result = await TransitGatewayConnect.createConnectAttachments(makeRequest(), makeContext(), 'test');
    expect(result).toHaveLength(0);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('should cache EC2 client per (accountId, region) across multiple Connects (Wenjie H review)', async () => {
    // Two Connects on the SAME cross-account TGW — must result in exactly ONE sts:AssumeRole.
    const crossAcctConfig1: ITgwConnectConfig = {
      name: 'connect-1',
      transitGateway: 'main-tgw',
      transportAttachmentType: 'vpc',
      transportName: 'vpc-x',
      transportAccountId: '222222222222',
      options: { protocol: 'gre' },
    };
    const crossAcctConfig2: ITgwConnectConfig = {
      name: 'connect-2',
      transitGateway: 'main-tgw',
      transportAttachmentType: 'vpc',
      transportName: 'vpc-y',
      transportAccountId: '222222222222',
      options: { protocol: 'gre' },
    };

    const crossAcctRequest = makeRequest([crossAcctConfig1, crossAcctConfig2]);
    // TGW itself lives in the cross-account
    crossAcctRequest.configuration.transitGateways[0].accountId = '222222222222';

    const context = makeContext();
    context.attachmentIds.clear();
    context.attachmentIds.set('main-tgw_222222222222_vpc-x', 'tgw-attach-x');
    context.attachmentIds.set('main-tgw_222222222222_vpc-y', 'tgw-attach-y');

    // Both found by Name — exists path, no create
    mockEc2Send
      .mockResolvedValueOnce({
        TransitGatewayConnects: [
          {
            TransitGatewayAttachmentId: 'tgw-attach-connect-1',
            State: 'available',
            Tags: [NAME_TAG('connect-1'), MODULE_TAG],
          },
        ],
      })
      .mockResolvedValueOnce({
        TransitGatewayConnects: [
          {
            TransitGatewayAttachmentId: 'tgw-attach-connect-2',
            State: 'available',
            Tags: [NAME_TAG('connect-2'), MODULE_TAG],
          },
        ],
      });

    // Import the mocked getCredentials so we can inspect its call count
    const stsFns = await import('../../../lib/common/sts-functions');
    const getCredentialsMock = vi.mocked(stsFns.getCredentials);
    getCredentialsMock.mockClear();

    await TransitGatewayConnect.createConnectAttachments(crossAcctRequest, context, 'test');

    // One AssumeRole for the shared (222222222222, us-east-1) client — not two
    expect(getCredentialsMock).toHaveBeenCalledTimes(1);
  });
});

describe('TransitGatewayConnect - deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptures();
  });

  const makeDeleteRequest = (connectAttachments?: ITgwConnectConfig[]): ITgwModuleRequest => ({
    invokingAccountId: '111111111111',
    region: 'us-east-1',
    partition: 'aws',
    globalRegion: 'us-east-1',
    operation: 'setup',
    moduleName: 'transit-gateway',
    solutionId: 'AwsSolution/SO0199',
    dryRun: false,
    configuration: {
      enable: true,
      accountAccessRoleName: 'AWSControlTowerExecution',
      transitGateways: [
        { name: 'main-tgw', accountId: '111111111111', region: 'us-east-1', routeTables: [{ name: 'core-rt' }] },
      ],
      attachments: [],
      connectAttachments,
    },
  });

  const makeDeleteContext = (): ITgwResolvedContext => ({
    transitGatewayIds: new Map([['main-tgw', 'tgw-0abc']]),
    routeTableIds: new Map([['main-tgw_core-rt', 'tgw-rtb-0def']]),
    attachmentIds: new Map(),
  });

  it('should delete module-managed Connect not in config', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-stale',
          State: 'available',
          Tags: [NAME_TAG('removed-connect'), MODULE_TAG],
        },
      ],
    });
    mockEc2Send.mockResolvedValueOnce({}); // Delete response

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([]),
      makeDeleteContext(),
      'test',
    );

    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe('deleted');
    expect(capturedDeleteConnect).toHaveLength(1);
  });

  it('should NOT delete Connect missing ownership tag (M1 customer safety)', async () => {
    // Connect has Name tag but NO ownership tag — out-of-band resource
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-out-of-band',
          State: 'available',
          Tags: [NAME_TAG('customer-created-connect')],
        },
      ],
    });

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([]),
      makeDeleteContext(),
      'test',
    );

    expect(result).toHaveLength(0);
    // CRITICAL: no Delete call — out-of-band resources are protected
    expect(capturedDeleteConnect).toHaveLength(0);
  });

  it('should not delete Connect that is in config (even if module-managed)', async () => {
    const config: ITgwConnectConfig = {
      name: 'my-connect',
      transitGateway: 'main-tgw',
      transportAttachmentType: 'vpc',
      transportName: 'network-vpc',
      transportAccountId: '111111111111',
      options: { protocol: 'gre' },
    };

    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-keep',
          State: 'available',
          Tags: [NAME_TAG('my-connect'), MODULE_TAG],
        },
      ],
    });

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([config]),
      makeDeleteContext(),
      'test',
    );

    expect(result).toHaveLength(0);
    expect(capturedDeleteConnect).toHaveLength(0);
  });

  it('should skip deletion in dry run mode (but still report)', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-stale',
          State: 'available',
          Tags: [NAME_TAG('removed-connect'), MODULE_TAG],
        },
      ],
    });

    const request = { ...makeDeleteRequest([]), dryRun: true };
    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(request, makeDeleteContext(), 'test');

    expect(result).toHaveLength(1);
    expect(result[0].operation).toBe('deleted');
    expect(capturedDeleteConnect).toHaveLength(0); // No actual delete call
  });

  it('should skip Connect without Name tag', async () => {
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-no-name',
          State: 'available',
          Tags: [MODULE_TAG], // module tag but no Name — can't identify
        },
      ],
    });

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([]),
      makeDeleteContext(),
      'test',
    );
    expect(result).toHaveLength(0);
  });

  it('should return empty when no Connect attachments exist', async () => {
    mockEc2Send.mockResolvedValueOnce({ TransitGatewayConnects: [] });

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([]),
      makeDeleteContext(),
      'test',
    );
    expect(result).toHaveLength(0);
  });

  it('should paginate across NextToken during delete scan (M3)', async () => {
    // Page 1 — one stale (module-managed) + one out-of-band, NextToken returned
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-stale-page-1',
          State: 'available',
          Tags: [NAME_TAG('stale-1'), MODULE_TAG],
        },
        {
          TransitGatewayAttachmentId: 'tgw-attach-out-of-band',
          State: 'available',
          Tags: [NAME_TAG('customer-connect')], // no module tag → protected
        },
      ],
      NextToken: 'next',
    });
    // Page 2 — one more stale
    mockEc2Send.mockResolvedValueOnce({
      TransitGatewayConnects: [
        {
          TransitGatewayAttachmentId: 'tgw-attach-stale-page-2',
          State: 'available',
          Tags: [NAME_TAG('stale-2'), MODULE_TAG],
        },
      ],
    });
    // Two Delete calls (for the two module-managed stale ones)
    mockEc2Send.mockResolvedValueOnce({});
    mockEc2Send.mockResolvedValueOnce({});

    const result = await TransitGatewayConnect.deleteStaleConnectAttachments(
      makeDeleteRequest([]),
      makeDeleteContext(),
      'test',
    );

    // Both pages scanned, two stale deleted, out-of-band protected
    expect(result).toHaveLength(2);
    expect(result.map(r => r.connectName).sort()).toEqual(['stale-1', 'stale-2']);
    expect(capturedDeleteConnect).toHaveLength(2);
    expect(capturedDescribeConnects).toHaveLength(2);
  });
});
