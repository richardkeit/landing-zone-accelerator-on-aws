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

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const DELIMITER = '__DIFF_SPLIT__';
const TEMPLATES_DIR = path.join(__dirname, 'templates');

export interface DiffMeta {
  section: string;
  name: string;
  hasChanges: boolean;
}

export interface DiffEntry extends DiffMeta {
  content: string;
}

/**
 * Extract section name from a diff filename.
 * Pattern: {Prefix}-{Section}Stack-{account}-{region}.diff
 * Finds the first hyphen-delimited segment ending in "Stack", strips the suffix.
 * Falls back to "other" if no match.
 */
export function extractSection(filename: string): string {
  const name = filename.replace(/\.diff$/, '');
  const parts = name.split('-');
  for (const part of parts) {
    if (part.endsWith('Stack')) {
      return part.slice(0, -5);
    }
  }
  return 'other';
}

/**
 * Determine if a diff file has meaningful changes.
 * Returns false if the diff has no differences, or if every change block
 * is only a Lambda function S3Key update (asset hash rotation).
 */
export function hasChanges(content: string): boolean {
  if (content.includes('There were no differences')) {
    return false;
  }
  return !isOnlyLambdaS3KeyChanges(content);
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[\d;]*m/g, '');
}

/**
 * Check whether every resource-level change block in a CDK diff is exclusively
 * noise — i.e. Lambda S3Key changes (asset hash rotation) or CustomResource
 * uuid changes. These appear on every deploy when source is rebuilt, even
 * with no functional change.
 *
 * CDK diff output contains ANSI color codes, so we strip them before parsing.
 */
export function isOnlyLambdaS3KeyChanges(content: string): boolean {
  const clean = stripAnsi(content);
  const resourceChangeRegex = /^\s*\[([~+-])\]\s+((?:AWS|Custom)::\S+)\s+\S+/gm;
  const resourceChanges = [...clean.matchAll(resourceChangeRegex)];

  if (resourceChanges.length === 0) {
    return false;
  }

  // Any [+] or [-] resource is a real change
  // Only [~] on Lambda::Function or CloudFormation::CustomResource can be noise
  const noiseTypes = new Set(['AWS::Lambda::Function', 'AWS::CloudFormation::CustomResource']);
  for (const match of resourceChanges) {
    if (match[1] !== '~') {
      return false;
    }
    if (!noiseTypes.has(match[2]) && !match[2].startsWith('Custom::')) {
      return false;
    }
  }

  // Split content into blocks per resource change line
  const lines = clean.split('\n');
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^\s*\[([~+-])\]\s+(?:AWS|Custom)::\S+\s+\S+/.test(line)) {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }

  // Every block must be a noise-only change
  for (const block of blocks) {
    const header = block[0];
    const body = block.slice(1).join('\n');

    if (header.includes('AWS::Lambda::Function')) {
      // Lambda: only S3Key changes are noise
      if (!body.includes('.S3Key')) {
        return false;
      }
      const propertyChanges = body.match(/\[~\]\s+\.(\S+)/g) || [];
      for (const prop of propertyChanges) {
        const propName = prop.match(/\[~\]\s+\.(\S+)/)?.[1];
        if (propName && propName !== 'S3Key:' && propName !== 'S3Key') {
          return false;
        }
      }
    } else if (header.includes('AWS::CloudFormation::CustomResource') || /Custom::\S+/.test(header)) {
      // CustomResource: only uuid changes are noise
      if (!body.includes('uuid')) {
        return false;
      }
      const propertyChanges = body.match(/\[~\]\s+(\S+)/g) || [];
      for (const prop of propertyChanges) {
        const propName = prop.match(/\[~\]\s+(\S+)/)?.[1];
        if (propName && propName !== 'uuid') {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Read all .diff files from a directory and return structured metadata + content.
 */
export function readDiffFiles(diffDir: string): DiffEntry[] {
  const files = fs
    .readdirSync(diffDir)
    .filter(f => f.endsWith('.diff'))
    .sort();

  return files.map(file => {
    const content = fs.readFileSync(path.join(diffDir, file), 'utf-8');
    const name = file.replace(/\.diff$/, '');
    return {
      section: extractSection(file),
      name,
      hasChanges: hasChanges(content),
      content,
    };
  });
}

// ============================================================================
// RESOURCE CHANGE PARSING & IMPACT REPORT
// ============================================================================

/**
 * High-risk CFN resource types that warrant review when modified or deleted.
 */
const HIGH_RISK_TYPES = new Set([
  'AWS::EC2::TransitGatewayAttachment',
  'AWS::EC2::TransitGatewayVpcAttachment',
  'AWS::EC2::TransitGateway',
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::Route',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EC2::SecurityGroupEgress',
  'AWS::EC2::NetworkAcl',
  'AWS::EC2::VPNConnection',
  'AWS::EC2::VPNGateway',
  'AWS::EC2::NatGateway',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::VPCPeeringConnection',
  'AWS::NetworkFirewall::Firewall',
  'AWS::NetworkFirewall::FirewallPolicy',
  'AWS::NetworkFirewall::RuleGroup',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::Route53Resolver::ResolverEndpoint',
  'AWS::Route53Resolver::ResolverRule',
  'AWS::RAM::ResourceShare',
]);

export interface ResourceChange {
  resourceType: string;
  logicalId: string;
  action: 'create' | 'modify' | 'delete';
  properties: string[];
}

export interface StackChangeSummary {
  stackName: string;
  account: string;
  region: string;
  section: string;
  resources: ResourceChange[];
}

export interface ImpactReport {
  totalStacks: number;
  stacksWithChanges: number;
  allStackSummaries: StackChangeSummary[];
  resourceCounts: { creates: number; modifies: number; deletes: number };
  highRiskChanges: { resourceType: string; action: string; count: number; stacks: string[] }[];
  accountsAffected: string[];
  regionsAffected: string[];
  allResourceTypes: string[];
  notableResourceTypes: string[];
}

/**
 * Parse account and region from an LZA stack name.
 * Pattern: {Prefix}-{Section}Stack-{account}-{region}
 */
export function parseStackIdentifiers(stackName: string): { account: string; region: string } {
  const match = stackName.match(/(\d{12})-([a-z0-9-]+)$/);
  return match ? { account: match[1], region: match[2] } : { account: 'unknown', region: 'unknown' };
}

/**
 * Parse resource-level changes from CDK diff output.
 * Matches lines like: [~] AWS::EC2::TransitGatewayAttachment LogicalId
 */
export function parseResourceChanges(content: string): ResourceChange[] {
  const clean = stripAnsi(content);
  const changes: ResourceChange[] = [];
  const lines = clean.split('\n');

  let currentResource: ResourceChange | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const resourceMatch = line.match(/^\[([~+-])\]\s+(AWS::\S+)\s+(\S+)/);
    if (resourceMatch) {
      if (currentResource) changes.push(currentResource);
      const actionChar = resourceMatch[1];
      const action = actionChar === '+' ? 'create' : actionChar === '-' ? 'delete' : 'modify';
      currentResource = {
        resourceType: resourceMatch[2],
        logicalId: resourceMatch[3],
        action,
        properties: [],
      };
      continue;
    }

    // Capture property changes under current resource
    if (currentResource) {
      const propMatch = line.match(/[└├│]\s*\[([~+-])\]\s+\.?(\S+)/);
      if (propMatch) {
        currentResource.properties.push(propMatch[2].replace(/:$/, ''));
      }
    }
  }
  if (currentResource) changes.push(currentResource);

  return changes;
}

/**
 * Generate an impact report from all diff entries.
 */
export function generateImpactReport(entries: DiffEntry[]): ImpactReport {
  const stackSummaries: StackChangeSummary[] = [];
  const allAccounts = new Set<string>();
  const allRegions = new Set<string>();
  let totalCreates = 0,
    totalModifies = 0,
    totalDeletes = 0;

  for (const entry of entries) {
    if (!entry.hasChanges) continue;

    const resources = parseResourceChanges(entry.content);
    // Filter out noise: Lambda S3Key-only changes, SSM version params, Custom:: uuid rotations
    const meaningful = resources.filter(r => {
      if (r.resourceType === 'AWS::Lambda::Function' && r.properties.every(p => p === 'S3Key' || p === 'SOLUTION_ID'))
        return false;
      if (r.resourceType === 'AWS::SSM::Parameter' && r.logicalId.includes('AcceleratorVersion')) return false;
      if (r.resourceType.startsWith('Custom::') && r.properties.every(p => p === 'uuid')) return false;
      return true;
    });

    if (meaningful.length === 0) continue;

    const { account, region } = parseStackIdentifiers(entry.name);
    allAccounts.add(account);
    allRegions.add(region);

    for (const r of meaningful) {
      if (r.action === 'create') totalCreates++;
      else if (r.action === 'modify') totalModifies++;
      else if (r.action === 'delete') totalDeletes++;
    }

    stackSummaries.push({
      stackName: entry.name,
      account,
      region,
      section: entry.section,
      resources: meaningful,
    });
  }

  // Aggregate high-risk changes by type + action (for default view)
  const hrMap = new Map<string, { resourceType: string; action: string; count: number; stacks: Set<string> }>();
  const allResourceTypesSet = new Set<string>();

  for (const summary of stackSummaries) {
    for (const r of summary.resources) {
      allResourceTypesSet.add(r.resourceType);
    }
    const hrResources = summary.resources.filter(r => HIGH_RISK_TYPES.has(r.resourceType) && r.action !== 'create');
    for (const r of hrResources) {
      const key = `${r.resourceType}|${r.action}`;
      const existing = hrMap.get(key);
      if (existing) {
        existing.count++;
        existing.stacks.add(summary.stackName);
      } else {
        hrMap.set(key, {
          resourceType: r.resourceType,
          action: r.action,
          count: 1,
          stacks: new Set([summary.stackName]),
        });
      }
    }
  }

  const allResourceTypes = [...allResourceTypesSet].sort();
  const notableResourceTypes = allResourceTypes.filter(t => HIGH_RISK_TYPES.has(t));

  return {
    totalStacks: entries.length,
    stacksWithChanges: stackSummaries.length,
    resourceCounts: { creates: totalCreates, modifies: totalModifies, deletes: totalDeletes },
    allStackSummaries: stackSummaries,
    highRiskChanges: [...hrMap.values()].map(v => ({ ...v, stacks: [...v.stacks] })).sort((a, b) => b.count - a.count),
    accountsAffected: [...allAccounts].sort(),
    regionsAffected: [...allRegions].sort(),
    allResourceTypes,
    notableResourceTypes,
  };
}

/**
 * Generate the impact report JS for embedding in HTML.
 */
export function generateReportJs(report: ImpactReport): string {
  return `const impactReport = ${JSON.stringify(report)};`;
}

/**
 * Compress all diff contents into a single gzipped base64 blob.
 */
export function compressDiffs(entries: DiffEntry[]): { blob: string; meta: DiffMeta[] } {
  const concatenated = entries.map(e => e.content).join(`\n${DELIMITER}\n`);
  const compressed = zlib.gzipSync(new Uint8Array(Buffer.from(concatenated, 'utf-8')));
  const blob = compressed.toString('base64');
  const meta = entries.map(e => ({ section: e.section, name: e.name, hasChanges: e.hasChanges }));
  return { blob, meta };
}

/**
 * Generate the metadata JS array string for embedding in HTML.
 */
export function generateMetaJs(meta: DiffMeta[]): string {
  const items = meta.map(m => `{s:${JSON.stringify(m.section)},n:${JSON.stringify(m.name)},c:${m.hasChanges}}`);
  return `const diffMeta = [\n${items.join(',\n')}\n];`;
}

/**
 * Read template files and assemble the final HTML.
 * Templates are in lib/diff-viewer/templates/:
 *   shell.html  — HTML skeleton with {{STYLES}}, {{DATA}}, {{SCRIPT}} placeholders
 *   styles.css  — CSS styles
 *   viewer.js   — Client-side JS
 */
export function assembleHtml(dataJs: string, templatesDir?: string): string {
  const dir = templatesDir ?? TEMPLATES_DIR;
  const shell = fs.readFileSync(path.join(dir, 'shell.html'), 'utf-8');
  const styles = fs.readFileSync(path.join(dir, 'styles.css'), 'utf-8');
  const script = fs.readFileSync(path.join(dir, 'viewer.js'), 'utf-8');

  return shell.replace('{{STYLES}}', styles).replace('{{DATA}}', dataJs).replace('{{SCRIPT}}', script);
}

/**
 * Generate the complete diff-viewer HTML file content.
 */
export function generateHtml(diffDir: string, templatesDir?: string): string {
  const entries = readDiffFiles(diffDir);
  if (entries.length === 0) {
    throw new Error(`No .diff files found in ${diffDir}`);
  }

  const { blob, meta } = compressDiffs(entries);
  const report = generateImpactReport(entries);
  const dataJs = [
    generateMetaJs(meta),
    generateReportJs(report),
    `const DELIM = ${JSON.stringify(DELIMITER)};`,
    `const diffBlob = "${blob}";`,
  ].join('\n');

  return assembleHtml(dataJs, templatesDir);
}
