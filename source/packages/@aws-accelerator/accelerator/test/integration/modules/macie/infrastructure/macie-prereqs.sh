#!/bin/bash
set -euo pipefail

# Macie module-specific integration test prerequisites.
#
# Creates a secondary S3 bucket in ca-central-1 (Log Archive account) for testing
# multi-region classification scope exclusion filtering. The Macie
# UpdateClassificationScope API is regional — it only accepts buckets in the
# current AWS Region. This bucket lets the integ test verify that cross-region
# buckets are correctly filtered out.
#
# Idempotent: creates bucket if missing, always ensures encryption, public access
# block, and bucket policy are applied (even if bucket already existed).
#
# Prerequisites:
#   - Caller must already have Log Archive account credentials exported
#     (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
#   - DOTENV_FILE env var must point to the shared dotenv artifact file
#
# Usage (called by deploy-integ-prereqs.sh):
#   macie-prereqs.sh <prefix> <region> <mgmt-account-id> <logarchive-account-id> <partition> <cross-account-role-name>

acceleratorPrefix=$1
region=$2          # primary region (unused here, but kept for consistent interface)
mgmtAccountId=$3   # unused here, kept for consistent interface
logArchiveAccountId=$4
partition=$5       # unused here, kept for consistent interface
crossAccountRoleName=$6  # unused here, kept for consistent interface

SECONDARY_REGION="ca-central-1"
BUCKET_PREFIX=$(echo "${acceleratorPrefix}" | tr '[:upper:]' '[:lower:]')
SECONDARY_BUCKET_NAME="${BUCKET_PREFIX}-integ-test-${logArchiveAccountId}-${SECONDARY_REGION}"
BUCKET_ARN="arn:aws:s3:::${SECONDARY_BUCKET_NAME}"

echo ""
echo "[Macie Prereqs] Ensuring secondary test bucket in ${SECONDARY_REGION}..."
echo "[Macie Prereqs] Bucket name: ${SECONDARY_BUCKET_NAME}"
echo "[Macie Prereqs] Log Archive account: ${logArchiveAccountId}"

# Assume role into Log Archive account
ROLE_ARN="arn:${partition}:iam::${logArchiveAccountId}:role/${crossAccountRoleName}"
echo "[Macie Prereqs] Assuming role: ${ROLE_ARN}"
CREDS=$(aws sts assume-role \
  --role-arn "${ROLE_ARN}" \
  --role-session-name "macie-prereqs" \
  --duration-seconds 3600 \
  --output json)
export AWS_ACCESS_KEY_ID=$(echo "${CREDS}" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "${CREDS}" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "${CREDS}" | jq -r '.Credentials.SessionToken')

# Create bucket if it doesn't exist
if aws s3api head-bucket --bucket "${SECONDARY_BUCKET_NAME}" --region "${SECONDARY_REGION}" 2>/dev/null; then
  echo "[Macie Prereqs] Bucket already exists."
else
  echo "[Macie Prereqs] Creating bucket..."
  aws s3api create-bucket \
    --bucket "${SECONDARY_BUCKET_NAME}" \
    --region "${SECONDARY_REGION}" \
    --create-bucket-configuration LocationConstraint="${SECONDARY_REGION}"
  echo "[Macie Prereqs] Bucket created."
fi

# Always ensure encryption (S3-managed AES256)
echo "[Macie Prereqs] Applying S3-managed encryption..."
aws s3api put-bucket-encryption \
  --bucket "${SECONDARY_BUCKET_NAME}" \
  --region "${SECONDARY_REGION}" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Always ensure public access block
echo "[Macie Prereqs] Applying public access block..."
aws s3api put-public-access-block \
  --bucket "${SECONDARY_BUCKET_NAME}" \
  --region "${SECONDARY_REGION}" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Always ensure bucket policy (Macie access, deny unencrypted, deny insecure)
echo "[Macie Prereqs] Applying bucket policy..."
POLICY_FILE=$(mktemp)
cat > "${POLICY_FILE}" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowMacieWrite",
      "Effect": "Allow",
      "Principal": { "Service": "macie.amazonaws.com" },
      "Action": ["s3:PutObject", "s3:GetBucketLocation"],
      "Resource": ["${BUCKET_ARN}", "${BUCKET_ARN}/*"]
    },
    {
      "Sid": "DenyUnencryptedUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "${BUCKET_ARN}/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "AES256" } }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["${BUCKET_ARN}", "${BUCKET_ARN}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
EOF
aws s3api put-bucket-policy \
  --bucket "${SECONDARY_BUCKET_NAME}" \
  --region "${SECONDARY_REGION}" \
  --policy "file://${POLICY_FILE}"
rm -f "${POLICY_FILE}"

echo "[Macie Prereqs] Bucket configuration complete."

# Append to shared dotenv artifact
if [ -n "${DOTENV_FILE:-}" ]; then
  echo "SECONDARY_BUCKET_NAME=${SECONDARY_BUCKET_NAME}" >> "${DOTENV_FILE}"
  echo "SECONDARY_BUCKET_REGION=${SECONDARY_REGION}" >> "${DOTENV_FILE}"
  echo "[Macie Prereqs] Exported SECONDARY_BUCKET_NAME and SECONDARY_BUCKET_REGION to dotenv."
else
  echo "[Macie Prereqs] WARNING: DOTENV_FILE not set — env vars not exported."
fi
