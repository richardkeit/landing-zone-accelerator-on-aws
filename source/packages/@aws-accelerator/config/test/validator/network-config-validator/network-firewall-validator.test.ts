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
 * Tests targeting NetworkFirewallValidator.validatePolicyRuleGroupReferences.
 *
 * Reproduces the false-positive missing-rule error described in
 * GitHub issue awslabs/landing-zone-accelerator-on-aws#1112 and locks in
 * the disambiguated stateful/stateless missing-rule error wording.
 */
describe('NetworkFirewallValidator', () => {
  /**
   * Build a minimal NetworkConfig-shaped fixture sufficient to drive
   * NetworkFirewallValidator end-to-end without tripping unrelated
   * validation paths (vpcs, vpcTemplates, firewalls all empty).
   */
  function buildConfig(opts: { policies: unknown[]; rules: unknown[]; regions?: string[] }): NetworkConfig {
    const regions = opts.regions ?? ['us-east-1'];
    return {
      vpcs: [],
      vpcTemplates: [],
      centralNetworkServices: {
        delegatedAdminAccount: 'Network',
        networkFirewall: {
          firewalls: [],
          policies: opts.policies,
          rules: opts.rules,
        },
      },
      // Convenience: not used by the firewall validator but referenced
      // when a downstream helper needs a default region list.
      _testRegions: regions,
    } as unknown as NetworkConfig;
  }

  /**
   * Build the NetworkValidatorFunctions helper with a single Network
   * account in the Infrastructure OU and us-east-1 as the only enabled
   * region. Mirrors the construction used by sibling tests.
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

  /**
   * Run NetworkFirewallValidator against a config and return the
   * accumulated errors array. configDir is set to a non-existent path;
   * the Suricata file check only runs when a rule sets rulesFile, which
   * none of the test fixtures do.
   */
  function runValidator(config: NetworkConfig, helpers: NetworkValidatorFunctions): string[] {
    const errors: string[] = [];
    new NetworkFirewallValidator(config, '/tmp/lza-test', helpers, errors);
    return errors;
  }

  // --------------------------------------------------------------------
  // Shared fixture fragments
  // --------------------------------------------------------------------

  /** Base firewall policy with required default actions, no strict-order machinery. */
  const baseFirewallPolicy = {
    statelessDefaultActions: ['aws:forward_to_sfe'],
    statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
  };

  /** Strict-order policy fragment — needed whenever a stateful priority is set. */
  const strictOrderPolicy = {
    ...baseFirewallPolicy,
    statefulDefaultActions: ['aws:drop_strict'],
    statefulEngineOptions: 'STRICT_ORDER',
  };

  /** Minimal stateless rule group definition that survives validateRuleGroupRules. */
  function makeStatelessRule(name: string, regions: string[] = ['us-east-1']) {
    return {
      name,
      regions,
      capacity: 100,
      type: 'STATELESS',
      ruleGroup: {
        rulesSource: {
          statelessRulesAndCustomActions: {
            statelessRules: [
              {
                priority: 1,
                ruleDefinition: {
                  actions: ['aws:pass'],
                  matchAttributes: {},
                },
              },
            ],
          },
        },
      },
    };
  }

  /** Minimal stateful rule group definition that survives validateRuleGroupRules. */
  function makeStatefulRule(name: string, regions: string[] = ['us-east-1']) {
    return {
      name,
      regions,
      capacity: 100,
      type: 'STATEFUL',
      ruleGroup: {
        rulesSource: {
          rulesString: 'alert tcp any any -> any any (msg:"x"; sid:1; rev:1;)',
        },
      },
    };
  }

  describe('validatePolicyRuleGroupReferences', () => {
    // ------------------------------------------------------------------
    // T1: managed stateful ref + statelessRuleGroups: []
    // Pre-fix: false 'does not exist' error on the managed name (RED).
    // Post-fix: no such error.
    // ------------------------------------------------------------------
    test('T1: managed stateful with statelessRuleGroups: [] does not raise a missing-rule error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...strictOrderPolicy,
          statelessRuleGroups: [],
          statefulRuleGroups: [{ managedStatefulRuleGroupName: 'AttackInfrastructureStrictOrder', priority: 100 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const missingRuleErrors = errors.filter(e => e.includes('"AttackInfrastructureStrictOrder" does not exist'));
      expect(missingRuleErrors).toEqual([]);
    });

    // ------------------------------------------------------------------
    // T2: managed stateful ref + populated statelessRuleGroups
    // Pre-fix: false 'does not exist' error on the managed name (RED).
    // Post-fix: no such error.
    // ------------------------------------------------------------------
    test('T2: managed stateful with populated statelessRuleGroups does not raise a missing-rule error on the managed name', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...strictOrderPolicy,
          statelessRuleGroups: [{ name: 'my-stateless', priority: 1 }],
          statefulRuleGroups: [{ managedStatefulRuleGroupName: 'AttackInfrastructureStrictOrder', priority: 100 }],
        },
      };

      const config = buildConfig({
        policies: [policy],
        rules: [makeStatelessRule('my-stateless')],
      });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const missingRuleErrors = errors.filter(e => e.includes('"AttackInfrastructureStrictOrder" does not exist'));
      expect(missingRuleErrors).toEqual([]);
    });

    // ------------------------------------------------------------------
    // T3: managed stateful ref, no statelessRuleGroups key at all
    // Pre-existing correct behavior — must remain GREEN.
    // ------------------------------------------------------------------
    test('T3: managed stateful with no statelessRuleGroups key raises no missing-rule error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...strictOrderPolicy,
          statefulRuleGroups: [{ managedStatefulRuleGroupName: 'AttackInfrastructureStrictOrder', priority: 100 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const missingRuleErrors = errors.filter(e => e.includes('does not exist'));
      expect(missingRuleErrors).toEqual([]);
    });

    // ------------------------------------------------------------------
    // T4: custom stateful ref to a missing rule (and no managed names)
    // Pre-fix: emits 'rule group "no-such-rule" does not exist' (passes
    //         the does-not-exist substring check).
    // Post-fix: emits 'stateful rule group "no-such-rule" does not exist'
    //         (still passes the substring check; T8 locks the new wording).
    // ------------------------------------------------------------------
    test('T4: custom stateful ref to a missing rule raises a does-not-exist error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...strictOrderPolicy,
          statefulRuleGroups: [{ name: 'no-such-rule', priority: 100 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const missingRuleErrors = errors.filter(e => e.includes('"no-such-rule" does not exist'));
      expect(missingRuleErrors.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // T5: stateless ref to a missing rule
    // Pre-fix: emits 'rule group "no-such-rule" does not exist' (passes
    //         the does-not-exist substring check).
    // Post-fix: emits exactly one 'stateless rule group "no-such-rule"
    //         does not exist'; T9 locks the new wording.
    // ------------------------------------------------------------------
    test('T5: stateless ref to a missing rule raises exactly one does-not-exist error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...baseFirewallPolicy,
          statelessRuleGroups: [{ name: 'no-such-rule', priority: 1 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const missingRuleErrors = errors.filter(e => e.includes('"no-such-rule" does not exist'));
      expect(missingRuleErrors.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // T6: custom stateful ref to a real rule whose region does not cover
    //     the policy region. Must preserve the region-mismatch error
    //     verbatim (string is unchanged by the fix).
    // ------------------------------------------------------------------
    test('T6: custom stateful ref to a real rule with mismatched region preserves the region-mismatch error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...baseFirewallPolicy,
          statefulRuleGroups: [{ name: 'my-stateful' }],
        },
      };

      const config = buildConfig({
        policies: [policy],
        rules: [makeStatefulRule('my-stateful', ['eu-west-1'])],
      });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const regionErrors = errors.filter(e => e.includes('is not deployed to one or more region(s)'));
      expect(regionErrors.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // T7: stateful policy reference to a STATELESS rule. Must preserve
    //     the type-mismatch error verbatim.
    // ------------------------------------------------------------------
    test('T7: stateful ref to a STATELESS rule preserves the type-mismatch error', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...baseFirewallPolicy,
          statefulRuleGroups: [{ name: 'mismatch' }],
        },
      };

      const config = buildConfig({
        policies: [policy],
        rules: [makeStatelessRule('mismatch')],
      });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const typeMismatchErrors = errors.filter(e => e.includes('is not configured as a STATEFUL rule group type'));
      expect(typeMismatchErrors.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // T8: disambiguation — missing stateful ref error must contain
    //     'stateful rule group "<N>" does not exist'.
    // Pre-fix: substring absent (RED). Post-fix: present.
    // ------------------------------------------------------------------
    test('T8: missing stateful ref error contains the disambiguating "stateful rule group" wording', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...strictOrderPolicy,
          statefulRuleGroups: [{ name: 'no-such-rule', priority: 100 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const disambiguatedErrors = errors.filter(e => e.includes('stateful rule group "no-such-rule" does not exist'));
      expect(disambiguatedErrors.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // T9: disambiguation — missing stateless ref error must contain
    //     'stateless rule group "<N>" does not exist'.
    // Pre-fix: substring absent (RED). Post-fix: present.
    // ------------------------------------------------------------------
    test('T9: missing stateless ref error contains the disambiguating "stateless rule group" wording', () => {
      const policy = {
        name: 'example-policy',
        regions: ['us-east-1'],
        firewallPolicy: {
          ...baseFirewallPolicy,
          statelessRuleGroups: [{ name: 'no-such-rule', priority: 1 }],
        },
      };

      const config = buildConfig({ policies: [policy], rules: [] });
      const helpers = buildHelpers(config);
      const errors = runValidator(config, helpers);

      const disambiguatedErrors = errors.filter(e => e.includes('stateless rule group "no-such-rule" does not exist'));
      expect(disambiguatedErrors.length).toBe(1);
    });
  });
});
