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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MODULE_STATE_CODE } from 'aws-lza';
import {
  formatModuleDiff,
  buildDiffFileName,
  writeModuleDiffFile,
  registerDiffFormatter,
} from '../../../../lib/actions/utils/module-diff-formatter';

describe('module-diff-formatter', () => {
  describe('formatModuleDiff', () => {
    it('should format a COMPLETED response', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.COMPLETED,
        summary: '2 change(s) would be made',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'macie',
        dryRun: true,
      });

      expect(result).toContain('Module: macie');
      expect(result).toContain('Mode: Dry Run');
      expect(result).toContain('2 change(s) would be made');
      expect(result).not.toContain('SKIPPED');
      expect(result).not.toContain('FAILED');
    });

    it('should render [+] for created items and [-] for deleted items in response', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.COMPLETED,
        summary: '2 change(s) would be made',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'tgw-associations-and-propagations',
        dryRun: true,
        response: {
          associations: [
            {
              operation: 'created',
              routeTableName: 'rt-firewall',
              attachmentName: 'vpc-egress',
              attachmentType: 'vpc',
              region: 'us-east-1',
              tgwName: 'main-tgw',
            },
            {
              operation: 'exists',
              routeTableName: 'rt-spoke',
              attachmentName: 'vpc-shared',
              attachmentType: 'vpc',
              region: 'us-east-1',
              tgwName: 'main-tgw',
            },
          ],
          propagations: [
            {
              operation: 'deleted',
              routeTableName: 'rt-spoke',
              attachmentName: 'vpc-egress',
              attachmentType: 'vpc',
              region: 'us-east-1',
              tgwName: 'main-tgw',
            },
          ],
        },
      });

      expect(result).toContain('[+]');
      expect(result).toContain('[-]');
      expect(result).toContain('[~] 1 unchanged');
      expect(result).toContain('Associations:');
      expect(result).toContain('Propagations:');
    });

    it('should render [+] for enabled and [-] for disabled operations', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'macie enable completed',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'macie',
        dryRun: true,
        response: {
          organizationAdminConfig: [
            {
              operation: 'enabled',
              regions: ['us-east-1'],
              managementAccountId: '111111111111',
              delegatedAdminAccountId: '222222222222',
            },
          ],
          delegatedAdminAccountConfig: [
            {
              operation: 'enabled',
              regions: ['us-east-1'],
              adminAccountId: '222222222222',
              memberAccountIds: ['333333333333'],
            },
          ],
        },
      });

      expect(result).toContain('[+]');
      expect(result).toContain('Organization Admin Config:');
      expect(result).toContain('Delegated Admin Account Config:');
    });

    it('should handle response with no operation fields gracefully', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'done',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'test-module',
        dryRun: true,
        response: { someData: 'value', otherData: 123 },
      });

      expect(result).toContain('Module: test-module');
      expect(result).toContain('done');
      expect(result).not.toContain('[+]');
      expect(result).not.toContain('[-]');
    });

    it('should format a SUCCESS response', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.SUCCESS,
        summary: 'No changes needed',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'ssm-block-public-document-sharing',
        dryRun: true,
      });

      expect(result).toContain('Module: ssm-block-public-document-sharing');
      expect(result).toContain('Mode: Dry Run');
      expect(result).toContain('No changes needed');
    });

    it('should format a SKIPPED response', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.SKIPPED,
        summary: 'Module not enabled in security-config.yaml',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'macie',
        dryRun: true,
      });

      expect(result).toContain('Module: macie');
      expect(result).toContain('SKIPPED');
      expect(result).toContain('Reason: Module not enabled in security-config.yaml');
      expect(result).toContain('No changes');
    });

    it('should format a FAILED response with error details', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Module execution failed',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'create-organizational-unit',
        dryRun: true,
        error: {
          name: 'OrganizationsAccessDeniedException',
          message: 'Management account credentials not available',
        },
      });

      expect(result).toContain('Module: create-organizational-unit');
      expect(result).toContain('FAILED');
      expect(result).toContain('Error: OrganizationsAccessDeniedException');
      expect(result).toContain('Message: Management account credentials not available');
      expect(result).toContain('Dry-run was unavailable');
    });

    it('should format a FAILED response without error object', () => {
      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.FAILED,
        summary: 'Something went wrong',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'test-module',
        dryRun: true,
      });

      expect(result).toContain('Something went wrong');
      expect(result).toContain('Dry-run was unavailable');
    });

    it('should use a custom formatter when registered', () => {
      registerDiffFormatter('custom-module', response => {
        return `Custom output for ${response.moduleName}: ${response.summary}`;
      });

      const result = formatModuleDiff({
        status: MODULE_STATE_CODE.COMPLETED,
        summary: 'custom data',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'custom-module',
        dryRun: true,
      });

      expect(result).toBe('Custom output for custom-module: custom data');
    });
  });

  describe('buildDiffFileName', () => {
    it('should pad single-digit stage orders', () => {
      expect(buildDiffFileName(6, 'macie')).toBe('06-macie.module.diff');
    });

    it('should handle double-digit stage orders', () => {
      expect(buildDiffFileName(10, 'tgw-associations-and-propagations')).toBe(
        '10-tgw-associations-and-propagations.module.diff',
      );
    });

    it('should handle stage order 1', () => {
      expect(buildDiffFileName(1, 'stack-resources-retention')).toBe('01-stack-resources-retention.module.diff');
    });
  });

  describe('writeModuleDiffFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lza-diff-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write a diff file to the output directory', () => {
      writeModuleDiffFile(tmpDir, 6, {
        status: MODULE_STATE_CODE.COMPLETED,
        summary: '3 change(s) would be made',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'macie',
        dryRun: true,
      });

      const filePath = path.join(tmpDir, '06-macie.module.diff');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Module: macie');
      expect(content).toContain('3 change(s) would be made');
    });

    it('should create the output directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'cdk.out');
      writeModuleDiffFile(nestedDir, 8, {
        status: MODULE_STATE_CODE.SKIPPED,
        summary: 'Not configured',
        timestamp: '2026-04-17T00:00:00Z',
        moduleName: 'test-module',
        dryRun: true,
      });

      expect(fs.existsSync(path.join(nestedDir, '08-test-module.module.diff'))).toBe(true);
    });
  });
});
