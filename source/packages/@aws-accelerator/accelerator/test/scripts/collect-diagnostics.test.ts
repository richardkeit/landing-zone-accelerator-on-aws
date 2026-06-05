import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/collect-diagnostics.sh');

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
}

function runScript(env: Record<string, string>, mockAwsScript?: string): { exitCode: number; stdout: string } {
  const tempDir = env['TEST_TEMP_DIR'] || createTempDir();

  // Create a mock aws CLI if provided
  const mockBinDir = path.join(tempDir, 'mock-bin');
  fs.mkdirSync(mockBinDir, { recursive: true });

  if (mockAwsScript) {
    const awsMockPath = path.join(mockBinDir, 'aws');
    fs.writeFileSync(awsMockPath, mockAwsScript, { mode: 0o755 });
  } else {
    // Default mock that does nothing
    fs.writeFileSync(path.join(mockBinDir, 'aws'), '#!/bin/bash\nexit 0', { mode: 0o755 });
  }

  // Ensure zip is available (use a mock if needed)
  fs.writeFileSync(path.join(mockBinDir, 'zip'), '#!/bin/bash\ntouch "$@" 2>/dev/null; exit 0', { mode: 0o755 });

  const fullEnv = {
    ...env,
    PATH: `${mockBinDir}:${process.env['PATH']}`,
    HOME: tempDir,
  };

  try {
    const stdout = execSync(`bash ${SCRIPT_PATH}`, {
      env: fullEnv,
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { exitCode: 0, stdout };
  } catch (e: unknown) {
    const err = e as { status: number; stdout: string };
    return { exitCode: err.status, stdout: err.stdout || '' };
  }
}

describe('collect-diagnostics.sh', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits immediately with code 0 when build succeeds and FORCE_DIAGNOSTICS is not set', () => {
    const result = runScript({
      CODEBUILD_BUILD_SUCCEEDING: '1',
      WORK_DIR: tempDir,
      TEST_TEMP_DIR: tempDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('collecting diagnostics');
  });

  it('runs diagnostics when build succeeds but FORCE_DIAGNOSTICS is true', () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'debug.log'), 'forced log');

    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const mockAws = `#!/bin/bash
if [[ "$1" == "codepipeline" ]]; then echo "None"; exit 0; fi
exit 0
`;

    const result = runScript(
      {
        CODEBUILD_BUILD_SUCCEEDING: '1',
        FORCE_DIAGNOSTICS: 'true',
        WORK_DIR: workDir,
        CODEBUILD_SRC_DIR_Config: configDir,
        ACCELERATOR_STAGE: 'prepare',
        ACCELERATOR_PREFIX: 'AWSAccelerator',
        ACCELERATOR_BUCKET_NAME_PREFIX: 'aws-accelerator',
        PIPELINE_ACCOUNT_ID: '123456789012',
        AWS_REGION: 'us-east-1',
        TEST_TEMP_DIR: tempDir,
      },
      mockAws,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('collecting diagnostics');
  });

  it('collects debug.log when build fails and debug.log exists', () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'debug.log'), 'test log content');

    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'global-config.yaml'), 'homeRegion: us-east-1');

    const mockAws = `#!/bin/bash
# Mock: codepipeline returns no successful executions, s3 cp succeeds
if [[ "$1" == "codepipeline" && "$2" == "list-pipeline-executions" ]]; then
  echo "None"
  exit 0
fi
if [[ "$1" == "s3" && "$2" == "cp" ]]; then
  exit 0
fi
exit 0
`;

    const result = runScript(
      {
        CODEBUILD_BUILD_SUCCEEDING: '0',
        WORK_DIR: workDir,
        CODEBUILD_SRC_DIR_Config: configDir,
        ACCELERATOR_STAGE: 'organizations',
        ACCELERATOR_PREFIX: 'AWSAccelerator',
        ACCELERATOR_BUCKET_NAME_PREFIX: 'aws-accelerator',
        PIPELINE_ACCOUNT_ID: '123456789012',
        AWS_REGION: 'us-east-1',
        TEST_TEMP_DIR: tempDir,
      },
      mockAws,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('collecting diagnostics');
    expect(result.stdout).toContain('Collected debug.log');
  });

  it('handles missing debug.log gracefully', () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    // No debug.log created

    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const mockAws = `#!/bin/bash
if [[ "$1" == "codepipeline" ]]; then echo "None"; exit 0; fi
exit 0
`;

    const result = runScript(
      {
        CODEBUILD_BUILD_SUCCEEDING: '0',
        WORK_DIR: workDir,
        CODEBUILD_SRC_DIR_Config: configDir,
        ACCELERATOR_STAGE: 'logging',
        ACCELERATOR_PREFIX: 'AWSAccelerator',
        ACCELERATOR_BUCKET_NAME_PREFIX: 'aws-accelerator',
        PIPELINE_ACCOUNT_ID: '123456789012',
        AWS_REGION: 'us-east-1',
        TEST_TEMP_DIR: tempDir,
      },
      mockAws,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No debug.log found');
  });

  it('skips last successful config when no prior successful execution exists', () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'debug.log'), 'log');

    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const mockAws = `#!/bin/bash
if [[ "$1" == "codepipeline" && "$2" == "list-pipeline-executions" ]]; then
  echo "None"
  exit 0
fi
exit 0
`;

    const result = runScript(
      {
        CODEBUILD_BUILD_SUCCEEDING: '0',
        WORK_DIR: workDir,
        CODEBUILD_SRC_DIR_Config: configDir,
        ACCELERATOR_STAGE: 'prepare',
        ACCELERATOR_PREFIX: 'AWSAccelerator',
        ACCELERATOR_BUCKET_NAME_PREFIX: 'aws-accelerator',
        PIPELINE_ACCOUNT_ID: '123456789012',
        AWS_REGION: 'us-east-1',
        TEST_TEMP_DIR: tempDir,
      },
      mockAws,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No previous successful execution found');
  });

  it('uses qualifier-based bucket name when qualifier is set', () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'debug.log'), 'log');

    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    // Track what s3 cp was called with
    const callLog = path.join(tempDir, 'aws-calls.log');
    const mockAws = `#!/bin/bash
echo "$@" >> ${callLog}
if [[ "$1" == "codepipeline" ]]; then echo "None"; exit 0; fi
exit 0
`;

    const result = runScript(
      {
        CODEBUILD_BUILD_SUCCEEDING: '0',
        WORK_DIR: workDir,
        CODEBUILD_SRC_DIR_Config: configDir,
        ACCELERATOR_STAGE: 'security-audit',
        ACCELERATOR_PREFIX: 'AWSAccelerator',
        ACCELERATOR_BUCKET_NAME_PREFIX: 'aws-accelerator',
        ACCELERATOR_QUALIFIER: 'my-qualifier',
        PIPELINE_ACCOUNT_ID: '123456789012',
        AWS_REGION: 'us-east-1',
        TEST_TEMP_DIR: tempDir,
      },
      mockAws,
    );

    expect(result.exitCode).toBe(0);
    const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8') : '';
    expect(calls).toContain('my-qualifier-pipeline-123456789012-us-east-1');
  });
});
