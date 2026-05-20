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

import { describe, test } from 'vitest';
import * as fc from 'fast-check';
import {
  InterfaceEndpointConfig,
  InterfaceEndpointServiceConfig,
  NetworkConfig,
  VpcConfig,
} from '../../../lib/network-config';
import { VpcValidator } from '../../../validator/network-config-validator/vpc-validator';
import { NetworkValidatorFunctions } from '../../../validator/network-config-validator/network-validator-functions';

/**
 * Build a minimal NetworkConfig fixture carrying a single VPC with one
 * interface endpoint whose `hostedZoneName` is set to the given string.
 *
 * The VPC has a static CIDR (so `validateVpcStructure` passes and the
 * downstream interface-endpoint validations — including the 1024-character
 * hostedZoneName length check — actually run). The `interfaceEndpoints`
 * `defaultPolicy` matches the single fixture policy name so we do not trip
 * the unrelated "defaultPolicy does not exist" error.
 */
function buildFixture(params: { vpcName: string; endpointService: string; hostedZoneName: string }): {
  networkConfig: NetworkConfig;
  helpers: NetworkValidatorFunctions;
} {
  const { vpcName, endpointService, hostedZoneName } = params;

  const endpoint: Partial<InterfaceEndpointServiceConfig> = {
    service: endpointService,
    hostedZoneName,
  };

  const interfaceEndpoints: Partial<InterfaceEndpointConfig> = {
    defaultPolicy: 'Default',
    endpoints: [endpoint as InterfaceEndpointServiceConfig],
    subnets: [],
  };

  const vpc: Partial<VpcConfig> = {
    name: vpcName,
    account: 'Network',
    region: 'us-east-1',
    cidrs: ['10.0.0.0/16'],
    interfaceEndpoints: interfaceEndpoints as InterfaceEndpointConfig,
  };

  const networkConfig: Partial<NetworkConfig> = {
    defaultVpc: { delete: false, excludeAccounts: [], excludeRegions: [] },
    transitGateways: [],
    endpointPolicies: [{ name: 'Default', document: 'path/to/policy.json' }],
    vpcs: [vpc as VpcConfig],
  };

  const helpers = new NetworkValidatorFunctions(
    networkConfig as NetworkConfig,
    ['Root'],
    [
      {
        name: 'Network',
        description: '',
        email: 'network@example.com',
        organizationalUnit: 'Infrastructure',
        warm: true,
        accountAlias: undefined,
      },
    ],
    [],
    ['us-east-1'],
  );

  return { networkConfig: networkConfig as NetworkConfig, helpers };
}

describe('VpcValidator - interface endpoint hostedZoneName length', () => {
  // Feature: route53-interface-endpoint-phz-override, Property 10: Schema rejects hostedZoneName longer than 1024 characters
  test('Property 10: validator rejects hostedZoneName longer than 1024 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1025, maxLength: 2048 }),
        fc.constantFrom('route53', 'ec2', 's3', 'logs', 'kms'),
        fc.constantFrom('network-endpoints-vpc', 'endpoint-vpc', 'central-vpc'),
        (hostedZoneName: string, endpointService: string, vpcName: string) => {
          const errors: string[] = [];
          const { networkConfig, helpers } = buildFixture({
            vpcName,
            endpointService,
            hostedZoneName,
          });

          new VpcValidator(networkConfig, helpers, errors);

          // At least one accumulated error must cite the 1024-character limit
          // and identify the offending endpoint (VPC name or endpoint service).
          const lengthErrors = errors.filter(
            e => e.includes('1024') && (e.includes(vpcName) || e.includes(endpointService)),
          );

          if (lengthErrors.length === 0) {
            // Produce a diagnostic counterexample on failure.
            throw new Error(
              `Expected at least one error whose text contains '1024' and identifies ` +
                `the offending endpoint (VPC name '${vpcName}' or service '${endpointService}'). ` +
                `hostedZoneName.length=${hostedZoneName.length}, errors=${JSON.stringify(errors)}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // T16 boundary cases — Requirement 1.5. No PBT: two deterministic examples
  // pinned to the exact 1024 / 1025 transition defined by the Route 53
  // CreateHostedZone API Name limit.
  test('T16: validator accepts hostedZoneName of exactly 1024 characters (no length-related error)', () => {
    const errors: string[] = [];
    const { networkConfig, helpers } = buildFixture({
      vpcName: 'network-endpoints-vpc',
      endpointService: 'route53',
      hostedZoneName: 'a'.repeat(1024),
    });

    new VpcValidator(networkConfig, helpers, errors);

    // The 1024-character value sits on the accept side of the boundary — no
    // accumulated error should reference the 1024 token (other unrelated
    // errors are tolerated).
    const lengthErrors = errors.filter(e => e.includes('1024'));
    if (lengthErrors.length !== 0) {
      throw new Error(
        `Expected zero errors containing '1024' for a 1024-character hostedZoneName. ` +
          `errors=${JSON.stringify(lengthErrors)}`,
      );
    }
  });

  test('T16: validator rejects hostedZoneName of 1025 characters with an error citing the 1024 limit', () => {
    const errors: string[] = [];
    const { networkConfig, helpers } = buildFixture({
      vpcName: 'network-endpoints-vpc',
      endpointService: 'route53',
      hostedZoneName: 'a'.repeat(1025),
    });

    new VpcValidator(networkConfig, helpers, errors);

    // The 1025-character value sits one past the boundary — at least one
    // accumulated error must cite the 1024-character limit.
    const lengthErrors = errors.filter(e => e.includes('1024'));
    if (lengthErrors.length === 0) {
      throw new Error(
        `Expected at least one error containing '1024' for a 1025-character hostedZoneName. ` +
          `errors=${JSON.stringify(errors)}`,
      );
    }
  });
});
