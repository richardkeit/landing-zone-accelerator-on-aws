#!/bin/bash
# collect-diagnostics.sh
# Runs in post_build phase. Collects debug info on failure and uploads to S3.

if [ "$CODEBUILD_BUILD_SUCCEEDING" = "1" ] && [ "$FORCE_DIAGNOSTICS" != "true" ]; then
  exit 0
fi

echo "=========================================="
echo "Build failed — collecting diagnostics..."
echo "=========================================="

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DIAG_DIR="/tmp/diagnostics-$$"
ZIP_NAME="${TIMESTAMP}-${ACCELERATOR_STAGE}-logs.zip"
PIPELINE_BUCKET="${ACCELERATOR_BUCKET_NAME_PREFIX}-pipeline-${PIPELINE_ACCOUNT_ID}-${AWS_REGION}"

if [ -n "$ACCELERATOR_QUALIFIER" ] && [ "$ACCELERATOR_QUALIFIER" != "aws-accelerator" ]; then
  PIPELINE_BUCKET="${ACCELERATOR_QUALIFIER}-pipeline-${PIPELINE_ACCOUNT_ID}-${AWS_REGION}"
fi

PIPELINE_NAME="${ACCELERATOR_PREFIX}-Pipeline"
if [ -n "$ACCELERATOR_QUALIFIER" ] && [ "$ACCELERATOR_QUALIFIER" != "aws-accelerator" ]; then
  PIPELINE_NAME="${ACCELERATOR_QUALIFIER}-pipeline"
fi

S3_KEY="${PIPELINE_NAME:0:20}/debug/${ZIP_NAME}"
rm -rf "$DIAG_DIR"
mkdir -p "$DIAG_DIR/current-config" "$DIAG_DIR/last-successful-config"

# 1. Collect debug.log
if [ -f "$WORK_DIR/debug.log" ]; then
  cp "$WORK_DIR/debug.log" "$DIAG_DIR/"
  echo "Collected debug.log"
else
  echo "No debug.log found at $WORK_DIR/debug.log"
fi

# 2. Collect current config
if [ -d "$CODEBUILD_SRC_DIR_Config" ]; then
  cp -r "$CODEBUILD_SRC_DIR_Config"/* "$DIAG_DIR/current-config/" 2>/dev/null
  echo "Collected current config"
fi

# 3. Collect last successful config artifact

LAST_SUCCESS_ID=$(aws codepipeline list-pipeline-executions \
  --pipeline-name "$PIPELINE_NAME" \
  --query "pipelineExecutionSummaries[?status=='Succeeded'] | [0].pipelineExecutionId" \
  --output text 2>/dev/null)

if [ -n "$LAST_SUCCESS_ID" ] && [ "$LAST_SUCCESS_ID" != "None" ]; then
  echo "Last successful execution: $LAST_SUCCESS_ID"
  ARTIFACT_LOCATION=$(aws codepipeline list-action-executions \
    --pipeline-name "$PIPELINE_NAME" \
    --filter "pipelineExecutionId=$LAST_SUCCESS_ID" \
    --query "actionExecutionDetails[?actionName=='Configuration' || actionName=='Source-Config'].output.outputArtifacts[] | [?name=='Config'].s3location | [0]" \
    --output json 2>/dev/null)

  if [ -n "$ARTIFACT_LOCATION" ] && [ "$ARTIFACT_LOCATION" != "null" ]; then
    ARTIFACT_BUCKET=$(echo "$ARTIFACT_LOCATION" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('bucket',''))" 2>/dev/null)
    ARTIFACT_KEY=$(echo "$ARTIFACT_LOCATION" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null)

    if [ -n "$ARTIFACT_BUCKET" ] && [ -n "$ARTIFACT_KEY" ]; then
      aws s3 cp "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" "$DIAG_DIR/last-successful-config/config.zip" 2>/dev/null
      if [ $? -eq 0 ]; then
        cd "$DIAG_DIR/last-successful-config"
        unzip -qo config.zip 2>/dev/null
        rm -f config.zip
        cd /tmp
        echo "Collected last successful config"
      fi
    fi
  fi
else
  echo "No previous successful execution found — skipping last successful config"
fi

# 4. Create zip and upload
cd "$DIAG_DIR"
zip -qr "/tmp/${ZIP_NAME}" .
aws s3 cp "/tmp/${ZIP_NAME}" "s3://${PIPELINE_BUCKET}/${S3_KEY}"

if [ $? -eq 0 ]; then
  echo "=========================================="
  echo "Diagnostics uploaded to:"
  echo "  s3://${PIPELINE_BUCKET}/${S3_KEY}"
  echo "Download with:"
  echo "  aws s3 cp s3://${PIPELINE_BUCKET}/${S3_KEY} ./${ZIP_NAME}"
  echo "=========================================="
else
  echo "WARNING: Failed to upload diagnostics zip"
fi

rm -rf "$DIAG_DIR" "/tmp/${ZIP_NAME}"
