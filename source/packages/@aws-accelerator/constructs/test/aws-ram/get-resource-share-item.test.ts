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
/* eslint @typescript-eslint/no-explicit-any: 0 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListResourcesCommand, RAMClient } from '@aws-sdk/client-ram';
import { mockClient, AwsClientStub } from 'aws-sdk-client-mock';
import type { CloudFormationCustomResourceCreateEvent } from '@aws-accelerator/utils/lib/common-types';

// Make delay() a counted no-op so backoff timing can be asserted without real waits.
vi.mock('@aws-accelerator/utils/lib/throttle', () => ({
  throttlingBackOff: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  delay: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@aws-accelerator/utils/lib/common-functions', () => ({
  setRetryStrategy: vi.fn(() => ({})),
}));

import { handler } from '../../lib/aws-ram/get-resource-share-item';
import { delay } from '@aws-accelerator/utils/lib/throttle';

const RESOURCE_SHARE_ARN = 'arn:aws:ram:us-east-1:111111111111:resource-share/abcd-1234';
const RESOURCE_TYPE = 'ec2:Subnet';
const ITEM_ARN = 'arn:aws:ec2:us-east-1:111111111111:subnet/subnet-abc123';

const baseEvent: CloudFormationCustomResourceCreateEvent = {
  RequestType: 'Create',
  ResponseURL: 'https://example.com',
  ServiceToken: 'example-service-token',
  StackId: 'example-stack-id',
  RequestId: 'example-request-id',
  ResourceType: 'Custom::GetResourceShareItem',
  LogicalResourceId: 'example-logical-resource-id',
  ResourceProperties: {
    ServiceToken: 'example-service-token',
    resourceOwner: 'OTHER-ACCOUNTS',
    resourceShareArn: RESOURCE_SHARE_ARN,
    resourceType: RESOURCE_TYPE,
  },
};

const delayMock = delay as unknown as ReturnType<typeof vi.fn>;
let ramMock: AwsClientStub<RAMClient>;

beforeEach(() => {
  vi.clearAllMocks();
  ramMock = mockClient(RAMClient);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  ramMock.restore();
});

describe('get-resource-share-item — RAM ListResources eventual-consistency backoff', () => {
  it('returns SUCCESS on first attempt without inserting any user-perceived wait', async () => {
    ramMock.on(ListResourcesCommand).resolves({ resources: [{ arn: ITEM_ARN }] });

    const result = await handler(baseEvent);

    expect(result).toEqual({
      // handler returns the segment after the type prefix in item.arn
      PhysicalResourceId: 'subnet-abc123',
      Data: { arn: ITEM_ARN },
      Status: 'SUCCESS',
    });
    // first attempt uses delay(0); no retry needed
    expect(delayMock).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenNthCalledWith(1, 0);
    expect(ramMock.commandCalls(ListResourcesCommand).length).toBe(1);
  });

  it('retries on empty results and succeeds on the third attempt with exponential backoff', async () => {
    ramMock
      .on(ListResourcesCommand)
      .resolvesOnce({ resources: [] })
      .resolvesOnce({ resources: [] })
      .resolves({ resources: [{ arn: ITEM_ARN }] });

    const result = await handler(baseEvent);

    expect(result).toMatchObject({ Status: 'SUCCESS', Data: { arn: ITEM_ARN } });
    // 3 attempts → delays 0, 1*1000, 2^2*1000
    expect(delayMock).toHaveBeenCalledTimes(3);
    expect(delayMock.mock.calls.map(c => c[0])).toEqual([0, 1000, 4000]);
    expect(ramMock.commandCalls(ListResourcesCommand).length).toBe(3);
  });

  it('throws after MAX_ATTEMPTS=6 with the full quadratic backoff schedule', async () => {
    ramMock.on(ListResourcesCommand).resolves({ resources: [] });

    await expect(handler(baseEvent)).rejects.toThrow(/Resource share item not found after 6 attempts/);

    // quadratic schedule: 0, 1, 4, 9, 16, 25 seconds
    expect(delayMock).toHaveBeenCalledTimes(6);
    expect(delayMock.mock.calls.map(c => c[0])).toEqual([0, 1000, 4000, 9000, 16000, 25000]);
    expect(ramMock.commandCalls(ListResourcesCommand).length).toBe(6);
  });

  it('paginates within an attempt without inserting an extra delay between pages', async () => {
    // page 1 (empty + nextToken) and page 2 (result) are the same attempt
    ramMock
      .on(ListResourcesCommand)
      .resolvesOnce({ resources: [], nextToken: 'page-2' })
      .resolves({ resources: [{ arn: ITEM_ARN }] });

    const result = await handler(baseEvent);

    expect(result).toMatchObject({ Status: 'SUCCESS' });
    // 2 sends in one attempt = 1 delay, not 2
    expect(delayMock).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenNthCalledWith(1, 0);
    expect(ramMock.commandCalls(ListResourcesCommand).length).toBe(2);
  });

  it('Delete event short-circuits without calling ListResources or delay', async () => {
    const deleteEvent = {
      ...baseEvent,
      RequestType: 'Delete' as const,
      PhysicalResourceId: 'subnet-existing',
    };

    const result = await handler(deleteEvent as any);

    expect(result).toEqual({ PhysicalResourceId: 'subnet-existing', Status: 'SUCCESS' });
    expect(delayMock).not.toHaveBeenCalled();
    expect(ramMock.commandCalls(ListResourcesCommand).length).toBe(0);
  });
});
