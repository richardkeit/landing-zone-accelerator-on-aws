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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import {
  extractSection,
  parseStackIdentifiers,
  readDiffJsonFiles,
  generateImpactReport,
  compressData,
  generateHtml,
  assembleHtml,
  StackDiffData,
} from '../../lib/diff-viewer/generate-diff-viewer';
import type { StructuredStackDiff } from '@aws-accelerator/utils';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-viewer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a .diff.json file with the given structured diff. */
function writeDiffJson(name: string, diff: StructuredStackDiff) {
  fs.writeFileSync(path.join(tmpDir, `${name}.diff.json`), JSON.stringify(diff));
}

function gunzip(b64: string): string {
  return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf-8');
}

/** Minimal empty diff */
const EMPTY_DIFF: StructuredStackDiff = {
  resources: [],
  parameters: [],
  outputs: [],
  conditions: [],
  differenceCount: 0,
  isEmpty: true,
};

/** Diff with real resource changes */
function makeDiff(overrides?: Partial<StructuredStackDiff>): StructuredStackDiff {
  return {
    resources: [
      {
        logicalId: 'MyVpc',
        resourceType: 'AWS::EC2::VPC',
        changeImpact: 'WILL_REPLACE',
        action: 'modify',
        properties: { CidrBlock: { oldValue: '10.0.0.0/16', newValue: '10.1.0.0/16', changeImpact: 'WILL_REPLACE' } },
      },
      {
        logicalId: 'NewSg',
        resourceType: 'AWS::EC2::SecurityGroup',
        changeImpact: 'WILL_CREATE',
        action: 'create',
        properties: {},
      },
    ],
    parameters: [],
    outputs: [],
    conditions: [],
    differenceCount: 2,
    isEmpty: false,
    ...overrides,
  };
}

// ============================================================================
// extractSection
// ============================================================================

describe('extractSection', () => {
  it('extracts section from standard LZA filename', () => {
    expect(extractSection('AWSAccelerator-NetworkVpcStack-123456789012-us-east-1.diff.json')).toBe('NetworkVpc');
  });

  it('extracts section from custom prefix', () => {
    expect(extractSection('MyOrg-SecurityStack-111111111111-eu-west-1.diff.json')).toBe('Security');
  });

  it('returns "other" when no Stack segment found', () => {
    expect(extractSection('some-random-file.diff.json')).toBe('other');
  });

  it('handles multiple hyphens in prefix', () => {
    expect(extractSection('My-Custom-Prefix-LoggingStack-999999999999-ap-southeast-1.diff.json')).toBe('Logging');
  });

  it('picks the first segment ending in Stack', () => {
    expect(extractSection('AWSAccelerator-PrepareStack-SubStack-123456789012-us-east-1.diff.json')).toBe('Prepare');
  });
});

// ============================================================================
// parseStackIdentifiers
// ============================================================================

describe('parseStackIdentifiers', () => {
  it('extracts account and region from standard LZA stack name', () => {
    expect(parseStackIdentifiers('AWSAccelerator-NetworkVpcStack-123456789012-us-east-1')).toEqual({
      account: '123456789012',
      region: 'us-east-1',
    });
  });

  it('handles multi-segment region names', () => {
    expect(parseStackIdentifiers('AWSAccelerator-LoggingStack-111111111111-ap-southeast-2')).toEqual({
      account: '111111111111',
      region: 'ap-southeast-2',
    });
  });

  it('returns unknown for non-matching names', () => {
    expect(parseStackIdentifiers('SomeRandomStack')).toEqual({ account: 'unknown', region: 'unknown' });
  });

  it('handles GovCloud regions', () => {
    expect(parseStackIdentifiers('AWSAccelerator-NetworkVpcStack-123456789012-us-gov-east-1')).toEqual({
      account: '123456789012',
      region: 'us-gov-east-1',
    });
    expect(parseStackIdentifiers('AWSAccelerator-NetworkVpcStack-123456789012-us-gov-west-1')).toEqual({
      account: '123456789012',
      region: 'us-gov-west-1',
    });
  });

  it('tolerates suffixes after the region segment', () => {
    expect(parseStackIdentifiers('AWSAccelerator-CustomStack-123456789012-us-east-1-custom')).toEqual({
      account: '123456789012',
      region: 'us-east-1',
    });
  });

  it('does not mis-parse availability-zone suffix as region', () => {
    // `us-east-1b` is an AZ, not a region. Should NOT be parsed as region.
    expect(parseStackIdentifiers('AWSAccelerator-FooStack-123456789012-us-east-1b-suffix')).toEqual({
      account: 'unknown',
      region: 'unknown',
    });
  });

  it('handles multi-digit region numbers', () => {
    // Future-proof: regions like us-east-10 are not real today but pattern should allow.
    expect(parseStackIdentifiers('AWSAccelerator-FooStack-123456789012-us-east-10')).toEqual({
      account: '123456789012',
      region: 'us-east-10',
    });
  });
});

// ============================================================================
// readDiffJsonFiles
// ============================================================================

describe('readDiffJsonFiles', () => {
  it('reads and parses .diff.json files from directory', () => {
    writeDiffJson('AWSAccelerator-NetworkVpcStack-123456789012-us-east-1', makeDiff());
    writeDiffJson('AWSAccelerator-SecurityStack-123456789012-us-east-1', EMPTY_DIFF);

    const entries = readDiffJsonFiles(tmpDir);
    expect(entries).toHaveLength(2);

    const network = entries.find(e => e.meta.section === 'NetworkVpc')!;
    expect(network.meta.name).toBe('AWSAccelerator-NetworkVpcStack-123456789012-us-east-1');
    expect(network.meta.hasChanges).toBe(true);
    expect(network.meta.account).toBe('123456789012');
    expect(network.meta.region).toBe('us-east-1');
    expect(network.diff.resources).toHaveLength(2);

    const security = entries.find(e => e.meta.section === 'Security')!;
    expect(security.meta.hasChanges).toBe(false);
  });

  it('ignores non-.diff.json files', () => {
    writeDiffJson('AWSAccelerator-KeyStack-123-us-east-1', makeDiff());
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a diff');
    fs.writeFileSync(path.join(tmpDir, 'stack.diff'), 'old text diff');

    const entries = readDiffJsonFiles(tmpDir);
    expect(entries).toHaveLength(1);
  });

  it('returns empty array for directory with no diff.json files', () => {
    expect(readDiffJsonFiles(tmpDir)).toHaveLength(0);
  });

  it('returns entries sorted by filename', () => {
    writeDiffJson('B-SecurityStack-123-us-east-1', makeDiff());
    writeDiffJson('A-NetworkVpcStack-123-us-east-1', makeDiff());

    const entries = readDiffJsonFiles(tmpDir);
    expect(entries[0].meta.section).toBe('NetworkVpc');
    expect(entries[1].meta.section).toBe('Security');
  });

  it('detects noise-only stacks as no changes', () => {
    writeDiffJson('AWSAccelerator-LoggingStack-123-us-east-1', {
      resources: [
        {
          logicalId: 'MyFunc',
          resourceType: 'AWS::Lambda::Function',
          changeImpact: 'WILL_UPDATE',
          action: 'modify',
          properties: {
            S3Key: { oldValue: 'old.zip', newValue: 'new.zip', changeImpact: 'WILL_UPDATE' },
            Code: { oldValue: { S3Key: 'old.zip' }, newValue: { S3Key: 'new.zip' }, changeImpact: 'WILL_UPDATE' },
          },
        },
      ],
      parameters: [],
      outputs: [],
      conditions: [],
      differenceCount: 1,
      isEmpty: false,
    });

    const entries = readDiffJsonFiles(tmpDir);
    expect(entries[0].meta.hasChanges).toBe(false);
  });

  it('detects CustomResource uuid-only as noise', () => {
    writeDiffJson('AWSAccelerator-OpsStack-123-us-east-1', {
      resources: [
        {
          logicalId: 'MyCustom',
          resourceType: 'Custom::SsmGetParameterValue',
          changeImpact: 'WILL_UPDATE',
          action: 'modify',
          properties: { uuid: { oldValue: 'old-uuid', newValue: 'new-uuid', changeImpact: 'WILL_UPDATE' } },
        },
      ],
      parameters: [],
      outputs: [],
      conditions: [],
      differenceCount: 1,
      isEmpty: false,
    });

    const entries = readDiffJsonFiles(tmpDir);
    expect(entries[0].meta.hasChanges).toBe(false);
  });
});

// ============================================================================
// compressData
// ============================================================================

describe('compressData', () => {
  it('compresses stack data into a decompressible gzipped base64 blob', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-a', hasChanges: true, account: '123', region: 'us-east-1' },
        diff: makeDiff(),
      },
      {
        meta: { section: 'Security', name: 'stack-b', hasChanges: false, account: '456', region: 'us-west-2' },
        diff: EMPTY_DIFF,
      },
    ];

    const blob = compressData(stacks);
    const decompressed = JSON.parse(gunzip(blob));
    expect(decompressed).toHaveLength(2);
    expect(decompressed[0].meta.name).toBe('stack-a');
    expect(decompressed[1].diff.isEmpty).toBe(true);
  });

  it('handles single entry', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Key', name: 'only', hasChanges: true, account: '123', region: 'us-east-1' },
        diff: makeDiff(),
      },
    ];
    const blob = compressData(stacks);
    const decompressed = JSON.parse(gunzip(blob));
    expect(decompressed).toHaveLength(1);
  });
});

// ============================================================================
// generateImpactReport
// ============================================================================

describe('generateImpactReport', () => {
  it('generates report with correct counts', () => {
    const stacks: StackDiffData[] = [
      {
        meta: {
          section: 'Security',
          name: 'AWSAccelerator-SecurityStack-123456789012-us-east-1',
          hasChanges: true,
          account: '123456789012',
          region: 'us-east-1',
        },
        diff: {
          resources: [
            {
              logicalId: 'NewSG',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'WILL_CREATE',
              action: 'create',
              properties: {},
            },
            {
              logicalId: 'OldSG',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 2,
          isEmpty: false,
        },
      },
      {
        meta: {
          section: 'Logging',
          name: 'AWSAccelerator-LoggingStack-123456789012-us-west-2',
          hasChanges: false,
          account: '123456789012',
          region: 'us-west-2',
        },
        diff: EMPTY_DIFF,
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.totalStacks).toBe(2);
    expect(report.stacksWithChanges).toBe(1);
    expect(report.resourceCounts.creates).toBe(1);
    expect(report.resourceCounts.deletes).toBe(1);
    expect(report.accountsAffected).toContain('123456789012');
    expect(report.regionsAffected).toContain('us-east-1');
  });

  it('counts replaces separately from modifies', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-1', hasChanges: true, account: '123', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Vpc',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_REPLACE',
              action: 'modify',
              properties: { CidrBlock: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_REPLACE' } },
            },
            {
              logicalId: 'Sg',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Description: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' } },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 2,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.resourceCounts.replaces).toBe(1);
    expect(report.resourceCounts.modifies).toBe(1);
  });

  it('filters out noise from impact report', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Logging', name: 'stack-1', hasChanges: false, account: '123', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Func',
              resourceType: 'AWS::Lambda::Function',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { S3Key: { oldValue: 'a', newValue: 'b' }, Code: { oldValue: {}, newValue: {} } },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.stacksWithChanges).toBe(0);
    expect(report.resourceCounts.creates).toBe(0);
  });

  it('returns empty report for no entries', () => {
    const report = generateImpactReport([]);
    expect(report.totalStacks).toBe(0);
    expect(report.stacksWithChanges).toBe(0);
    expect(report.destructiveChanges).toEqual([]);
    expect(report.destructiveCounts).toEqual({ willDestroy: 0, willReplace: 0, mayReplace: 0, willOrphan: 0 });
    expect(report.stacksWithDestructive).toBe(0);
    expect(report.networkingChanges).toEqual([]);
    expect(report.stacksWithNetworkingChanges).toBe(0);
  });

  // ── Destructive change aggregation ─────────────────────────────────────

  it('captures WILL_DESTROY (delete action) in destructiveChanges', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'VpcStack-A', hasChanges: true, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'OldVpc',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges).toHaveLength(1);
    expect(report.destructiveChanges[0]).toMatchObject({
      stackName: 'VpcStack-A',
      logicalId: 'OldVpc',
      resourceType: 'AWS::EC2::VPC',
      impact: 'WILL_DESTROY',
      account: '111',
      region: 'us-east-1',
    });
    expect(report.destructiveCounts.willDestroy).toBe(1);
    expect(report.stacksWithDestructive).toBe(1);
  });

  it('captures WILL_REPLACE with triggerProperties from property-level impact', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'VpcStack-B', hasChanges: true, account: '222', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Vpc',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_REPLACE',
              action: 'modify',
              properties: {
                CidrBlock: { oldValue: '10.0.0.0/16', newValue: '10.1.0.0/16', changeImpact: 'WILL_REPLACE' },
                Tags: { oldValue: [], newValue: [{ Key: 'x', Value: 'y' }], changeImpact: 'WILL_UPDATE' },
              },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges).toHaveLength(1);
    expect(report.destructiveChanges[0].impact).toBe('WILL_REPLACE');
    expect(report.destructiveChanges[0].triggerProperties).toEqual(['CidrBlock']);
    expect(report.destructiveCounts.willReplace).toBe(1);
  });

  it('captures MAY_REPLACE separately from WILL_REPLACE', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-c', hasChanges: true, account: '333', region: 'us-west-2' },
        diff: {
          resources: [
            {
              logicalId: 'Sg',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'MAY_REPLACE',
              action: 'modify',
              properties: {
                GroupName: { oldValue: 'a', newValue: 'b', changeImpact: 'MAY_REPLACE' },
              },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveCounts.willReplace).toBe(0);
    expect(report.destructiveCounts.mayReplace).toBe(1);
    expect(report.destructiveChanges[0].impact).toBe('MAY_REPLACE');
    expect(report.destructiveChanges[0].triggerProperties).toEqual(['GroupName']);
  });

  it('captures WILL_ORPHAN as destructive', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Logging', name: 'stack-orphan', hasChanges: true, account: '444', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Bucket',
              resourceType: 'AWS::S3::Bucket',
              changeImpact: 'WILL_ORPHAN',
              action: 'modify',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveCounts.willOrphan).toBe(1);
    expect(report.destructiveChanges[0].impact).toBe('WILL_ORPHAN');
    expect(report.destructiveChanges[0].triggerProperties).toBeUndefined();
  });

  it('falls back to property-level WILL_REPLACE when resource impact is WILL_UPDATE', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-fallback', hasChanges: true, account: '555', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Sg',
              resourceType: 'AWS::EC2::SecurityGroup',
              // resource-level WILL_UPDATE but a property forces replacement
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: {
                Description: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' },
                GroupName: { oldValue: 'sg-a', newValue: 'sg-b', changeImpact: 'WILL_REPLACE' },
              },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges).toHaveLength(1);
    expect(report.destructiveChanges[0].impact).toBe('WILL_REPLACE');
    expect(report.destructiveChanges[0].triggerProperties).toEqual(['GroupName']);
  });

  it('does not count non-destructive modifies as destructive', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Security', name: 'stack-safe', hasChanges: true, account: '666', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Sg',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: {
                Description: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' },
              },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges).toHaveLength(0);
    expect(report.stacksWithDestructive).toBe(0);
  });

  it('sorts destructive changes by severity (destroy > replace > may-replace > orphan)', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-mixed', hasChanges: true, account: '777', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'A',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_ORPHAN',
              action: 'modify',
              properties: {},
            },
            {
              logicalId: 'B',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'MAY_REPLACE',
              action: 'modify',
              properties: { CidrBlock: { oldValue: 'a', newValue: 'b', changeImpact: 'MAY_REPLACE' } },
            },
            {
              logicalId: 'C',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_REPLACE',
              action: 'modify',
              properties: { CidrBlock: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_REPLACE' } },
            },
            {
              logicalId: 'D',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 4,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges.map(d => d.impact)).toEqual([
      'WILL_DESTROY',
      'WILL_REPLACE',
      'MAY_REPLACE',
      'WILL_ORPHAN',
    ]);
  });

  it('counts stacksWithDestructive uniquely across stacks', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-1', hasChanges: true, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'A',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
            {
              logicalId: 'B',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 2,
          isEmpty: false,
        },
      },
      {
        meta: { section: 'NetworkVpc', name: 'stack-2', hasChanges: true, account: '222', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'C',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_REPLACE',
              action: 'modify',
              properties: { CidrBlock: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_REPLACE' } },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveCounts.willDestroy).toBe(2);
    expect(report.destructiveCounts.willReplace).toBe(1);
    expect(report.stacksWithDestructive).toBe(2);
  });

  // ── Networking change aggregation ──────────────────────────────────────

  it('captures any action on a notable networking resource type', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-net', hasChanges: true, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Vpc',
              resourceType: 'AWS::EC2::VPC',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Tags: { oldValue: [], newValue: [], changeImpact: 'WILL_UPDATE' } },
            },
            {
              logicalId: 'Sg',
              resourceType: 'AWS::EC2::SecurityGroup',
              changeImpact: 'WILL_CREATE',
              action: 'create',
              properties: {},
            },
            {
              logicalId: 'Rt',
              resourceType: 'AWS::EC2::RouteTable',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
            // Non-networking resource — must be excluded
            {
              logicalId: 'Bucket',
              resourceType: 'AWS::S3::Bucket',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Tags: { oldValue: [], newValue: [], changeImpact: 'WILL_UPDATE' } },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 4,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.networkingChanges).toHaveLength(3);
    const types = report.networkingChanges.map(n => n.resourceType);
    expect(types).toContain('AWS::EC2::VPC');
    expect(types).toContain('AWS::EC2::SecurityGroup');
    expect(types).toContain('AWS::EC2::RouteTable');
    expect(types).not.toContain('AWS::S3::Bucket');
    expect(report.stacksWithNetworkingChanges).toBe(1);
  });

  it('includes all actions for networking resources (create, modify, delete)', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'NetworkVpc', name: 'stack-net', hasChanges: true, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'A',
              resourceType: 'AWS::EC2::Subnet',
              changeImpact: 'WILL_CREATE',
              action: 'create',
              properties: {},
            },
            {
              logicalId: 'B',
              resourceType: 'AWS::EC2::Subnet',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Tags: { oldValue: [], newValue: [], changeImpact: 'WILL_UPDATE' } },
            },
            {
              logicalId: 'C',
              resourceType: 'AWS::EC2::Subnet',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 3,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.networkingChanges.map(n => n.action).sort()).toEqual(['create', 'delete', 'modify']);
  });

  it('recognizes expanded networking types (TGW, Firewall, Route53Resolver, DirectConnect)', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Network', name: 'stack-exp', hasChanges: true, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            {
              logicalId: 'Tgw',
              resourceType: 'AWS::EC2::TransitGatewayRouteTable',
              changeImpact: 'WILL_CREATE',
              action: 'create',
              properties: {},
            },
            {
              logicalId: 'Fw',
              resourceType: 'AWS::NetworkFirewall::FirewallPolicy',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Description: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' } },
            },
            {
              logicalId: 'Dns',
              resourceType: 'AWS::Route53Resolver::ResolverRuleAssociation',
              changeImpact: 'WILL_DESTROY',
              action: 'delete',
              properties: {},
            },
            {
              logicalId: 'Dx',
              resourceType: 'AWS::DirectConnect::VirtualInterface',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: { Vlan: { oldValue: 1, newValue: 2, changeImpact: 'WILL_UPDATE' } },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 4,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.networkingChanges).toHaveLength(4);
  });

  it('filters noise resources from networking and destructive aggregations', () => {
    const stacks: StackDiffData[] = [
      {
        meta: { section: 'Logging', name: 'stack-noise', hasChanges: false, account: '111', region: 'us-east-1' },
        diff: {
          resources: [
            // This is noise — Lambda S3Key churn — should be filtered
            {
              logicalId: 'Fn',
              resourceType: 'AWS::Lambda::Function',
              changeImpact: 'WILL_UPDATE',
              action: 'modify',
              properties: {
                S3Key: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' },
                Code: { oldValue: {}, newValue: {}, changeImpact: 'WILL_UPDATE' },
              },
            },
          ],
          parameters: [],
          outputs: [],
          conditions: [],
          differenceCount: 1,
          isEmpty: false,
        },
      },
    ];
    const report = generateImpactReport(stacks);
    expect(report.destructiveChanges).toHaveLength(0);
    expect(report.networkingChanges).toHaveLength(0);
  });
});

// ============================================================================
// assembleHtml
// ============================================================================

describe('assembleHtml', () => {
  it('replaces all placeholders in the shell template', () => {
    const templatesDir = path.join(__dirname, '../../lib/diff-viewer/templates');
    const html = assembleHtml('const testData = 42;', templatesDir);

    expect(html).not.toContain('{{STYLES}}');
    expect(html).not.toContain('{{DATA}}');
    expect(html).not.toContain('{{SCRIPT}}');
    expect(html).toContain('const testData = 42;');
    expect(html).toContain(':root');
    expect(html).toContain('function decompressBlob');
  });

  it('does not contain any ANSI rendering code', () => {
    const templatesDir = path.join(__dirname, '../../lib/diff-viewer/templates');
    const html = assembleHtml('const testData = 0;', templatesDir);
    expect(html).not.toContain('ansiToHtml');
    expect(html).not.toContain('splitDiffContent');
    expect(html).not.toContain('diffBlob');
  });

  it('contains structured diff rendering code', () => {
    const templatesDir = path.join(__dirname, '../../lib/diff-viewer/templates');
    const html = assembleHtml('const testData = 0;', templatesDir);
    expect(html).toContain('renderDiffBody');
    expect(html).toContain('renderResourceCard');
    expect(html).toContain('sd-resource');
    expect(html).toContain('impactBadge');
  });
});

// ============================================================================
// generateHtml
// ============================================================================

describe('generateHtml', () => {
  it('generates complete HTML with embedded data', () => {
    writeDiffJson('AWSAccelerator-NetworkVpcStack-123-us-east-1', makeDiff());
    writeDiffJson('AWSAccelerator-SecurityStack-456-us-west-2', EMPTY_DIFF);

    const html = generateHtml(tmpDir);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>LZA CDK Diff Viewer</title>');
    expect(html).toContain('</html>');
    expect(html).toContain('const impactReport = ');
    expect(html).toContain('const dataBlob = "');
    expect(html).toContain('function renderSidebar');
    expect(html).toContain('function showDiff');
  });

  it('throws when no diff.json files exist', () => {
    expect(() => generateHtml(tmpDir)).toThrow('No .diff.json files found');
  });

  it('produces decompressible blob in the HTML', () => {
    writeDiffJson('Prefix-LoggingStack-111-us-east-1', makeDiff());

    const html = generateHtml(tmpDir);
    const blobMatch = html.match(/const dataBlob = "([^"]+)"/);
    expect(blobMatch).not.toBeNull();

    const decompressed = JSON.parse(gunzip(blobMatch![1]));
    expect(decompressed).toHaveLength(1);
    expect(decompressed[0].meta.section).toBe('Logging');
    expect(decompressed[0].diff.resources).toHaveLength(2);
  });

  it('escapes </script> in embedded JSON so it cannot terminate the inline script tag', () => {
    // Inject </script> into a destructive networking resource so it flows into
    // the inline impactReport JSON (the gzipped blob is base64, so only the
    // inline JSON is an HTML-context injection risk).
    writeDiffJson('AWSAccelerator-NetworkVpcStack-111-us-east-1', {
      resources: [
        {
          logicalId: 'Evil</script><script>alert(1)</script>',
          resourceType: 'AWS::EC2::VPC',
          changeImpact: 'WILL_DESTROY',
          action: 'delete',
          properties: {},
        },
      ],
      parameters: [],
      outputs: [],
      conditions: [],
      differenceCount: 1,
      isEmpty: false,
    });

    const html = generateHtml(tmpDir);
    // The raw literal `</script>` must NOT appear between `const impactReport = ` and its terminating `;`
    const reportMatch = html.match(/const impactReport = (\{[\s\S]*?\});\n/);
    expect(reportMatch).not.toBeNull();
    expect(reportMatch![1]).not.toContain('</script>');
    // But the escaped form is present so the original value still round-trips
    expect(reportMatch![1]).toContain('\\u003c/script\\u003e');
    // And parses correctly
    const report = JSON.parse(reportMatch![1]);
    expect(report.destructiveChanges[0].logicalId).toBe('Evil</script><script>alert(1)</script>');
  });

  it('does not interpret replacement patterns in embedded data', () => {
    // `$&`, `$1`, `` $` `` etc. are replacement directives for String.prototype.replace.
    // If a template assembler used the string-form replace, these would be substituted.
    // Embed them in a destructive networking resource so they reach the inline JSON.
    writeDiffJson('AWSAccelerator-NetworkVpcStack-222-us-east-1', {
      resources: [
        {
          logicalId: 'Res$&Literal',
          resourceType: 'AWS::EC2::VPC',
          changeImpact: 'WILL_DESTROY',
          action: 'delete',
          properties: {},
        },
      ],
      parameters: [],
      outputs: [],
      conditions: [],
      differenceCount: 1,
      isEmpty: false,
    });

    const html = generateHtml(tmpDir);
    // Verify no placeholder token was substituted back into the output (which
    // would happen if $& were interpreted as the matched {{DATA}} / {{STYLES}} etc.)
    expect(html).not.toContain('{{DATA}}');
    expect(html).not.toContain('{{STYLES}}');
    expect(html).not.toContain('{{SCRIPT}}');
    // Verify the literal $& survives the round-trip through the escaped JSON embedding.
    // (safeJsonEmbed escapes `&` to `\u0026` for HTML-context safety, so parse the
    //  JSON back to check the original value is preserved.)
    const reportMatch = html.match(/const impactReport = (\{[\s\S]*?\});\n/);
    const report = JSON.parse(reportMatch![1]);
    expect(report.destructiveChanges[0].logicalId).toBe('Res$&Literal');
  });

  it('escapes attacker-controlled strings in non-destructive networking resources too', () => {
    // Stacks Requiring Review builds its rows from every change to a tracked
    // resource type — not just destructive ones. Verify that `<script>` / quote
    // chars in a *modify*-action resource's logical ID don't escape context
    // either. Hits critExpandableRowHtml + critDetailItemHtml paths via the
    // `networkingChanges` aggregation in the inline impact report JSON.
    writeDiffJson('AWSAccelerator-NetworkVpcStack-333-us-east-1', {
      resources: [
        {
          logicalId: 'QuoteAndBracket"<img src=x onerror=alert(1)>',
          resourceType: 'AWS::EC2::SecurityGroup',
          changeImpact: 'WILL_UPDATE',
          action: 'modify',
          properties: { Description: { oldValue: 'a', newValue: 'b', changeImpact: 'WILL_UPDATE' } },
        },
      ],
      parameters: [],
      outputs: [],
      conditions: [],
      differenceCount: 1,
      isEmpty: false,
    });

    const html = generateHtml(tmpDir);
    const reportMatch = html.match(/const impactReport = (\{[\s\S]*?\});\n/);
    expect(reportMatch).not.toBeNull();
    // Raw, unescaped `<img ...>` must never appear in the embedded JSON
    expect(reportMatch![1]).not.toContain('<img src=x');
    // But the escaped form is present and the value round-trips
    const report = JSON.parse(reportMatch![1]);
    expect(report.networkingChanges[0].logicalId).toBe('QuoteAndBracket"<img src=x onerror=alert(1)>');
  });
});

// ============================================================================
// Performance
// ============================================================================

describe('generateHtml - performance', () => {
  const PERF_DIR = path.join(os.tmpdir(), 'diff-viewer-json-perf');
  const TOTAL = 200;
  const sections = [
    'NetworkVpc',
    'Security',
    'Customizations',
    'Key',
    'Logging',
    'Operations',
    'Identity',
    'DependenciesInstall',
    'Prepare',
    'Accounts',
  ];
  const regions = [
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'eu-central-1',
    'ap-southeast-1',
    'ap-northeast-1',
    'sa-east-1',
    'ca-central-1',
    'af-south-1',
    'me-south-1',
  ];
  const resourceTypes = [
    'AWS::EC2::Subnet',
    'AWS::EC2::RouteTable',
    'AWS::S3::Bucket',
    'AWS::IAM::Role',
    'AWS::Lambda::Function',
    'AWS::EC2::SecurityGroup',
    'AWS::KMS::Key',
    'AWS::Logs::LogGroup',
  ];

  function seededRng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
  }

  function buildDiff(idx: number): StructuredStackDiff {
    const rng = seededRng(idx * 7 + 13);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
    const isLarge = rng() < 0.2;
    const count = isLarge ? 150 + Math.floor(rng() * 100) : 10 + Math.floor(rng() * 50);
    const actions: Array<'create' | 'delete' | 'modify'> = ['create', 'delete', 'modify'];
    const impacts = ['WILL_CREATE', 'WILL_DESTROY', 'WILL_UPDATE', 'WILL_REPLACE'];
    const resources = [];
    for (let r = 0; r < count; r++) {
      const action = pick(actions);
      resources.push({
        logicalId: `Res${r}`,
        resourceType: pick(resourceTypes),
        changeImpact:
          action === 'create' ? 'WILL_CREATE' : action === 'delete' ? 'WILL_DESTROY' : pick(impacts.slice(2)),
        action,
        properties:
          action === 'modify'
            ? { SomeProp: { oldValue: `old-${r}`, newValue: `new-${r}`, changeImpact: 'WILL_UPDATE' } }
            : {},
      });
    }
    return { resources, parameters: [], outputs: [], conditions: [], differenceCount: count, isEmpty: false };
  }

  function ensurePerfFiles() {
    if (fs.existsSync(PERF_DIR) && fs.readdirSync(PERF_DIR).some(f => f.endsWith('.diff.json'))) return;
    fs.mkdirSync(PERF_DIR, { recursive: true });
    for (let i = 0; i < TOTAL; i++) {
      const sec = sections[i % sections.length];
      const reg = regions[Math.floor(i / sections.length) % regions.length];
      const acct = (100000000000 + i).toString();
      const name = `AWSAccelerator-${sec}Stack-${acct}-${reg}`;
      const diff = i % 7 === 0 ? EMPTY_DIFF : buildDiff(i);
      fs.writeFileSync(path.join(PERF_DIR, `${name}.diff.json`), JSON.stringify(diff));
    }
  }

  it('generates HTML for 200 stacks', () => {
    ensurePerfFiles();
    const start = Date.now();
    const html = generateHtml(PERF_DIR);
    const elapsed = (Date.now() - start) / 1000;
    const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`Performance: ${TOTAL} stacks in ${elapsed.toFixed(2)}s, output ${sizeKB}KB`);

    expect(html).toContain('const impactReport = ');
    expect(html).toContain('const dataBlob = "');
    expect(html).toContain('</html>');
    // Verify the impact report contains resource types from our generated data
    expect(html).toContain('AWS::EC2::Subnet');
    expect(html).toContain('AWS::Lambda::Function');
  }, 30_000);
});
