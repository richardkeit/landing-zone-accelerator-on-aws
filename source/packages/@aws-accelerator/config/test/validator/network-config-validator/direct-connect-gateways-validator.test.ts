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
import { DirectConnectGatewaysValidator } from '../../../validator/network-config-validator/direct-connect-gateways-validator';

describe('DirectConnectGatewaysValidator', () => {
  const baseTransitGateway = {
    name: 'Network-Main',
    account: 'Network',
    region: 'us-east-1',
    asn: 65521,
    dnsSupport: 'enable',
    vpnEcmpSupport: 'enable',
    defaultRouteTableAssociation: 'disable',
    defaultRouteTablePropagation: 'disable',
    autoAcceptSharingAttachments: 'enable',
    routeTables: [{ name: 'Network-Main-Core', routes: [], tags: [] }],
    tags: [],
  };

  const baseDxGateway = {
    name: 'test-dxgw',
    account: 'Network',
    asn: 64512,
    gatewayName: 'test-dxgw-gw',
  };

  test('should produce a clear error when TGW association references a non-existent transit gateway', () => {
    const errors: string[] = [];

    new DirectConnectGatewaysValidator(
      {
        transitGateways: [baseTransitGateway],
        directConnectGateways: [
          {
            ...baseDxGateway,
            transitGatewayAssociations: [
              {
                name: 'Fake-TGW-Name',
                account: 'Network',
                allowedPrefixes: ['1.1.1.1/32'],
                routeTableAssociations: ['Network-Main-Core'],
                routeTablePropagations: ['Network-Main-Core'],
              },
            ],
          },
        ],
      } as unknown as NetworkConfig,
      errors,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cannot find matching transit gateway');
    expect(errors[0]).toContain('Fake-TGW-Name');
  });

  test('should not throw when TGW association references a valid transit gateway', () => {
    const errors: string[] = [];

    new DirectConnectGatewaysValidator(
      {
        transitGateways: [baseTransitGateway],
        directConnectGateways: [
          {
            ...baseDxGateway,
            transitGatewayAssociations: [
              {
                name: 'Network-Main',
                account: 'Network',
                allowedPrefixes: ['10.0.0.0/8'],
              },
            ],
          },
        ],
      } as unknown as NetworkConfig,
      errors,
    );

    expect(errors).toHaveLength(0);
  });

  test('should catch matching ASNs between DX gateway and transit gateway', () => {
    const errors: string[] = [];

    new DirectConnectGatewaysValidator(
      {
        transitGateways: [{ ...baseTransitGateway, asn: 64512 }],
        directConnectGateways: [
          {
            ...baseDxGateway,
            asn: 64512,
            transitGatewayAssociations: [
              {
                name: 'Network-Main',
                account: 'Network',
                allowedPrefixes: ['10.0.0.0/8'],
              },
            ],
          },
        ],
      } as unknown as NetworkConfig,
      errors,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('DX Gateway ASN and TGW ASN match');
  });

  test('should catch cross-account associations with route table configs', () => {
    const errors: string[] = [];

    new DirectConnectGatewaysValidator(
      {
        transitGateways: [{ ...baseTransitGateway, account: 'SharedServices' }],
        directConnectGateways: [
          {
            ...baseDxGateway,
            account: 'Network',
            transitGatewayAssociations: [
              {
                name: 'Network-Main',
                account: 'SharedServices',
                allowedPrefixes: ['10.0.0.0/8'],
                routeTableAssociations: ['Network-Main-Core'],
                routeTablePropagations: ['Network-Main-Core'],
              },
            ],
          },
        ],
      } as unknown as NetworkConfig,
      errors,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('association proposals cannot have TGW route table associations or propagations');
  });

  test('should handle multiple TGW associations where some are invalid', () => {
    const errors: string[] = [];

    new DirectConnectGatewaysValidator(
      {
        transitGateways: [baseTransitGateway],
        directConnectGateways: [
          {
            ...baseDxGateway,
            transitGatewayAssociations: [
              {
                name: 'Fake-TGW-1',
                account: 'Network',
                allowedPrefixes: ['1.1.1.1/32'],
              },
              {
                name: 'Network-Main',
                account: 'Network',
                allowedPrefixes: ['10.0.0.0/8'],
              },
              {
                name: 'Fake-TGW-2',
                account: 'Network',
                allowedPrefixes: ['2.2.2.2/32'],
              },
            ],
          },
        ],
      } as unknown as NetworkConfig,
      errors,
    );

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Fake-TGW-1');
    expect(errors[1]).toContain('Fake-TGW-2');
  });
});
