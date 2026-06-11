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
import { NetworkConfig } from '../../../lib/network-config';
import { NetworkFirewallValidator } from '../../../validator/network-config-validator/network-firewall-validator';
import { NetworkValidatorFunctions } from '../../../validator/network-config-validator/network-validator-functions';

/**
 * Tests targeting NetworkFirewallValidator rule variable portSet validation.
 *
 * Locks in the fix for GitHub issue awslabs/landing-zone-accelerator-on-aws#1123
 * (GitLab #4721): Network Firewall rule variable portSets must accept port ranges
 * using colon notation (e.g. "1024:2048") in addition to single ports, matching
 * the AWS Network Firewall API and Console behaviour.
 */
describe('NetworkFirewallValidator rule variable portSets', () => {
  /**
   * Build a minimal NetworkConfig-shaped fixture that exercises only the
   * rule variable validation path. A single STATEFUL rule group is created
   * with the provided ruleVariables; firewalls, policies, vpcs are empty so
   * no unrelated validation paths fire.
   */
  function buildConfig(ruleVariables: unknown): NetworkConfig {
    return {
      vpcs: [],
      vpcTemplates: [],
      centralNetworkServices: {
        delegatedAdminAccount: 'Network',
        networkFirewall: {
          firewalls: [],
          policies: [],
          rules: [
            {
              name: 'test-rule-group',
              regions: ['us-east-1'],
              capacity: 100,
              type: 'STATEFUL',
              ruleGroup: {
                rulesSource: {
                  rulesString: 'alert tcp any any -> any any (msg:"x"; sid:1; rev:1;)',
                },
                ruleVariables,
              },
            },
          ],
        },
      },
    } as unknown as NetworkConfig;
  }

  /**
   * Build the NetworkValidatorFunctions helper with a single Network account
   * in the Infrastructure OU and us-east-1 as the only enabled region.
   */
  function buildHelpers(config: NetworkConfig): NetworkValidatorFunctions {
    return new NetworkValidatorFunctions(
      config,
      ['Root', 'Infrastructure'],
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
  }

  /** Run the validator and return accumulated errors. */
  function runValidator(config: NetworkConfig): string[] {
    const helpers = buildHelpers(config);
    const errors: string[] = [];
    new NetworkFirewallValidator(config, '/tmp/lza-test', helpers, errors);
    return errors;
  }

  /** Convenience: build ruleVariables with a single ipSets+portSets definition. */
  function ruleVariables(portDefinition: string[], ipDefinition: string[] = ['10.0.0.0/16']) {
    return {
      ipSets: { name: 'HOME_NET', definition: ipDefinition },
      portSets: { name: 'CUSTOM_PORTS', definition: portDefinition },
    };
  }

  /** Filter errors to only those referencing the CUSTOM_PORTS rule variable. */
  function portErrors(errors: string[]): string[] {
    return errors.filter(e => e.includes('rule variable CUSTOM_PORTS'));
  }

  // --------------------------------------------------------------------
  // Backward compatibility: single ports must keep working
  // --------------------------------------------------------------------

  test('accepts a single port', () => {
    const errors = runValidator(buildConfig(ruleVariables(['80'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts multiple single ports', () => {
    const errors = runValidator(buildConfig(ruleVariables(['80', '443', '8080'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts the boundary ports 0 and 65535', () => {
    const errors = runValidator(buildConfig(ruleVariables(['0', '65535'])));
    expect(portErrors(errors)).toEqual([]);
  });

  // --------------------------------------------------------------------
  // New behaviour: port ranges using colon notation
  // --------------------------------------------------------------------

  test('accepts a port range using colon notation', () => {
    const errors = runValidator(buildConfig(ruleVariables(['1024:2048'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts the ephemeral port range 49152:65535', () => {
    const errors = runValidator(buildConfig(ruleVariables(['49152:65535'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts a mixed array of single ports and ranges', () => {
    const errors = runValidator(buildConfig(ruleVariables(['54', '55', '68:100'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts the example from the feature request (CUSTOM_PORTS + EPHEMERAL_PORTS)', () => {
    const config = buildConfig({
      ipSets: { name: 'HOME_NET', definition: ['10.0.0.0/16'] },
      portSets: [
        { name: 'CUSTOM_PORTS', definition: ['54', '55', '68:100'] },
        { name: 'EPHEMERAL_PORTS', definition: ['49152:65535'] },
      ],
    });
    const errors = runValidator(config);
    expect(errors.filter(e => e.includes('rule variable CUSTOM_PORTS'))).toEqual([]);
    expect(errors.filter(e => e.includes('rule variable EPHEMERAL_PORTS'))).toEqual([]);
  });

  test('accepts a range at the lower boundary 0:0', () => {
    const errors = runValidator(buildConfig(ruleVariables(['0:0'])));
    expect(portErrors(errors)).toEqual([]);
  });

  test('accepts a range spanning the full port space 0:65535', () => {
    const errors = runValidator(buildConfig(ruleVariables(['0:65535'])));
    expect(portErrors(errors)).toEqual([]);
  });

  // --------------------------------------------------------------------
  // Invalid range bounds: start > end
  // --------------------------------------------------------------------

  test('rejects a range where fromPort is greater than toPort', () => {
    const errors = runValidator(buildConfig(ruleVariables(['2048:1024'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('fromPort is greater than toPort');
  });

  // --------------------------------------------------------------------
  // Out of range bounds for ranges
  // --------------------------------------------------------------------

  test('rejects a range whose toPort exceeds 65535', () => {
    const errors = runValidator(buildConfig(ruleVariables(['1024:70000'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('toPort is outside range 0-65535');
  });

  test('rejects a range whose fromPort exceeds 65535', () => {
    // 70000:70001 -> both bounds out of range (fromPort <= toPort), so both fire
    const errors = runValidator(buildConfig(ruleVariables(['70000:70001'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(2);
    expect(matching.some(e => e.includes('fromPort is outside range 0-65535'))).toBe(true);
    expect(matching.some(e => e.includes('toPort is outside range 0-65535'))).toBe(true);
  });

  // --------------------------------------------------------------------
  // Out of range bounds for single ports (existing behaviour preserved)
  // --------------------------------------------------------------------

  test('rejects a single port above 65535', () => {
    const errors = runValidator(buildConfig(ruleVariables(['70000'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('invalid port "70000"');
  });

  // --------------------------------------------------------------------
  // Malformed input
  // --------------------------------------------------------------------

  test('rejects a non-numeric port', () => {
    const errors = runValidator(buildConfig(ruleVariables(['abc'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('invalid port "abc"');
  });

  test('rejects a non-numeric range bound', () => {
    const errors = runValidator(buildConfig(ruleVariables(['abc:100'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('invalid port "abc:100"');
  });

  test('rejects a range with three parts', () => {
    const errors = runValidator(buildConfig(ruleVariables(['80:90:100'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('invalid port "80:90:100"');
  });

  test('rejects an empty port string', () => {
    const errors = runValidator(buildConfig(ruleVariables(['80', ''])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain('invalid port ""');
  });

  // --------------------------------------------------------------------
  // Multiple invalid entries each produce their own error
  // --------------------------------------------------------------------

  test('reports an error for each invalid entry in a mixed array', () => {
    // valid 80, invalid range 2048:1024, valid 68:100, invalid 70000
    const errors = runValidator(buildConfig(ruleVariables(['80', '2048:1024', '68:100', '70000'])));
    const matching = portErrors(errors);
    expect(matching.length).toBe(2);
  });

  // --------------------------------------------------------------------
  // ipSets validation must remain intact (regression guard)
  // --------------------------------------------------------------------

  test('still rejects an invalid CIDR in ipSets while accepting a port range', () => {
    const errors = runValidator(buildConfig(ruleVariables(['1024:2048'], ['not-a-cidr'])));
    expect(portErrors(errors)).toEqual([]);
    expect(errors.filter(e => e.includes('rule variable HOME_NET'))).toHaveLength(1);
  });
});
