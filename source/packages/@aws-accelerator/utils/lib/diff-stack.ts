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
import {
  type DescribeChangeSetOutput,
  type FormatStream,
  type TemplateDiff,
  formatDifferences,
  fullDiff,
  mangleLikeCloudFormation,
} from '@aws-cdk/cloudformation-diff';
import * as fs from 'fs';
import { createLogger } from './logger';

const logger = createLogger(['diff']);

// ============================================================================
// STRUCTURED DIFF TYPES
// ============================================================================

export interface PropertyChange {
  oldValue: unknown;
  newValue: unknown;
  changeImpact?: string;
  /** True if this change is from Properties, false if from DependsOn/Metadata/etc */
  isProperty?: boolean;
}

export interface ResourceChange {
  logicalId: string;
  resourceType: string;
  changeImpact: string;
  action: 'create' | 'delete' | 'modify';
  properties: Record<string, PropertyChange>;
  oldResource?: unknown;
  newResource?: unknown;
}

export interface SectionChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface StructuredStackDiff {
  resources: ResourceChange[];
  parameters: SectionChange[];
  outputs: SectionChange[];
  conditions: SectionChange[];
  /** IAM statement changes table: [header, ...rows] where row[0] is '+' | '-' | '' */
  iamStatements?: string[][];
  /** Security group rule changes table */
  securityGroupRules?: string[][];
  differenceCount: number;
  isEmpty: boolean;
}

// ============================================================================
// STRUCTURED DIFF
// ============================================================================

/**
 * Compute a structured JSON diff between two CloudFormation templates.
 *
 * Returns a plain serializable object (no class instances) suitable for
 * JSON.stringify. Runs the same filtering as printStackDiff (mangle check,
 * CDK::Metadata removal) so the JSON matches the text diff.
 */
export function getStructuredDiff(
  oldTemplatePath: string,
  newTemplatePath: string,
  strict = false,
): StructuredStackDiff {
  const oldT = readTemplate(oldTemplatePath);
  const newT = readTemplate(newTemplatePath);
  let diff = fullDiff(oldT, newT);

  // Mangle filter (same as printStackDiff)
  if (diff.differenceCount && !strict) {
    const mangledNew = JSON.parse(mangleLikeCloudFormation(JSON.stringify(newT)));
    const mangledDiff = fullDiff(oldT, mangledNew);
    if (diff.differenceCount - mangledDiff.differenceCount > 0) {
      diff = mangledDiff;
    }
  }

  // Filter CDK::Metadata
  if (diff.resources && !strict) {
    diff.resources = diff.resources.filter(
      c => !c || (c.newResourceType !== 'AWS::CDK::Metadata' && c.oldResourceType !== 'AWS::CDK::Metadata'),
    );
  }

  return serializeTemplateDiff(diff);
}

function serializeTemplateDiff(diff: TemplateDiff): StructuredStackDiff {
  const resources: ResourceChange[] = [];
  diff.resources.forEachDifference((logicalId: string, change) => {
    const props: Record<string, PropertyChange> = {};
    if (change.propertyUpdates) {
      for (const [prop, pd] of Object.entries(change.propertyUpdates)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = pd as any;
        props[prop] = {
          oldValue: d.oldValue,
          newValue: d.newValue,
          changeImpact: d.changeImpact === 'NO_CHANGE' && d.isDifferent ? 'WILL_UPDATE' : d.changeImpact,
          isProperty: true,
        };
      }
    }
    // Capture non-property changes (DependsOn, Metadata, etc.)
    if (change.otherChanges) {
      for (const [key, od] of Object.entries(change.otherChanges)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const o = od as any;
        if (o.isDifferent) {
          props[key] = { oldValue: o.oldValue, newValue: o.newValue, changeImpact: 'WILL_UPDATE', isProperty: false };
        }
      }
    }

    resources.push({
      logicalId,
      resourceType: change.resourceType ?? change.newResourceType ?? change.oldResourceType ?? 'Unknown',
      changeImpact: change.changeImpact === 'NO_CHANGE' && change.isUpdate ? 'WILL_UPDATE' : change.changeImpact,
      action: change.isAddition ? 'create' : change.isRemoval ? 'delete' : 'modify',
      properties: props,
      oldResource: change.oldValue,
      newResource: change.newValue,
    });
  });

  const parameters: SectionChange[] = [];
  diff.parameters.forEachDifference((key: string, d) => {
    parameters.push({ key, oldValue: d.oldValue, newValue: d.newValue });
  });

  const outputs: SectionChange[] = [];
  diff.outputs.forEachDifference((key: string, d) => {
    outputs.push({ key, oldValue: d.oldValue, newValue: d.newValue });
  });

  const conditions: SectionChange[] = [];
  diff.conditions.forEachDifference((key: string, d) => {
    conditions.push({ key, oldValue: d.oldValue, newValue: d.newValue });
  });

  // Extract IAM and SG rule tables from CDK diff
  let iamStatements: string[][] | undefined;
  let securityGroupRules: string[][] | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iam = diff.iamChanges as any;
    if (iam?.hasChanges && typeof iam.summarizeStatements === 'function') {
      iamStatements = iam.summarizeStatements();
    }
  } catch {
    /* ignore */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sg = diff.securityGroupChanges as any;
    if (sg?.hasChanges && typeof sg.summarize === 'function') {
      securityGroupRules = sg.summarize();
    }
  } catch {
    /* ignore */
  }

  return {
    resources,
    parameters,
    outputs,
    conditions,
    iamStatements,
    securityGroupRules,
    differenceCount: diff.differenceCount,
    isEmpty: diff.isEmpty,
  };
}
/**
 * Pretty-prints the differences between two template states to the console.
 *
 * @param oldTemplate the old/current state of the stack.
 * @param newTemplate the new/target state of the stack.
 * @param strict      do not filter out AWS::CDK::Metadata
 * @param context     lines of context to use in arbitrary JSON diff
 * @param quiet       silences \'There were no differences\' messages
 *
 * @returns the count of differences that were rendered.
 */
export function printStackDiff(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldTemplate: any,
  newTemplate: string,
  strict: boolean,
  context: number,
  quiet: boolean,
  changeSet?: DescribeChangeSetOutput,
  stream?: FormatStream,
): number {
  let diff = fullDiff(readTemplate(oldTemplate), readTemplate(newTemplate));

  // detect and filter out mangled characters from the diff
  let filteredChangesCount = 0;
  if (diff.differenceCount && !strict) {
    const mangledNewTemplate = JSON.parse(mangleLikeCloudFormation(JSON.stringify(readTemplate(newTemplate))));
    const mangledDiff = fullDiff(readTemplate(oldTemplate), mangledNewTemplate, changeSet);
    filteredChangesCount = Math.max(0, diff.differenceCount - mangledDiff.differenceCount);
    if (filteredChangesCount > 0) {
      diff = mangledDiff;
    }
  }

  // filter out 'AWS::CDK::Metadata' resources from the template
  if (diff.resources && !strict) {
    diff.resources = diff.resources.filter(change => {
      if (!change) {
        return true;
      }
      if (change.newResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      if (change.oldResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      return true;
    });
  }

  // filter out 'AWS::CDK::Metadata' resources from the template
  if (diff.resources && !strict) {
    diff.resources = diff.resources.filter(change => {
      if (!change) {
        return true;
      }
      if (change.newResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      if (change.oldResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      return true;
    });
  }

  if (!diff.isEmpty) {
    formatDifferences(
      stream || process.stderr,
      diff,
      {
        ...logicalIdMapFromTemplate(oldTemplate),
        ...logicalIdMapFromTemplate(newTemplate),
      },
      context,
    );
  } else if (!quiet) {
    stream?.write('There were no differences');
  }

  return diff.differenceCount;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logicalIdMapFromTemplate(template: any) {
  const ret: Record<string, string> = {};

  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (resource as any)?.Metadata?.['aws:cdk:path'];
    if (path) {
      ret[logicalId] = path;
    }
  }
  return ret;
}

function readTemplate(input: string) {
  try {
    return JSON.parse(fs.readFileSync(input, { encoding: 'utf-8' }));
  } catch (e) {
    logger.error(`Error reading template: ${input}`);
    const fileContents = fs.readFileSync(input, { encoding: 'utf-8' });
    logger.error(`File Content: \n\n${fileContents}\n\n Exception: ${e}\n`);

    throw e;
  }
}
