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

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import Ajv from 'ajv';

import { isNetworkType } from '../lib/common';
import { InterfaceEndpointServiceConfig } from '../lib/network-config';
import { IInterfaceEndpointServiceConfig } from '../lib/models/network-config';
import * as networkSchema from '../lib/schemas/network-config.json';

/**
 * Parse an `IInterfaceEndpointServiceConfig` input through the network-config
 * schema and instantiate the runtime class from it. This mirrors the behavior
 * of `NetworkConfig.loadFromString`, which schema-validates the parsed YAML
 * with `parseNetworkConfig` (AJV) and then shallow-copies the validated object
 * tree onto a `NetworkConfig` instance via `Object.assign`.
 */
function parseInterfaceEndpointServiceConfig(input: unknown): InterfaceEndpointServiceConfig {
  if (!isNetworkType<IInterfaceEndpointServiceConfig>('IInterfaceEndpointServiceConfig', input)) {
    throw new Error('Input failed IInterfaceEndpointServiceConfig schema validation');
  }
  return Object.assign(new InterfaceEndpointServiceConfig(), input);
}

describe('InterfaceEndpointServiceConfig', () => {
  // Feature: route53-interface-endpoint-phz-override, Property 1: Parse preserves hostedZoneName
  it('Property 1: parse preserves hostedZoneName for any non-empty string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (hostedZoneName: string) => {
        const input: IInterfaceEndpointServiceConfig = {
          service: 'ec2',
          hostedZoneName,
        };

        const parsed = parseInterfaceEndpointServiceConfig(input);

        expect(parsed.hostedZoneName).toBe(hostedZoneName);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: route53-interface-endpoint-phz-override, Property 2: Parse leaves hostedZoneName undefined when omitted
  it('Property 2: parse leaves hostedZoneName undefined when the key is omitted', () => {
    // Generator: arbitrary valid endpoint entries that never include the `hostedZoneName` key.
    // `service` is required; the remaining optional fields (`serviceName`, `policy`,
    // `applyPolicy`, `securityGroup`) are each independently present or absent.
    // `hostedZoneName` is intentionally excluded from the record shape, so fast-check
    // cannot introduce that key — not even as `undefined`.
    const endpointArb = fc.record(
      {
        service: fc.string({ minLength: 1 }),
        serviceName: fc.string({ minLength: 1 }),
        policy: fc.string({ minLength: 1 }),
        applyPolicy: fc.boolean(),
        securityGroup: fc.string({ minLength: 1 }),
      },
      {
        requiredKeys: ['service'],
      },
    );

    fc.assert(
      fc.property(endpointArb, (input: IInterfaceEndpointServiceConfig) => {
        // Guard the generator invariant: the `hostedZoneName` key must never appear.
        expect(Object.prototype.hasOwnProperty.call(input, 'hostedZoneName')).toBe(false);

        // Parse must not throw a schema validation error.
        const parsed = parseInterfaceEndpointServiceConfig(input);

        expect(parsed.hostedZoneName).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  // Requirement 1.4 — empty hostedZoneName is rejected by the schema,
  // and the rendered error identifies the offending endpoint entry.
  //
  // This is an example test (not a PBT): a single deterministic input with
  // `hostedZoneName: ""` is exercised against the network-config schema.
  // The helper `parseInterfaceEndpointServiceConfig` throws when
  // `isNetworkType` returns `false`, but the thrown error does not carry
  // the per-property path. To assert that the rendered validation error
  // identifies the offending endpoint entry, this test runs AJV directly
  // against the `IInterfaceEndpointServiceConfig` definition so we can
  // inspect the `instancePath` of the resulting error collection.
  it('T3: parse rejects an endpoint entry whose hostedZoneName is an empty string', () => {
    const input: IInterfaceEndpointServiceConfig = {
      service: 'ec2',
      hostedZoneName: '',
    };

    // First assertion: the higher-level helper used by tasks 5.1 / 5.2
    // (which wraps `isNetworkType`) throws a schema validation error.
    expect(() => parseInterfaceEndpointServiceConfig(input)).toThrow(
      /IInterfaceEndpointServiceConfig schema validation/,
    );

    // Second assertion: the schema validator — driven directly via AJV so we
    // can reach the individual error entries — identifies the offending
    // endpoint entry by property path. Under the
    // `IInterfaceEndpointServiceConfig` root the schema path for an empty
    // `hostedZoneName` is `/hostedZoneName`, which both names the offending
    // field on this endpoint entry and disambiguates it from `serviceName`
    // or any other optional `NonEmptyString` field.
    const ajv = new Ajv({ allErrors: true, verbose: true });
    const schemaWithRef = {
      ...(networkSchema as object),
      $ref: '#/definitions/IInterfaceEndpointServiceConfig',
    };
    const valid = ajv.validate(schemaWithRef, input);

    expect(valid).toBe(false);
    expect(ajv.errors).not.toBeNull();
    const hostedZoneNameErrors = (ajv.errors ?? []).filter(e => e.instancePath === '/hostedZoneName');
    expect(hostedZoneNameErrors.length).toBeGreaterThan(0);
    // At least one of those errors must be the `minLength` (NonEmptyString)
    // violation — the schema constraint that rejects the empty string.
    expect(hostedZoneNameErrors.some(e => e.keyword === 'minLength')).toBe(true);
  });
});
