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
  hasChanges,
  stripAnsi,
  parseStackIdentifiers,
  parseResourceChanges,
  generateImpactReport,
  generateReportJs,
  readDiffFiles,
  compressDiffs,
  generateMetaJs,
  generateHtml,
  assembleHtml,
  DELIMITER,
  DiffEntry,
} from '../../lib/diff-viewer/generate-diff-viewer';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-viewer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDiff(name: string, content: string) {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

function gunzip(b64: string): string {
  return zlib.gunzipSync(new Uint8Array(Buffer.from(b64, 'base64'))).toString('utf-8');
}

describe('extractSection', () => {
  it('extracts section from standard LZA filename', () => {
    expect(extractSection('AWSAccelerator-NetworkVpcStack-123456789012-us-east-1.diff')).toBe('NetworkVpc');
  });

  it('extracts section from custom prefix', () => {
    expect(extractSection('MyOrg-SecurityStack-111111111111-eu-west-1.diff')).toBe('Security');
  });

  it('returns "other" when no Stack segment found', () => {
    expect(extractSection('some-random-file.diff')).toBe('other');
  });

  it('handles multiple hyphens in prefix', () => {
    expect(extractSection('My-Custom-Prefix-LoggingStack-999999999999-ap-southeast-1.diff')).toBe('Logging');
  });

  it('handles filename without .diff extension', () => {
    expect(extractSection('AWSAccelerator-KeyStack-123456789012-us-east-1')).toBe('Key');
  });

  it('picks the first segment ending in Stack', () => {
    expect(extractSection('AWSAccelerator-PrepareStack-SubStack-123456789012-us-east-1.diff')).toBe('Prepare');
  });
});

describe('hasChanges', () => {
  it('returns true when content has actual changes', () => {
    expect(hasChanges('[+] AWS::EC2::Subnet NewSubnet')).toBe(true);
  });

  it('returns false when content says no differences', () => {
    expect(hasChanges('There were no differences')).toBe(false);
  });

  it('returns false when no-differences message is embedded in other text', () => {
    expect(hasChanges('Stack MyStack\nThere were no differences\nDone')).toBe(false);
  });

  it('returns true for empty content', () => {
    expect(hasChanges('')).toBe(true);
  });

  it('returns false when only change is Lambda S3Key', () => {
    const content = [
      '[~] AWS::Lambda::Function CustomSsmGetParameterValueCustomResourceProviderHandlerAAD0E7EE',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] 058264169574/95d847da92ba195c8b0334d35136aa7cf8496e3f0a99cf5acd7a70e5263accd7.zip',
      '        └─ [+] 058264169574/a63a7049c83d3a1671e73e64f15eb163c1ab88b352e314b440381cb58b34cc56.zip',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns false when multiple Lambda S3Key-only changes', () => {
    const content = [
      '[~] AWS::Lambda::Function FunctionA',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] acct/old-hash.zip',
      '        └─ [+] acct/new-hash.zip',
      '[~] AWS::Lambda::Function FunctionB',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] acct/old-hash2.zip',
      '        └─ [+] acct/new-hash2.zip',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns false for real diff output with Stack/Resources headers', () => {
    const content = [
      'Stack: AWSAccelerator-LoggingStack-058264169574-ap-northeast-1',
      'Resources',
      '[~] AWS::Lambda::Function CustomSsmGetParameterValueCustomResourceProviderHandlerAAD0E7EE',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] 058264169574/95d847da92ba195c8b0334d35136aa7cf8496e3f0a99cf5acd7a70e5263accd7.zip',
      '        └─ [+] 058264169574/a63a7049c83d3a1671e73e64f15eb163c1ab88b352e314b440381cb58b34cc56.zip',
      '[~] AWS::Lambda::Function CustomUpdateSubscriptionFilterCustomResourceProviderHandler1BAA7608',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] 058264169574/6ff2eaad63c68cdec19ef5020ba7b680aae78243d69d00c00ce0dadd2fae2d11.zip',
      '        └─ [+] 058264169574/a7a9f0a6748cabb54974d93e560d20cc61620e3ea8ba88ea3a31f25a1fe0dc38.zip',
      '[~] AWS::Lambda::Function NewCloudWatchLogsCreateEventSetLogRetentionSubscriptionFunction1A3BCE58',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] 058264169574/0b0200e309b67bdff34caa87b22440a6e19e64f52004aee5fd0b702fff33ffd0.zip',
      '        └─ [+] 058264169574/9f73f80f23d0a0796e93998289e18570ef3bc6e5d323f4c3fec5999d9ed8ba85.zip',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns true when Lambda S3Key change is mixed with other changes', () => {
    const content = [
      '[~] AWS::Lambda::Function FunctionA',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] acct/old-hash.zip',
      '        └─ [+] acct/new-hash.zip',
      '[+] AWS::EC2::Subnet NewSubnet',
    ].join('\n');
    expect(hasChanges(content)).toBe(true);
  });

  it('returns true when Lambda has non-S3Key property changes', () => {
    const content = [
      '[~] AWS::Lambda::Function FunctionA',
      '  ├─ [~] Code',
      '  │   └─ [~] .S3Key:',
      '  │       ├─ [-] acct/old-hash.zip',
      '  │       └─ [+] acct/new-hash.zip',
      '  └─ [~] .Timeout',
      '      ├─ [-] 30',
      '      └─ [+] 60',
    ].join('\n');
    expect(hasChanges(content)).toBe(true);
  });

  it('returns false when only change is CustomResource uuid', () => {
    const content = [
      '[~] AWS::CloudFormation::CustomResource MyCustomResource8CAF910B',
      '  └─ [~] uuid',
      '      ├─ [-] 2cd613f4-2bdb-4458-97b4-ee184f2532de',
      '      └─ [+] a8a483aa-3a4d-4624-97bc-eb037ea51207',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns false when only change is Custom:: prefixed resource uuid', () => {
    const content = [
      'Stack: AWSAccelerator-OperationsStack-058264169574-us-west-2',
      'Resources',
      '[~] Custom::SsmGetParameterValue AssetsBucketKmsLookup24313A2E',
      '  └─ [~] uuid',
      '      ├─ [-] 8342bd5c-7fbe-4159-94bb-4902823a7ef0',
      '      └─ [+] 99365fc6-88e9-4bda-b680-17daf520f819',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns false when mix of Lambda S3Key and CustomResource uuid only', () => {
    const content = [
      '[~] AWS::Lambda::Function FunctionA',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] acct/old-hash.zip',
      '        └─ [+] acct/new-hash.zip',
      '[~] AWS::CloudFormation::CustomResource MyCustomResource8CAF910B',
      '  └─ [~] uuid',
      '      ├─ [-] old-uuid',
      '      └─ [+] new-uuid',
    ].join('\n');
    expect(hasChanges(content)).toBe(false);
  });

  it('returns true when CustomResource has non-uuid changes', () => {
    const content = [
      '[~] AWS::CloudFormation::CustomResource MyCustomResource8CAF910B',
      '  ├─ [~] uuid',
      '  │   ├─ [-] old-uuid',
      '  │   └─ [+] new-uuid',
      '  └─ [~] SomeOtherProp',
      '      ├─ [-] old',
      '      └─ [+] new',
    ].join('\n');
    expect(hasChanges(content)).toBe(true);
  });
});

describe('readDiffFiles', () => {
  it('reads and parses diff files from directory', () => {
    writeDiff('AWSAccelerator-NetworkVpcStack-123-us-east-1.diff', '[+] AWS::EC2::VPC');
    writeDiff('AWSAccelerator-SecurityStack-123-us-east-1.diff', 'There were no differences');

    const entries = readDiffFiles(tmpDir);
    expect(entries).toHaveLength(2);

    const network = entries.find(e => e.section === 'NetworkVpc')!;
    expect(network.name).toBe('AWSAccelerator-NetworkVpcStack-123-us-east-1');
    expect(network.hasChanges).toBe(true);
    expect(network.content).toBe('[+] AWS::EC2::VPC');

    const security = entries.find(e => e.section === 'Security')!;
    expect(security.hasChanges).toBe(false);
  });

  it('ignores non-.diff files', () => {
    writeDiff('AWSAccelerator-KeyStack-123-us-east-1.diff', 'changes');
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a diff');

    const entries = readDiffFiles(tmpDir);
    expect(entries).toHaveLength(1);
  });

  it('returns empty array for directory with no diff files', () => {
    const entries = readDiffFiles(tmpDir);
    expect(entries).toHaveLength(0);
  });

  it('returns entries sorted by filename', () => {
    writeDiff('B-SecurityStack-123-us-east-1.diff', 'b');
    writeDiff('A-NetworkVpcStack-123-us-east-1.diff', 'a');

    const entries = readDiffFiles(tmpDir);
    expect(entries[0].section).toBe('NetworkVpc');
    expect(entries[1].section).toBe('Security');
  });
});

describe('compressDiffs', () => {
  it('compresses entries into a gzipped base64 blob', () => {
    const entries: DiffEntry[] = [
      { section: 'NetworkVpc', name: 'stack-a', hasChanges: true, content: 'content-a' },
      { section: 'Security', name: 'stack-b', hasChanges: false, content: 'content-b' },
    ];

    const { blob, meta } = compressDiffs(entries);

    // Verify meta strips content
    expect(meta).toHaveLength(2);
    expect(meta[0]).toEqual({ section: 'NetworkVpc', name: 'stack-a', hasChanges: true });
    expect(meta[1]).toEqual({ section: 'Security', name: 'stack-b', hasChanges: false });
    expect((meta[0] as unknown as Record<string, unknown>)['content']).toBeUndefined();

    // Verify blob decompresses to original content joined by delimiter
    const decompressed = gunzip(blob);
    const parts = decompressed.split(`\n${DELIMITER}\n`);
    expect(parts).toEqual(['content-a', 'content-b']);
  });

  it('handles single entry', () => {
    const entries: DiffEntry[] = [{ section: 'Key', name: 'only-stack', hasChanges: true, content: 'only-content' }];

    const { blob, meta } = compressDiffs(entries);
    expect(meta).toHaveLength(1);

    const decompressed = gunzip(blob);
    expect(decompressed).toBe('only-content');
  });

  it('preserves content with special characters', () => {
    const content = '[+] AWS::EC2::VPC\n  └─ [~] CidrBlock\n    ├─ [-] 10.0.0.0/16\n    └─ [+] 10.1.0.0/16';
    const entries: DiffEntry[] = [{ section: 'NetworkVpc', name: 'stack', hasChanges: true, content }];

    const { blob } = compressDiffs(entries);
    const decompressed = gunzip(blob);
    expect(decompressed).toBe(content);
  });
});

describe('generateMetaJs', () => {
  it('generates valid JS array string', () => {
    const meta = [
      { section: 'NetworkVpc', name: 'stack-a', hasChanges: true },
      { section: 'Security', name: 'stack-b', hasChanges: false },
    ];

    const js = generateMetaJs(meta);
    expect(js).toContain('const diffMeta = [');
    expect(js).toContain('{s:"NetworkVpc",n:"stack-a",c:true}');
    expect(js).toContain('{s:"Security",n:"stack-b",c:false}');
    expect(js).toContain('];');
  });

  it('handles empty array', () => {
    const js = generateMetaJs([]);
    expect(js).toBe('const diffMeta = [\n\n];');
  });
});

describe('assembleHtml', () => {
  it('replaces all placeholders in the shell template', () => {
    const templatesDir = path.join(__dirname, '../../lib/diff-viewer/templates');
    const html = assembleHtml('const testData = 42;', templatesDir);

    // Shell placeholders replaced
    expect(html).not.toContain('{{STYLES}}');
    expect(html).not.toContain('{{DATA}}');
    expect(html).not.toContain('{{SCRIPT}}');

    // Content injected
    expect(html).toContain('const testData = 42;');
    expect(html).toContain(':root'); // from styles.css
    expect(html).toContain('function decompressBlob'); // from viewer.js
  });
});

describe('generateHtml', () => {
  it('generates complete HTML with embedded data', () => {
    writeDiff('AWSAccelerator-NetworkVpcStack-123-us-east-1.diff', '[+] AWS::EC2::VPC NewVpc');
    writeDiff('AWSAccelerator-SecurityStack-456-us-west-2.diff', 'There were no differences');

    const html = generateHtml(tmpDir);

    // Structure checks
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>LZA CDK Diff Viewer</title>');
    expect(html).toContain('</html>');

    // Metadata embedded
    expect(html).toContain('const diffMeta = [');
    expect(html).toContain('{s:"NetworkVpc"');
    expect(html).toContain('{s:"Security"');

    // Blob embedded
    expect(html).toContain('const diffBlob = "');
    expect(html).toContain(`const DELIM = "${DELIMITER}";`);

    // JS functions present
    expect(html).toContain('function decompressBlob');
    expect(html).toContain('function ansiToHtml');
    expect(html).toContain('function renderSidebar');
    expect(html).toContain('function showDiff');
  });

  it('throws when no diff files exist', () => {
    expect(() => generateHtml(tmpDir)).toThrow('No .diff files found');
  });

  it('produces decompressible blob in the HTML', () => {
    writeDiff('Prefix-LoggingStack-111-us-east-1.diff', 'logging content here');

    const html = generateHtml(tmpDir);

    // Extract the blob from the HTML
    const blobMatch = html.match(/const diffBlob = "([^"]+)"/);
    expect(blobMatch).not.toBeNull();

    const decompressed = gunzip(blobMatch![1]);
    expect(decompressed).toContain('logging content here');
  });
});

describe('generateHtml - performance', () => {
  const PERF_DIR = path.join(os.tmpdir(), 'diff-viewer-test', 'rawDiff');
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

  // Resource type pools for realistic variety
  const addResources = [
    (id: number) => `\x1b[32m[+] AWS::EC2::Subnet Subnet${id} Subnet${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::EC2::RouteTable RouteTable${id} RouteTable${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::S3::Bucket Bucket${id} Bucket${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::IAM::Role Role${id} Role${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::SNS::Topic Topic${id} Topic${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::SQS::Queue Queue${id} Queue${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::KMS::Key Key${id} Key${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[32m[+] AWS::Logs::LogGroup LogGroup${id} LogGroup${id}/Resource\x1b[39m`,
  ];

  const modifyResources = [
    (id: number) => [
      `\x1b[33m[~] AWS::Lambda::Function Function${id} Function${id}/Resource\x1b[39m`,
      `\x1b[33m └─ [~] Runtime\x1b[39m`,
      `\x1b[31m     ├─ [-] nodejs16.x\x1b[39m`,
      `\x1b[32m     └─ [+] nodejs20.x\x1b[39m`,
    ],
    (id: number) => [
      `\x1b[33m[~] AWS::EC2::SecurityGroup SG${id} SG${id}/Resource\x1b[39m`,
      `\x1b[33m └─ [~] SecurityGroupIngress\x1b[39m`,
      `\x1b[31m     ├─ [-] {"CidrIp":"10.0.0.0/8","FromPort":443}\x1b[39m`,
      `\x1b[32m     └─ [+] {"CidrIp":"10.0.0.0/16","FromPort":443}\x1b[39m`,
    ],
    (id: number) => [
      `\x1b[33m[~] AWS::ECS::TaskDefinition Task${id} Task${id}/Resource\x1b[39m`,
      `\x1b[33m └─ [~] ContainerDefinitions\x1b[39m`,
      `\x1b[33m     └─ [~] .0\x1b[39m`,
      `\x1b[33m         └─ [~] Image\x1b[39m`,
      `\x1b[31m             ├─ [-] 123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1.2.3\x1b[39m`,
      `\x1b[32m             └─ [+] 123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1.3.0\x1b[39m`,
    ],
    (id: number) => [
      `\x1b[33m[~] AWS::IAM::Policy Policy${id} Policy${id}/Resource\x1b[39m`,
      `\x1b[33m └─ [~] PolicyDocument\x1b[39m`,
      `\x1b[33m     └─ [~] .Statement\x1b[39m`,
      `\x1b[33m         └─ [~] .0\x1b[39m`,
      `\x1b[33m             └─ [~] Resource\x1b[39m`,
      `\x1b[31m                 ├─ [-] arn:aws:s3:::my-bucket/*\x1b[39m`,
      `\x1b[32m                 └─ [+] arn:aws:s3:::my-bucket-v2/*\x1b[39m`,
    ],
    (id: number) => [
      `\x1b[33m[~] AWS::CloudWatch::Alarm Alarm${id} Alarm${id}/Resource\x1b[39m`,
      `\x1b[33m └─ [~] Threshold\x1b[39m`,
      `\x1b[31m     ├─ [-] 80\x1b[39m`,
      `\x1b[32m     └─ [+] 90\x1b[39m`,
      `\x1b[33m └─ [~] EvaluationPeriods\x1b[39m`,
      `\x1b[31m     ├─ [-] 3\x1b[39m`,
      `\x1b[32m     └─ [+] 5\x1b[39m`,
    ],
  ];

  const removeResources = [
    (id: number) => `\x1b[31m[-] AWS::EC2::SecurityGroup SecurityGroup${id} SecurityGroup${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[31m[-] AWS::CloudFormation::CustomResource Custom${id} Custom${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[31m[-] AWS::SSM::Parameter Param${id} Param${id}/Resource\x1b[39m`,
    (id: number) => `\x1b[31m[-] AWS::Route53::RecordSet Record${id} Record${id}/Resource\x1b[39m`,
  ];

  // Simple seeded PRNG for deterministic output
  function seededRng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return s / 2147483647;
    };
  }

  function buildDiffBody(stackIndex: number): string {
    const rng = seededRng(stackIndex * 7 + 13);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
    // ~20% of stacks are large (150–250 resources → 10–20KB), rest are 10–60
    const isLarge = rng() < 0.2;
    const count = isLarge ? 150 + Math.floor(rng() * 100) : 10 + Math.floor(rng() * 50);
    const lines: string[] = [];
    for (let r = 0; r < count; r++) {
      const roll = rng();
      if (roll < 0.4) {
        // addition
        lines.push(pick(addResources)(r));
      } else if (roll < 0.75) {
        // modification (multi-line)
        lines.push(...pick(modifyResources)(r));
      } else {
        // removal
        lines.push(pick(removeResources)(r));
      }
    }
    return `\x1b[1mStack Resources\x1b[22m\n${lines.join('\n')}`;
  }

  function ensurePerfFiles() {
    if (fs.existsSync(PERF_DIR) && fs.readdirSync(PERF_DIR).some(f => f.endsWith('.diff'))) {
      return;
    }
    fs.mkdirSync(PERF_DIR, { recursive: true });

    for (let i = 0; i < TOTAL; i++) {
      const sec = sections[i % sections.length];
      const reg = regions[Math.floor(i / sections.length) % regions.length];
      const acct = (100000000000 + i).toString();
      const name = `AWSAccelerator-${sec}Stack-${acct}-${reg}`;

      // ~15% of stacks have no changes
      if (i % 7 === 0) {
        fs.writeFileSync(path.join(PERF_DIR, `${name}.diff`), `Stack ${name}\nThere were no differences\n`);
      } else {
        fs.writeFileSync(path.join(PERF_DIR, `${name}.diff`), `Stack ${name}\n${buildDiffBody(i)}\n`);
      }
    }
  }

  it('generates HTML for 200 large stacks', () => {
    ensurePerfFiles();

    const start = Date.now();
    const html = generateHtml(PERF_DIR);
    const elapsed = (Date.now() - start) / 1000;

    const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`Performance: ${TOTAL} stacks in ${elapsed.toFixed(2)}s, output ${sizeKB}KB`);

    expect(html).toContain('const diffMeta = [');
    expect(html).toContain('const diffBlob = "');
    expect(html).toContain('</html>');
    for (const sec of sections) {
      expect(html).toContain(`s:"${sec}"`);
    }
  }, 30_000);
});

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[39m')).toBe('red text');
  });

  it('removes multiple ANSI codes', () => {
    expect(stripAnsi('\x1b[33m[~]\x1b[39m \x1b[36mAWS::Lambda::Function\x1b[39m Foo')).toBe(
      '[~] AWS::Lambda::Function Foo',
    );
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('no ansi here')).toBe('no ansi here');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

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
    expect(parseStackIdentifiers('SomeRandomStack')).toEqual({
      account: 'unknown',
      region: 'unknown',
    });
  });
});

describe('parseResourceChanges', () => {
  it('parses a single modify change', () => {
    const content = [
      '[~] AWS::Lambda::Function MyFunc',
      '  └─ [~] Code',
      '    └─ [~] .S3Key:',
      '        ├─ [-] old.zip',
      '        └─ [+] new.zip',
    ].join('\n');
    const changes = parseResourceChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].resourceType).toBe('AWS::Lambda::Function');
    expect(changes[0].logicalId).toBe('MyFunc');
    expect(changes[0].action).toBe('modify');
  });

  it('parses create and delete actions', () => {
    const content = ['[+] AWS::EC2::Subnet NewSubnet', '[-] AWS::IAM::Role OldRole'].join('\n');
    const changes = parseResourceChanges(content);
    expect(changes).toHaveLength(2);
    expect(changes[0].action).toBe('create');
    expect(changes[1].action).toBe('delete');
  });

  it('parses multiple resources with properties', () => {
    const content = [
      '[~] AWS::KMS::Key MyKey',
      ' │ [~] .KeyPolicy:',
      '[~] AWS::S3::Bucket MyBucket',
      ' │ [~] .Tags:',
    ].join('\n');
    const changes = parseResourceChanges(content);
    expect(changes).toHaveLength(2);
    expect(changes[0].properties).toContain('KeyPolicy');
    expect(changes[1].properties).toContain('Tags');
  });

  it('handles ANSI codes in content', () => {
    const content = '\x1b[33m[~]\x1b[39m \x1b[36mAWS::Lambda::Function\x1b[39m MyFunc\n  └─ \x1b[33m[~]\x1b[39m Code';
    const changes = parseResourceChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].resourceType).toBe('AWS::Lambda::Function');
  });

  it('returns empty array for no-diff content', () => {
    expect(parseResourceChanges('There were no differences')).toEqual([]);
  });
});

describe('generateImpactReport', () => {
  it('generates report with correct counts', () => {
    const entries: DiffEntry[] = [
      {
        section: 'Security',
        name: 'AWSAccelerator-SecurityStack-123456789012-us-east-1',
        hasChanges: true,
        content: '[+] AWS::EC2::SecurityGroup NewSG\n[-] AWS::EC2::SecurityGroup OldSG',
      },
      {
        section: 'Logging',
        name: 'AWSAccelerator-LoggingStack-123456789012-us-west-2',
        hasChanges: false,
        content: 'There were no differences',
      },
    ];
    const report = generateImpactReport(entries);
    expect(report.totalStacks).toBe(2);
    expect(report.stacksWithChanges).toBe(1);
    expect(report.resourceCounts.creates).toBe(1);
    expect(report.resourceCounts.deletes).toBe(1);
    expect(report.accountsAffected).toContain('123456789012');
    expect(report.regionsAffected).toContain('us-east-1');
  });

  it('flags high-risk resource changes', () => {
    const entries: DiffEntry[] = [
      {
        section: 'NetworkVpc',
        name: 'AWSAccelerator-NetworkVpcStack-123456789012-us-east-1',
        hasChanges: true,
        content: '[-] AWS::EC2::VPC MyVpc\n[~] AWS::EC2::TransitGateway MyTgw\n  └─ [~] .Tags:',
      },
    ];
    const report = generateImpactReport(entries);
    expect(report.highRiskChanges.length).toBeGreaterThan(0);
    const types = report.highRiskChanges.map(h => h.resourceType);
    expect(types).toContain('AWS::EC2::VPC');
    expect(types).toContain('AWS::EC2::TransitGateway');
  });

  it('filters out Lambda S3Key noise from impact report', () => {
    const entries: DiffEntry[] = [
      {
        section: 'Logging',
        name: 'AWSAccelerator-LoggingStack-123456789012-us-east-1',
        hasChanges: true,
        content: [
          '[~] AWS::Lambda::Function MyFunc',
          '  └─ [~] Code',
          '    └─ [~] .S3Key:',
          '        ├─ [-] old.zip',
          '        └─ [+] new.zip',
        ].join('\n'),
      },
    ];
    const report = generateImpactReport(entries);
    expect(report.stacksWithChanges).toBe(0);
  });

  it('filters out CustomResource uuid noise from impact report', () => {
    const entries: DiffEntry[] = [
      {
        section: 'Logging',
        name: 'AWSAccelerator-LoggingStack-123456789012-us-east-1',
        hasChanges: true,
        content: ['[~] Custom::S3CreateBucketPrefix MyResource', ' │ [~] uuid'].join('\n'),
      },
    ];
    const report = generateImpactReport(entries);
    expect(report.stacksWithChanges).toBe(0);
  });

  it('returns empty report for no entries', () => {
    const report = generateImpactReport([]);
    expect(report.totalStacks).toBe(0);
    expect(report.stacksWithChanges).toBe(0);
    expect(report.highRiskChanges).toEqual([]);
  });
});

describe('generateReportJs', () => {
  it('generates valid JS assignment', () => {
    const report = generateImpactReport([]);
    const js = generateReportJs(report);
    expect(js).toContain('const impactReport = ');
    expect(js).toContain('"totalStacks":0');
  });

  it('serializes report as valid JSON', () => {
    const entries: DiffEntry[] = [
      {
        section: 'Security',
        name: 'AWSAccelerator-SecurityStack-123456789012-us-east-1',
        hasChanges: true,
        content: '[+] AWS::EC2::SecurityGroup NewSG',
      },
    ];
    const report = generateImpactReport(entries);
    const js = generateReportJs(report);
    const jsonStr = js.replace('const impactReport = ', '').replace(/;$/, '');
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });
});
