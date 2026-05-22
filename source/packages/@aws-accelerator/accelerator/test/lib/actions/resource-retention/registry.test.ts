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

import { describe, expect, it } from 'vitest';
import { RESOURCE_RETENTION_REGISTRY } from '../../../../lib/actions/resource-retention/registry';
import { AcceleratorStackNames } from '../../../../lib/accelerator';
import { AcceleratorStage } from '../../../../lib/accelerator-stage';
import { AcceleratorModules } from '../../../../lib/types';

describe('RESOURCE_RETENTION_REGISTRY', () => {
  describe('structure validation', () => {
    it('should have entries for all expected stack types', () => {
      const expectedStacks = [
        AcceleratorStackNames[AcceleratorStage.ORGANIZATIONS],
        AcceleratorStackNames[AcceleratorStage.SECURITY_AUDIT],
        AcceleratorStackNames[AcceleratorStage.SECURITY],
        AcceleratorStackNames[AcceleratorStage.NETWORK_ASSOCIATIONS],
      ];

      for (const stackName of expectedStacks) {
        expect(RESOURCE_RETENTION_REGISTRY).toHaveProperty(stackName);
        expect(RESOURCE_RETENTION_REGISTRY[stackName].length).toBeGreaterThan(0);
      }
    });

    it('should have valid service names from AcceleratorModules enum', () => {
      const validModuleNames = Object.values(AcceleratorModules) as string[];

      for (const [, serviceConfigs] of Object.entries(RESOURCE_RETENTION_REGISTRY)) {
        for (const config of serviceConfigs) {
          expect(validModuleNames).toContain(config.serviceName);
        }
      }
    });

    it('should have non-empty resourceTypes arrays for all entries', () => {
      for (const [, serviceConfigs] of Object.entries(RESOURCE_RETENTION_REGISTRY)) {
        for (const config of serviceConfigs) {
          expect(config.resourceTypes.length).toBeGreaterThan(0);
          for (const resourceType of config.resourceTypes) {
            expect(resourceType).toBeTruthy();
            expect(typeof resourceType).toBe('string');
          }
        }
      }
    });

    it('should not have duplicate resource types within a stack prefix', () => {
      for (const [, serviceConfigs] of Object.entries(RESOURCE_RETENTION_REGISTRY)) {
        const allResourceTypes = serviceConfigs.flatMap(c => c.resourceTypes);
        const uniqueTypes = new Set(allResourceTypes);
        expect(uniqueTypes.size).toBe(allResourceTypes.length);
      }
    });
  });

  describe('Macie retention entries', () => {
    it('should register Macie resources in OrganizationsStack', () => {
      const orgStack = RESOURCE_RETENTION_REGISTRY[AcceleratorStackNames[AcceleratorStage.ORGANIZATIONS]];
      const macieEntry = orgStack.find(c => c.serviceName === AcceleratorModules.MACIE);

      expect(macieEntry).toBeDefined();
      expect(macieEntry!.resourceTypes).toContain('Custom::MacieEnableOrganizationAdminAccount');
    });

    it('should register Macie resources in SecurityAuditStack', () => {
      const auditStack = RESOURCE_RETENTION_REGISTRY[AcceleratorStackNames[AcceleratorStage.SECURITY_AUDIT]];
      const macieEntry = auditStack.find(c => c.serviceName === AcceleratorModules.MACIE);

      expect(macieEntry).toBeDefined();
      expect(macieEntry!.resourceTypes).toContain('Custom::MacieCreateMember');
    });

    it('should register Macie resources in SecurityStack', () => {
      const secStack = RESOURCE_RETENTION_REGISTRY[AcceleratorStackNames[AcceleratorStage.SECURITY]];
      const macieEntry = secStack.find(c => c.serviceName === AcceleratorModules.MACIE);

      expect(macieEntry).toBeDefined();
      expect(macieEntry!.resourceTypes).toContain('Custom::MaciePutClassificationExportConfiguration');
    });
  });

  describe('TGW associations and propagations retention entries', () => {
    const networkAssocStackName = AcceleratorStackNames[AcceleratorStage.NETWORK_ASSOCIATIONS];

    it('should register TGW resources in NetworkAssociationsStack', () => {
      const netAssocStack = RESOURCE_RETENTION_REGISTRY[networkAssocStackName];
      expect(netAssocStack).toBeDefined();
      expect(netAssocStack.length).toBeGreaterThan(0);
    });

    it('should use the correct module name', () => {
      const netAssocStack = RESOURCE_RETENTION_REGISTRY[networkAssocStackName];
      const tgwEntry = netAssocStack.find(c => c.serviceName === AcceleratorModules.TGW_ASSOCIATIONS_AND_PROPAGATIONS);

      expect(tgwEntry).toBeDefined();
      expect(tgwEntry!.serviceName).toBe('tgw-associations-and-propagations');
    });

    it('should include AWS::EC2::TransitGatewayRouteTableAssociation', () => {
      const netAssocStack = RESOURCE_RETENTION_REGISTRY[networkAssocStackName];
      const tgwEntry = netAssocStack.find(c => c.serviceName === AcceleratorModules.TGW_ASSOCIATIONS_AND_PROPAGATIONS)!;

      expect(tgwEntry.resourceTypes).toContain('AWS::EC2::TransitGatewayRouteTableAssociation');
    });

    it('should include AWS::EC2::TransitGatewayRouteTablePropagation', () => {
      const netAssocStack = RESOURCE_RETENTION_REGISTRY[networkAssocStackName];
      const tgwEntry = netAssocStack.find(c => c.serviceName === AcceleratorModules.TGW_ASSOCIATIONS_AND_PROPAGATIONS)!;

      expect(tgwEntry.resourceTypes).toContain('AWS::EC2::TransitGatewayRouteTablePropagation');
    });

    it('should have exactly three resource types for TGW entry', () => {
      const netAssocStack = RESOURCE_RETENTION_REGISTRY[networkAssocStackName];
      const tgwEntry = netAssocStack.find(c => c.serviceName === AcceleratorModules.TGW_ASSOCIATIONS_AND_PROPAGATIONS)!;

      expect(tgwEntry.resourceTypes).toHaveLength(3);
    });

    it('should use the correct stack prefix for NetworkAssociationsStack', () => {
      expect(networkAssocStackName).toBe('AWSAccelerator-NetworkAssociationsStack');
      expect(RESOURCE_RETENTION_REGISTRY[networkAssocStackName]).toBeDefined();
    });
  });

  describe('skip environment variable naming', () => {
    it('should produce correct skip env var for TGW module', () => {
      // The retention module builds: constantCase(`skip-${serviceName}`) + '_MODULE'
      // For 'tgw-associations-and-propagations' → 'SKIP_TGW_ASSOCIATIONS_AND_PROPAGATIONS_MODULE'
      const serviceName = AcceleratorModules.TGW_ASSOCIATIONS_AND_PROPAGATIONS;
      // constantCase converts kebab-case to CONSTANT_CASE
      const expectedEnvVar = 'SKIP_TGW_ASSOCIATIONS_AND_PROPAGATIONS_MODULE';
      const computedEnvVar = 'SKIP_' + serviceName.replace(/-/g, '_').toUpperCase() + '_MODULE';

      expect(computedEnvVar).toBe(expectedEnvVar);
    });

    it('should produce correct skip env var for Macie module', () => {
      const serviceName = AcceleratorModules.MACIE;
      const expectedEnvVar = 'SKIP_MACIE_MODULE';
      const computedEnvVar = 'SKIP_' + serviceName.replace(/-/g, '_').toUpperCase() + '_MODULE';

      expect(computedEnvVar).toBe(expectedEnvVar);
    });
  });
});
