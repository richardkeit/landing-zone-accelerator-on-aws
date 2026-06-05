/**
 * Regression coverage for the resourcePath-undefined bug fixed in this change
 * (LZA-1524 / SIM V2236529633).
 *
 * Pre-fix: when an ASEA-migrated environment defines a `transitGatewayPeering`
 * between an ASEA-owned TGW and an LZA-native TGW in an account that was never
 * part of ASEA, the ASEA `templateMap` does not contain a `SharedNetwork-Phase0`
 * (or Phase1) stack entry for the non-ASEA side. The pre-fix code passed the
 * `undefined` mapping straight into `ImportStackResources.initSync`, which read
 * `props.stackMapping.resourcePath` and threw:
 *
 *   TypeError: Cannot read properties of undefined (reading 'resourcePath')
 *     at Function.initSync (import-stack-resources.ts:61:96)
 *     at TransitGatewayRoutes.setGlobalTgwPeeringResourceMaps
 *     at new TransitGatewayRoutes
 *     at new ImportAseaResourcesStack
 *
 * The fix guards each ASEA-mapping lookup (requester Phase0, peering-attachment
 * Phase1, accepter Phase0) with an `if (mapping)` check before calling
 * `ImportStackResources.initSync`, mirroring the pattern already in place in
 * the sibling `transit-gateway-peering-attachments.ts` (line 102).
 *
 * Approach:
 * - Invoke `setGlobalTgwPeeringResourceMaps` via prototype binding against a
 *   minimal `this`-shaped stub so we don't have to construct a full
 *   `ImportAseaResourcesStack` scope. This is the same technique the existing
 *   `tgw-cross-account-resources.test.ts` uses.
 * - Spy on `ImportStackResources.initSync` so we can assert it is NOT invoked
 *   when the corresponding mapping is undefined. If the guard regresses,
 *   `initSync` gets called with `undefined`, throws, and the test fails loudly.
 */

import { ASEAMapping, ASEAMappings, TransitGatewayPeeringConfig } from '@aws-accelerator/config';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { TransitGatewayRoutes } from '../../../lib/asea-resources/transit-gateway-routes';
import { ImportStackResources } from '../../../utils/import-stack-resources';

// Bind the private method onto a minimal `this`-shaped stub. Cast through unknown
// because `setGlobalTgwPeeringResourceMaps` is declared `private` on the class.
type SetGlobalTgwPeeringResourceMapsFn = (
  this: unknown,
  tgwPeeringConfig: TransitGatewayPeeringConfig,
  aseaPrefix: string,
  mappings: ASEAMappings,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any,
) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = TransitGatewayRoutes.prototype as any;
const setGlobalTgwPeeringResourceMaps: SetGlobalTgwPeeringResourceMapsFn = proto.setGlobalTgwPeeringResourceMaps;

const ASEA_PREFIX = 'ASEA';
const REQUESTER_ACCOUNT_ID = '111111111111';
const ACCEPTER_ACCOUNT_ID = '222222222222';
const NEW_LZA_ACCOUNT_ID = '999999999999';

const peeringConfig = {
  name: 't0445_peering_Main_tgw',
  requester: {
    transitGatewayName: 'Main_tgw',
    account: 'shared-network',
    region: 'ca-central-1',
    routeTableAssociations: 'Main_tgw_peering_t0445_rt',
  },
  accepter: {
    transitGatewayName: '0445_tgw',
    account: '0445-reseautique',
    region: 'ca-central-1',
    routeTableAssociations: 't0445_peering_Main_tgw_rt',
    autoAccept: true,
    applyTags: true,
  },
} as unknown as TransitGatewayPeeringConfig;

function makeMapping(stackName: string, accountId: string, region: string): ASEAMapping {
  return {
    accountId,
    accountKey: 'fake',
    region,
    stackName,
    phase: stackName.includes('Phase1') ? '1' : '0',
    countVerified: true,
    numberOfResources: 0,
    numberOfResourcesInTemplate: 0,
    templatePath: 'unused',
    resourcePath: 'unused',
    nestedStacks: {},
    cfnResources: [],
  } as unknown as ASEAMapping;
}

function makeThis(opts: { requesterAccount: string; accepterAccount: string; recordedLogs: string[] }): unknown {
  return {
    props: {
      accountsConfig: {
        getAccountId: (accountKey: string) => {
          if (accountKey === 'shared-network') return opts.requesterAccount;
          if (accountKey === '0445-reseautique') return opts.accepterAccount;
          throw new Error(`unexpected account key in test: ${accountKey}`);
        },
      },
    },
    allGlobalRouteTables: [],
    allGlobalTgwPeeringAttachments: [],
    transitGatewayGlobalRouteTables: new Map<string, string>(),
    transitGatewayPeeringAttachments: new Map<string, string>(),
    scope: {
      addLogs: (_level: unknown, message: string) => {
        opts.recordedLogs.push(message);
      },
    },
  };
}

const propsForStack = {
  stackInfo: {
    accountId: REQUESTER_ACCOUNT_ID, // peering-attachment Phase1 lives in the requester account
  },
};

describe('TransitGatewayRoutes.setGlobalTgwPeeringResourceMaps', () => {
  let initSyncSpy: MockInstance;

  beforeEach(() => {
    // Real initSync touches the filesystem. Replace with a stub that returns an
    // object whose `getResourcesByType` yields an empty array; the post-fix code
    // should still skip non-ASEA sides without ever invoking this.
    initSyncSpy = vi.spyOn(ImportStackResources, 'initSync').mockImplementation(() => {
      return {
        getResourcesByType: () => [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    });
  });

  afterEach(() => {
    initSyncSpy.mockRestore();
  });

  test('regression: does not throw when accepter is a non-ASEA account (LZA-1524)', () => {
    // Customer scenario: requester = ASEA-owned, accepter = LZA-native new account.
    // Pre-fix this threw `Cannot read properties of undefined (reading 'resourcePath')`.
    const mappings: ASEAMappings = {
      [`${REQUESTER_ACCOUNT_ID}|ca-central-1|${ASEA_PREFIX}-SharedNetwork-Phase0`]: makeMapping(
        `${ASEA_PREFIX}-SharedNetwork-Phase0`,
        REQUESTER_ACCOUNT_ID,
        'ca-central-1',
      ),
      [`${REQUESTER_ACCOUNT_ID}|ca-central-1|${ASEA_PREFIX}-SharedNetwork-Phase1`]: makeMapping(
        `${ASEA_PREFIX}-SharedNetwork-Phase1`,
        REQUESTER_ACCOUNT_ID,
        'ca-central-1',
      ),
      // Intentionally NO entry for the new LZA-native accepter account.
    };

    const recordedLogs: string[] = [];
    const ctx = makeThis({
      requesterAccount: REQUESTER_ACCOUNT_ID,
      accepterAccount: NEW_LZA_ACCOUNT_ID,
      recordedLogs,
    });

    expect(() =>
      setGlobalTgwPeeringResourceMaps.call(ctx, peeringConfig, ASEA_PREFIX, mappings, propsForStack),
    ).not.toThrow();

    // Requester Phase0 + Peering-attachment Phase1 mappings exist => initSync called twice.
    // Accepter Phase0 mapping is missing => initSync skipped for that side.
    expect(initSyncSpy).toHaveBeenCalledTimes(2);
    expect(recordedLogs.some(m => m.includes('accepter') && m.includes(NEW_LZA_ACCOUNT_ID))).toBe(true);
  });

  test('regression: does not throw when no peering side exists in ASEA mappings', () => {
    // Both requester and accepter are LZA-native; ASEA templateMap is empty.
    const mappings: ASEAMappings = {};

    const recordedLogs: string[] = [];
    const ctx = makeThis({
      requesterAccount: NEW_LZA_ACCOUNT_ID,
      accepterAccount: NEW_LZA_ACCOUNT_ID,
      recordedLogs,
    });

    expect(() =>
      setGlobalTgwPeeringResourceMaps.call(ctx, peeringConfig, ASEA_PREFIX, mappings, propsForStack),
    ).not.toThrow();

    // Every side missing => initSync must never be invoked (it would crash on undefined).
    expect(initSyncSpy).not.toHaveBeenCalled();
    // One log per skipped side: requester, peering-attachment, accepter.
    expect(recordedLogs.filter(m => m.startsWith('Skipping ASEA TGW'))).toHaveLength(3);
  });

  test('happy path: both sides ASEA-owned still calls initSync for all three lookups', () => {
    const mappings: ASEAMappings = {
      [`${REQUESTER_ACCOUNT_ID}|ca-central-1|${ASEA_PREFIX}-SharedNetwork-Phase0`]: makeMapping(
        `${ASEA_PREFIX}-SharedNetwork-Phase0`,
        REQUESTER_ACCOUNT_ID,
        'ca-central-1',
      ),
      [`${REQUESTER_ACCOUNT_ID}|ca-central-1|${ASEA_PREFIX}-SharedNetwork-Phase1`]: makeMapping(
        `${ASEA_PREFIX}-SharedNetwork-Phase1`,
        REQUESTER_ACCOUNT_ID,
        'ca-central-1',
      ),
      [`${ACCEPTER_ACCOUNT_ID}|ca-central-1|${ASEA_PREFIX}-SharedNetwork-Phase0`]: makeMapping(
        `${ASEA_PREFIX}-SharedNetwork-Phase0`,
        ACCEPTER_ACCOUNT_ID,
        'ca-central-1',
      ),
    };

    const recordedLogs: string[] = [];
    const ctx = makeThis({
      requesterAccount: REQUESTER_ACCOUNT_ID,
      accepterAccount: ACCEPTER_ACCOUNT_ID,
      recordedLogs,
    });

    expect(() =>
      setGlobalTgwPeeringResourceMaps.call(ctx, peeringConfig, ASEA_PREFIX, mappings, propsForStack),
    ).not.toThrow();

    expect(initSyncSpy).toHaveBeenCalledTimes(3);
    expect(recordedLogs.filter(m => m.startsWith('Skipping ASEA TGW'))).toHaveLength(0);
  });
});
