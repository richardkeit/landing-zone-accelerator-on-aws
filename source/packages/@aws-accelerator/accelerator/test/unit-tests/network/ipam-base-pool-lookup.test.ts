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

import { describe, test, expect } from 'vitest';
import { IpamConfig } from '@aws-accelerator/config';

/**
 * Replicates the getIpamBasePool lookup logic from VpcSubnetsBaseStack.
 */
function getIpamBasePool(ipamPoolName: string, ipamConfig?: IpamConfig[]): string[] | undefined {
  let basePool: string[] | undefined;

  for (const ipam of ipamConfig ?? []) {
    const pool = ipam.pools?.find(item => item.name === ipamPoolName);
    if (pool?.provisionedCidrs) {
      basePool = pool.provisionedCidrs;
      break;
    }
  }

  return basePool;
}

describe('IPAM base pool lookup', () => {
  const multipleIpams = [
    {
      name: 'ipam-us-east-1',
      region: 'us-east-1',
      pools: [{ name: 'us-east-pool', provisionedCidrs: ['10.0.0.0/12'] }],
    },
    {
      name: 'ipam-us-west-2',
      region: 'us-west-2',
      pools: [{ name: 'us-west-pool', provisionedCidrs: ['10.16.0.0/12'] }],
    },
  ] as unknown as IpamConfig[];

  test('finds pool in first IPAM when multiple IPAMs defined', () => {
    const result = getIpamBasePool('us-east-pool', multipleIpams);
    expect(result).toEqual(['10.0.0.0/12']);
  });

  test('finds pool in second IPAM when multiple IPAMs defined', () => {
    const result = getIpamBasePool('us-west-pool', multipleIpams);
    expect(result).toEqual(['10.16.0.0/12']);
  });

  test('returns undefined when pool does not exist in any IPAM', () => {
    const result = getIpamBasePool('nonexistent-pool', multipleIpams);
    expect(result).toBeUndefined();
  });

  test('returns undefined when ipamConfig is undefined', () => {
    const result = getIpamBasePool('us-east-pool', undefined);
    expect(result).toBeUndefined();
  });

  test('skips IPAM with no pools array', () => {
    const ipams = [
      { name: 'empty-ipam', region: 'eu-west-1' },
      { name: 'ipam-with-pool', region: 'us-east-1', pools: [{ name: 'target', provisionedCidrs: ['10.0.0.0/8'] }] },
    ] as unknown as IpamConfig[];

    const result = getIpamBasePool('target', ipams);
    expect(result).toEqual(['10.0.0.0/8']);
  });
});
