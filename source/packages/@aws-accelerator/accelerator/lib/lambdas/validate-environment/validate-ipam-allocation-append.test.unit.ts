import { describe, expect, test } from 'vitest';
import { isIpamAllocationsAppendOnlyValid, isIpamAllocationConfig, isIpamAllocationConfigArray } from './index';

describe('function isIpamAllocationsAppendOnlyValid', () => {
  type Token = string;
  type Tokens = Token[];
  type TestCase = [Tokens | undefined, Tokens | undefined];

  const passingCases: TestCase[] = [
    [[], ['poolA|25']], // no history yet
    [['poolA|25'], ['poolA|25']], // no change
    [['poolA|25'], ['poolA|25', 'poolA|26']], // append
    [
      ['poolA|25', 'poolB|26'],
      ['poolA|25', 'poolB|26', 'poolA|27'],
    ], // append
  ];

  const failingCases: TestCase[] = [
    [['poolA|25'], ['poolA|26']], // modify primary
    [['poolA|25'], ['poolB|25', 'poolA|25']], // insert at start
    [['poolA|25', 'poolA|26'], ['poolA|25']], // delete
    [
      ['poolA|25', 'poolA|26'],
      ['poolA|25', 'poolB|26'],
    ], // modify existing
    [
      ['poolA|25', 'poolA|26'],
      ['poolA|25', 'poolB|27', 'poolA|26'],
    ], // insert middle
    [
      ['poolA|25', 'poolB|26'],
      ['poolB|26', 'poolA|25'],
    ], // reorder
  ];

  passingCases.forEach(([deployed, toBe]) =>
    test(`${JSON.stringify(deployed)} -> ${JSON.stringify(toBe)}`, () => {
      expect(isIpamAllocationsAppendOnlyValid('test', deployed || [], toBe || [])).toBe(true);
    }),
  );

  failingCases.forEach(([deployed, toBe]) =>
    test(`${JSON.stringify(deployed)} -> ${JSON.stringify(toBe)}`, () => {
      expect(isIpamAllocationsAppendOnlyValid('test', deployed || [], toBe || [])).toBe(false);
    }),
  );
});

describe('function isIpamAllocationConfigArray', () => {
  test('should accept a valid array', () => {
    const value = [
      {
        vpcName: 'Network/Network-Endpoints',
        logicalId: 'SsmParamNetworkVpcNetworkEndpointsDeployedIpamAllocations',
        ipamAllocations: [
          { ipamPoolName: 'home-region-prod-pool', netmaskLength: 25 },
          { ipamPoolName: 'home-region-prod-pool', netmaskLength: 26 },
        ],
        parameterName: '/accelerator/validation/Network/network/vpc/Network/deployedIpamAllocations',
      },
    ];
    expect(isIpamAllocationConfigArray(value)).toBe(true);
  });
});

describe('function isIpamAllocationConfig', () => {
  test('should accept a valid object', () => {
    const value = {
      vpcName: 'Network/Network-Endpoints',
      logicalId: 'SsmParamNetworkVpcNetworkEndpointsDeployedIpamAllocations',
      ipamAllocations: [{ ipamPoolName: 'home-region-prod-pool', netmaskLength: 25 }],
      parameterName: '/accelerator/validation/Network/network/vpc/Network/deployedIpamAllocations',
    };
    expect(isIpamAllocationConfig(value)).toBe(true);
  });
});
