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
  DeletePublicAccessBlockCommand,
  PutPublicAccessBlockCommand,
  S3ControlClient,
} from '@aws-sdk/client-s3-control';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../../lib/aws-s3/put-public-access-block/index';
import {
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceDeleteEvent,
} from '../../../lib/lza-custom-resource';

let s3ControlMock: AwsClientStub<S3ControlClient>;

const accountId = '111122223333';

beforeEach(() => {
  s3ControlMock = mockClient(S3ControlClient);
});

afterEach(() => {
  s3ControlMock.restore();
});

const baseResourceProperties = {
  accountId,
  blockPublicAcls: 'true',
  blockPublicPolicy: 'true',
  ignorePublicAcls: 'true',
  restrictPublicBuckets: 'true',
  ServiceToken: 'example-service-token',
};

const createEvent: CloudFormationCustomResourceCreateEvent = {
  RequestType: 'Create',
  ResponseURL: 'https://example.com',
  ServiceToken: 'example-service-token',
  StackId: 'example-stack-id',
  RequestId: 'example-create-request-id',
  ResourceType: 'Custom::PutPublicAccessBlock',
  LogicalResourceId: 'example-logical-resource-id',
  ResourceProperties: baseResourceProperties,
};

const deleteEvent: CloudFormationCustomResourceDeleteEvent = {
  RequestType: 'Delete',
  ResponseURL: 'https://example.com',
  ServiceToken: 'example-service-token',
  StackId: 'example-stack-id',
  RequestId: 'example-delete-request-id',
  ResourceType: 'Custom::PutPublicAccessBlock',
  LogicalResourceId: 'example-logical-resource-id',
  PhysicalResourceId: `s3-bpa-${accountId}`,
  ResourceProperties: baseResourceProperties,
};

it('@aws-accelerator/constructs/aws-s3/put-public-access-block create event applies the block', async () => {
  s3ControlMock.on(PutPublicAccessBlockCommand).resolves({});
  const response = await handler(createEvent);
  expect(response?.Status).toEqual('SUCCESS');
  const calls = s3ControlMock.commandCalls(PutPublicAccessBlockCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input).toEqual({
    AccountId: accountId,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

it('@aws-accelerator/constructs/aws-s3/put-public-access-block delete event reverts the block', async () => {
  s3ControlMock.on(DeletePublicAccessBlockCommand).resolves({});
  const response = await handler(deleteEvent);
  expect(response?.Status).toEqual('SUCCESS');
  const calls = s3ControlMock.commandCalls(DeletePublicAccessBlockCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input).toEqual({ AccountId: accountId });
});

it('@aws-accelerator/constructs/aws-s3/put-public-access-block delete event tolerates missing config', async () => {
  // The account may have already had its public access block removed
  // out-of-band; this should not fail the stack delete.
  const error = new Error('PublicAccessBlock not found');
  (error as Error & { name: string }).name = 'NoSuchPublicAccessBlockConfiguration';
  s3ControlMock.on(DeletePublicAccessBlockCommand).rejects(error);
  const response = await handler(deleteEvent);
  expect(response?.Status).toEqual('SUCCESS');
});

it('@aws-accelerator/constructs/aws-s3/put-public-access-block delete event surfaces unexpected errors', async () => {
  const error = new Error('boom');
  (error as Error & { name: string }).name = 'AccessDenied';
  s3ControlMock.on(DeletePublicAccessBlockCommand).rejects(error);
  await expect(handler(deleteEvent)).rejects.toThrow('boom');
});
