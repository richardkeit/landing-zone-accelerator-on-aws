# Pipeline Diagnostics Collection

When an LZA pipeline action fails, the pipeline automatically collects troubleshooting artifacts and uploads them as a zip file to the pipeline S3 bucket. This eliminates the need to manually gather logs and configuration files from multiple sources.

## How it works

The pipeline's ToolkitProject CodeBuild buildspec includes a `post_build` phase that runs after every action. When the build phase fails (`CODEBUILD_BUILD_SUCCEEDING=0`), a diagnostic collection script executes and:

1. Copies the **debug.log** file from the CodeBuild filesystem (the full verbose log produced by the LZA logger).
2. Copies the **current configuration files** from the pipeline's Config source artifact.
3. Downloads the **last successful configuration** artifact from the most recent successful pipeline execution via CodePipeline APIs.
4. Packages everything into a zip and uploads it to S3.

On successful builds, the script exits immediately with no overhead.

## Accessing diagnostics

After a pipeline failure, download the diagnostics zip from S3:

```bash
aws s3 cp s3://<pipeline-bucket>/AWSAccelerator-Pipel/debug/<timestamp>-<stage>-logs.zip .
```

The exact S3 path is printed in the CodeBuild logs at the end of the failed build.

!!! tip "Finding the bucket name"
    The pipeline bucket follows the naming pattern `aws-accelerator-pipeline-<account-id>-<region>`. If you use a custom qualifier, the pattern is `<qualifier>-pipeline-<account-id>-<region>`.

## Zip contents

```
20260527T142517Z-organizations-logs.zip
├── debug.log                    # Full verbose debug log from the failed build
├── current-config/              # Config files active during this execution
│   ├── global-config.yaml
│   ├── network-config.yaml
│   ├── security-config.yaml
│   └── ...
└── last-successful-config/      # Config from last successful pipeline run
    ├── global-config.yaml
    ├── network-config.yaml
    ├── security-config.yaml
    └── ...
```

!!! note
    If no previous successful pipeline execution exists (e.g., first deployment), the `last-successful-config/` directory will be empty.

## Forcing diagnostics collection

For testing or proactive debugging, you can trigger diagnostic collection on a successful build by setting the `FORCE_DIAGNOSTICS` environment variable:

```bash
aws codebuild start-build \
  --project-name AWSAccelerator-ToolkitProject \
  --environment-variables-override \
    name=FORCE_DIAGNOSTICS,value=true,type=PLAINTEXT
```

Or add it as an environment variable override when starting a pipeline execution manually.

## Stages covered

Diagnostics collection runs for all pipeline actions that use the ToolkitProject:

| Stage | Actions |
|-------|---------|
| Prepare | Prepare |
| Accounts | Accounts |
| Bootstrap | All bootstrap actions (Key, Logging, Organizations, etc.) |
| Logging | Key, Logging |
| Organization | Organizations |
| SecurityAudit | Security_Audit |
| Deploy | All deploy actions |

## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| "WARNING: Failed to upload diagnostics zip" | Bucket name mismatch or permissions issue | Verify the pipeline bucket exists and the ToolkitProject role has `s3:PutObject` access |
| `last-successful-config/` is empty | No prior successful execution or CodePipeline API throttling | Expected on first deployment; retry if throttled |
| No diagnostics zip produced | Build succeeded (script is a no-op) | Use `FORCE_DIAGNOSTICS=true` to test |
