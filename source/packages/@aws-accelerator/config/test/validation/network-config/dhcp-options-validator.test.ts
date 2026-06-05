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
import { describe, expect, it, beforeEach } from 'vitest';
import { DhcpOptionsValidator } from '../../../validator/network-config-validator/dhcp-options-validator';
import { DhcpOptsConfig, NetworkConfig } from '../../../lib/network-config';
import { NetworkValidatorFunctions } from '../../../validator/network-config-validator/network-validator-functions';

describe('DhcpOptionsValidator', () => {
  let helpers: NetworkValidatorFunctions;
  let errors: string[];

  beforeEach(() => {
    const networkConfig = {} as NetworkConfig;
    helpers = new NetworkValidatorFunctions(networkConfig, ['Root'], [], [], ['us-east-1', 'us-west-2']);
    errors = [];
  });

  /**
   * Helper to invoke the private validateDomainName method directly.
   */
  const validateDomainName = (set: DhcpOptsConfig) => {
    const validator = Object.create(DhcpOptionsValidator.prototype) as DhcpOptionsValidator;
    validator['validateDomainName'](set, helpers, errors);
  };

  describe('validateDomainName', () => {
    it('accepts a single domain name', () => {
      const set = { name: 'test', regions: ['us-east-1'], domainName: 'example.com' } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(0);
    });

    it('accepts multiple space-separated domain names', () => {
      const set = {
        name: 'test',
        regions: ['us-east-1'],
        domainName: 'example.com example.org',
      } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(0);
    });

    it('accepts an undefined domain name', () => {
      const set = { name: 'test', regions: ['us-east-1'] } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(0);
    });

    it('accepts a previously rejected value without a TLD', () => {
      const set = { name: 'test', regions: ['us-east-1'], domainName: 'internal' } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(0);
    });

    it('rejects Amazon-provided regional domain name deployed to multiple regions', () => {
      const set = {
        name: 'test',
        regions: ['us-east-1', 'us-west-2'],
        domainName: 'ec2.internal',
      } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('specified Amazon-provided regional domain name');
    });

    it('rejects compute.internal regional domain name deployed to multiple regions', () => {
      const set = {
        name: 'test',
        regions: ['us-east-1', 'us-west-2'],
        domainName: 'us-west-2.compute.internal',
      } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('specified Amazon-provided regional domain name');
    });

    it('accepts a custom domain name deployed to multiple regions', () => {
      const set = {
        name: 'test',
        regions: ['us-east-1', 'us-west-2'],
        domainName: 'example.com',
      } as DhcpOptsConfig;
      validateDomainName(set);
      expect(errors).toHaveLength(0);
    });
  });
});
