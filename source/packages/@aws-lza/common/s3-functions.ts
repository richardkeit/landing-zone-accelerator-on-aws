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

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import path from 'path';
import { MODULE_EXCEPTIONS } from './enums';
import { createLogger } from './logger';
import { throttlingBackOff } from './throttle';

interface ValidationResult {
  isValid: boolean;
  message?: string;
}

/**
 * Logger
 */
const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Retrieves content from S3 bucket
 *
 * @param s3Client - Configured S3 client
 * @param bucketName - S3 bucket name
 * @param objectPath - S3 object key
 * @returns S3 content as string
 * @throws Error for S3 access failures
 */
export async function getS3ObjectContent(s3Client: S3Client, bucketName: string, objectPath: string): Promise<string> {
  try {
    const s3Object = await throttlingBackOff(() =>
      s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectPath })),
    );

    if (!s3Object.Body) {
      const errorMessage = `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: S3 object at s3://${bucketName}/${objectPath} has no body content`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    return await s3Object.Body.transformToString();
  } catch (error) {
    logger.error(`${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Failed to retrieve content from S3: ${error}`);
    throw error;
  }
}

/**
 * Function to upload file to S3
 * @param s3Client {@link S3Client}
 * @param bucketName string
 * @param objectPath string
 * @param fileContent string
 */
export async function uploadFileToS3(
  s3Client: S3Client,
  bucketName: string,
  objectPath: string,
  fileContent: string,
): Promise<void> {
  try {
    logger.info(`Calculating file hashes`);
    // Use SHA-256 for cryptographic integrity verification
    const sha256Hash = createHash('sha256').update(fileContent);
    const localFileSHA256 = sha256Hash.digest('hex');

    // MD5 is still needed for S3 ContentMD5 header (S3 API requirement)
    const md5Hash = createHash('md5').update(fileContent);
    const localFileMD5 = md5Hash.digest('hex');
    const contentMD5 = Buffer.from(localFileMD5, 'hex').toString('base64');

    // Upload file with both SHA-256 and MD5 metadata
    await throttlingBackOff(() =>
      s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: objectPath,
          Body: fileContent,
          ContentMD5: contentMD5,
          Metadata: {
            sha256: localFileSHA256,
            md5: localFileMD5,
          },
        }),
      ),
    );

    // Verify upload using SHA-256 (more secure)
    logger.info(`Verifying upload`);
    const validationResultAfterUpload: ValidationResult = await verifyS3Upload(
      s3Client,
      bucketName,
      objectPath,
      localFileSHA256,
      'sha256',
    );
    if (!validationResultAfterUpload.isValid) {
      throw new Error(
        `${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Upload verification failed: ${validationResultAfterUpload.message} for  s3://${bucketName}/${objectPath} file.`,
      );
    }
    logger.info(`Successfully uploaded file to S3: s3://${bucketName}/${objectPath}`);
  } catch (error) {
    logger.error(`${MODULE_EXCEPTIONS.SERVICE_EXCEPTION}: Failed to upload file to S3: ${error}`);
    throw error;
  }
}

/**
 * Function to verify S3 upload
 * @param s3Client {@link S3Client}
 * @param bucketName string
 * @param s3Key string
 * @param localFileHash string
 * @param hashType string - 'sha256' or 'md5'
 * @returns {@link ValidationResult}
 */
async function verifyS3Upload(
  s3Client: S3Client,
  bucketName: string,
  s3Key: string,
  localFileHash: string,
  hashType: 'sha256' | 'md5' = 'sha256',
): Promise<ValidationResult> {
  const headResponse = await s3Client.send(
    new HeadObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    }),
  );

  // Use SHA-256 from metadata for secure verification, fallback to MD5 if needed
  const s3Hash =
    headResponse.Metadata?.[hashType] || (hashType === 'md5' ? headResponse.ETag?.replace(/"/g, '') : undefined);

  if (s3Hash !== localFileHash) {
    return {
      isValid: false,
      message: `${hashType.toUpperCase()} mismatch. Local: ${localFileHash}, S3: ${s3Hash}`,
    };
  }

  return { isValid: true };
}
