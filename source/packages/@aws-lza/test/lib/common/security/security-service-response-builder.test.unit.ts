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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDelegatedAccountResponse, IOrganizationAdminResponse } from '../../../../lib/common/interfaces';
import {
  DelegatedAccountResponseHandler,
  ErrorCodes,
  OrganizationAdminResponseHandler,
  ResponseBuilderError,
  SecurityServiceResponseBuilder,
} from '../../../../lib/common/security/security-service-response-builder';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  processStart: vi.fn(),
  processEnd: vi.fn(),
  dryRun: vi.fn(),
  commandExecution: vi.fn(),
  commandSuccess: vi.fn(),
};

describe('SecurityServiceResponseBuilder', () => {
  let builder: SecurityServiceResponseBuilder<IOrganizationAdminResponse>;
  let handler: OrganizationAdminResponseHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new SecurityServiceResponseBuilder<IOrganizationAdminResponse>(mockLogger);
    handler = new OrganizationAdminResponseHandler();
  });

  describe('constructor', () => {
    it('should create builder with logger', () => {
      expect(builder).toBeDefined();
      expect(builder.getResponses()).toEqual([]);
    });
  });

  describe('addResponse', () => {
    it('should add new response successfully', () => {
      const data = {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      builder.addResponse('enabled', 'us-east-1', handler, data);

      const responses = builder.getResponses();
      expect(responses).toHaveLength(1);
      expect(responses[0]).toEqual({
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });
    });

    it('should merge responses with same identifier', () => {
      const data = {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      builder.addResponse('enabled', 'us-east-1', handler, data);
      builder.addResponse('enabled', 'us-west-2', handler, data);

      const responses = builder.getResponses();
      expect(responses).toHaveLength(1);
      expect(responses[0].regions).toEqual(['us-east-1', 'us-west-2']);
    });

    it('should add separate responses with different identifiers', () => {
      builder.addResponse('enabled', 'us-east-1', handler, {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });

      builder.addResponse('enabled', 'us-west-2', handler, {
        managementAccountId: 'mgmt-789',
        delegatedAdminAccountId: 'admin-456',
      });

      const responses = builder.getResponses();
      expect(responses).toHaveLength(2);
    });

    it('should validate operation parameter', () => {
      expect(() => {
        builder.addResponse('invalid' as 'enabled', 'us-east-1', handler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow(ResponseBuilderError);
    });

    it('should validate region parameter', () => {
      expect(() => {
        builder.addResponse('enabled', '', handler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow(ResponseBuilderError);
    });

    it('should validate region format', () => {
      expect(() => {
        builder.addResponse('enabled', 'INVALID_REGION!', handler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('contains invalid characters');
    });

    it('should validate region is not whitespace only', () => {
      expect(() => {
        builder.addResponse('enabled', '   ', handler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Region cannot be empty or contain only whitespace');
    });

    it('should handle unexpected errors during response creation', () => {
      // Create a handler that throws unexpected error
      const errorHandler = {
        create: () => {
          throw new TypeError('Unexpected type error');
        },
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', errorHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Unexpected error adding response: Unexpected type error');
    });

    it('should validate handler is not null', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', null as unknown as OrganizationAdminResponseHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Handler cannot be null or undefined');
    });

    it('should validate handler has required methods', () => {
      const invalidHandler = {} as OrganizationAdminResponseHandler;

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', invalidHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Handler must have a create method that is a function');
    });

    it('should validate handler is an object', () => {
      const invalidHandler = 'not-an-object' as unknown as OrganizationAdminResponseHandler;

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', invalidHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Handler must be an object');
    });

    it('should throw error when responses cannot be merged', () => {
      // Create a handler that says responses can't be merged
      const strictHandler = {
        create: (operation: string, region: string, data: Record<string, unknown>) => ({
          operation,
          regions: [region],
          managementAccountId: data.managementAccountId as string,
          delegatedAdminAccountId: data.delegatedAdminAccountId as string,
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => false, // Always return false
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      const data = {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      // Add first response
      builder.addResponse('enabled', 'us-east-1', strictHandler, data);

      // Try to add second response that will fail canMerge check
      expect(() => {
        builder.addResponse('enabled', 'us-west-2', strictHandler, data);
      }).toThrow('Cannot merge responses: incompatible response objects');
    });

    it('should re-throw ResponseBuilderError during merge', () => {
      // Create a handler that throws ResponseBuilderError during merge
      const errorHandler = {
        create: (operation: string, region: string, data: Record<string, unknown>) => ({
          operation,
          regions: [region],
          managementAccountId: data.managementAccountId as string,
          delegatedAdminAccountId: data.delegatedAdminAccountId as string,
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: () => {
          throw new ResponseBuilderError('Custom merge error', ErrorCodes.MERGE_ERROR);
        },
      };

      const data = {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      // Add first response
      builder.addResponse('enabled', 'us-east-1', errorHandler, data);

      // Try to add second response that will trigger ResponseBuilderError
      expect(() => {
        builder.addResponse('enabled', 'us-west-2', errorHandler, data);
      }).toThrow(ResponseBuilderError);

      expect(() => {
        builder.addResponse('enabled', 'us-west-2', errorHandler, data);
      }).toThrow('Custom merge error');
    });

    it('should validate data parameter - null', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', handler, null as unknown as Record<string, unknown>);
      }).toThrow('Data cannot be null');
    });

    it('should validate data parameter - undefined', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', handler, undefined as unknown as Record<string, unknown>);
      }).toThrow('Data cannot be undefined');
    });

    it('should validate data parameter - non-object (string)', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', handler, 'string-data' as unknown as Record<string, unknown>);
      }).toThrow('Data must be an object');
    });

    it('should validate data parameter - non-object (number)', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', handler, 123 as unknown as Record<string, unknown>);
      }).toThrow('Data must be an object');
    });

    it('should validate data parameter - array', () => {
      expect(() => {
        builder.addResponse('enabled', 'us-east-1', handler, ['array', 'data'] as unknown as Record<string, unknown>);
      }).toThrow('Data cannot be an array');
    });

    it('should validate response has non-empty regions array', () => {
      // Create a handler that returns empty regions
      const badHandler = {
        create: () => ({
          operation: 'enabled',
          regions: [], // Empty array
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response regions array cannot be empty');
    });

    it('should validate response regions contain valid strings', () => {
      // Create a handler that returns invalid region
      const badHandler = {
        create: () => ({
          operation: 'enabled',
          regions: ['us-east-1', '', 'us-west-2'], // Empty string in array
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response regions[1] must be a non-empty string');
    });

    it('should validate response has regions field', () => {
      // Create a handler that returns response without regions
      const badHandler = {
        create: () => ({
          operation: 'enabled',
          // Missing regions field
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response must have a regions field');
    });

    it('should validate response regions is an array', () => {
      // Create a handler that returns regions as non-array
      const badHandler = {
        create: () => ({
          operation: 'enabled',
          regions: 'us-east-1', // String instead of array
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response regions must be an array');
    });

    it('should validate response is an object', () => {
      // Create a handler that returns non-object
      const badHandler = {
        create: () => 'not-an-object', // String instead of object
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response must be an object');
    });

    it('should validate response has valid operation field', () => {
      // Create a handler that returns invalid operation
      const badHandler = {
        create: () => ({
          operation: 'invalid-operation', // Invalid operation
          regions: ['us-east-1'],
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow("Response must have a valid operation field ('enabled' or 'disabled')");
    });

    it('should validate response is not null', () => {
      // Create a handler that returns null
      const badHandler = {
        create: () => null,
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: (r1: IOrganizationAdminResponse) => r1,
      };

      expect(() => {
        builder.addResponse('enabled', 'us-east-1', badHandler, {
          managementAccountId: 'mgmt-123',
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('Response object cannot be null or undefined');
    });

    it('should handle merge errors gracefully', () => {
      // Create a handler that throws error during merge
      const errorHandler = {
        create: (operation: string, region: string, data: Record<string, unknown>) => ({
          operation,
          regions: [region],
          managementAccountId: data.managementAccountId as string,
          delegatedAdminAccountId: data.delegatedAdminAccountId as string,
        }),
        getIdentifier: (response: IOrganizationAdminResponse) =>
          `${response.operation}-${response.managementAccountId}`,
        canMerge: () => true,
        merge: () => {
          throw new Error('Merge failed');
        },
      };

      const data = {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      // Add first response
      builder.addResponse('enabled', 'us-east-1', errorHandler, data);

      // Try to add second response that will trigger merge error
      expect(() => {
        builder.addResponse('enabled', 'us-west-2', errorHandler, data);
      }).toThrow('Failed to merge responses: Merge failed');
    });
  });

  describe('getResponses', () => {
    it('should return copy of responses array', () => {
      builder.addResponse('enabled', 'us-east-1', handler, {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });

      const responses1 = builder.getResponses();
      const responses2 = builder.getResponses();

      expect(responses1).not.toBe(responses2); // Different array instances
      expect(responses1).toEqual(responses2); // Same content
    });
  });

  describe('clear', () => {
    it('should clear all responses', () => {
      builder.addResponse('enabled', 'us-east-1', handler, {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });

      expect(builder.getResponses()).toHaveLength(1);

      builder.clear();

      expect(builder.getResponses()).toHaveLength(0);
    });

    it('should handle clearing empty builder', () => {
      expect(builder.getResponses()).toHaveLength(0);
      builder.clear();
      expect(builder.getResponses()).toHaveLength(0);
    });
  });
});

describe('OrganizationAdminResponseHandler', () => {
  let handler: OrganizationAdminResponseHandler;

  beforeEach(() => {
    handler = new OrganizationAdminResponseHandler();
  });

  describe('create', () => {
    it('should create organization admin response successfully', () => {
      const response = handler.create('enabled', 'us-east-1', {
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });

      expect(response).toEqual({
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      });
    });

    it('should throw error when managementAccountId is missing', () => {
      expect(() => {
        handler.create('enabled', 'us-east-1', {
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('managementAccountId is required');
    });

    it('should throw error when delegatedAdminAccountId is missing', () => {
      expect(() => {
        handler.create('enabled', 'us-east-1', {
          managementAccountId: 'mgmt-123',
        });
      }).toThrow('delegatedAdminAccountId is required');
    });

    it('should throw error when managementAccountId is not string', () => {
      expect(() => {
        handler.create('enabled', 'us-east-1', {
          managementAccountId: 123,
          delegatedAdminAccountId: 'admin-456',
        });
      }).toThrow('managementAccountId is required and must be a string');
    });
  });

  describe('getIdentifier', () => {
    it('should generate correct identifier', () => {
      const response: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const identifier = handler.getIdentifier(response);
      expect(identifier).toBe('enabled-mgmt-123-admin-456');
    });
  });

  describe('canMerge', () => {
    it('should return true for compatible responses', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      expect(handler.canMerge(response1, response2)).toBe(true);
    });

    it('should return false for different operations', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'disabled',
        regions: ['us-west-2'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      expect(handler.canMerge(response1, response2)).toBe(false);
    });

    it('should return false for different management accounts', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        managementAccountId: 'mgmt-789',
        delegatedAdminAccountId: 'admin-456',
      };

      expect(handler.canMerge(response1, response2)).toBe(false);
    });

    it('should return false for different delegated admin accounts', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-789',
      };

      expect(handler.canMerge(response1, response2)).toBe(false);
    });
  });

  describe('merge', () => {
    it('should merge regions without duplicates', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2']);
      expect(merged.managementAccountId).toBe('mgmt-123');
      expect(merged.delegatedAdminAccountId).toBe('admin-456');
    });

    it('should handle duplicate regions', () => {
      const response1: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-east-1', 'us-west-2'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const response2: IOrganizationAdminResponse = {
        operation: 'enabled',
        regions: ['us-west-2', 'eu-west-1'],
        managementAccountId: 'mgmt-123',
        delegatedAdminAccountId: 'admin-456',
      };

      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2', 'eu-west-1']);
    });
  });
});

describe('DelegatedAccountResponseHandler', () => {
  let handler: DelegatedAccountResponseHandler;

  beforeEach(() => {
    handler = new DelegatedAccountResponseHandler();
  });

  describe('create', () => {
    it('should create delegated account response successfully', () => {
      const response = handler.create('enabled', 'us-east-1', {
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456', 'member-789'],
      });

      expect(response).toEqual({
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456', 'member-789'],
      });
    });

    it('should handle empty memberAccountIds', () => {
      const response = handler.create('enabled', 'us-east-1', {
        adminAccountId: 'admin-123',
        memberAccountIds: [],
      });

      expect(response.memberAccountIds).toEqual([]);
    });

    it('should throw error when adminAccountId is missing', () => {
      expect(() => {
        handler.create('enabled', 'us-east-1', {
          memberAccountIds: ['member-456'],
        });
      }).toThrow('adminAccountId is required');
    });

    it('should throw error when memberAccountIds is not array', () => {
      expect(() => {
        handler.create('enabled', 'us-east-1', {
          adminAccountId: 'admin-123',
          memberAccountIds: 'not-an-array',
        });
      }).toThrow('memberAccountIds must be an array');
    });
  });

  describe('getIdentifier', () => {
    it('should generate correct identifier', () => {
      const response: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456'],
      };

      const identifier = handler.getIdentifier(response);
      expect(identifier).toBe('enabled-admin-123');
    });
  });

  describe('canMerge', () => {
    it('should return true for compatible responses', () => {
      const response1: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456'],
      };

      const response2: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-789'],
      };

      expect(handler.canMerge(response1, response2)).toBe(true);
    });

    it('should return false for different operations', () => {
      const response1: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456'],
      };

      const response2: IDelegatedAccountResponse = {
        operation: 'disabled',
        regions: ['us-west-2'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-789'],
      };

      expect(handler.canMerge(response1, response2)).toBe(false);
    });

    it('should return false for different admin accounts', () => {
      const response1: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456'],
      };

      const response2: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        adminAccountId: 'admin-789',
        memberAccountIds: ['member-456'],
      };

      expect(handler.canMerge(response1, response2)).toBe(false);
    });
  });

  describe('merge', () => {
    it('should merge regions and member accounts without duplicates', () => {
      const response1: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456'],
      };

      const response2: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-west-2'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-789'],
      };

      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2']);
      expect(merged.memberAccountIds).toEqual(['member-456', 'member-789']);
    });

    it('should handle duplicate regions and member accounts', () => {
      const response1: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-east-1', 'us-west-2'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-456', 'member-789'],
      };

      const response2: IDelegatedAccountResponse = {
        operation: 'enabled',
        regions: ['us-west-2', 'eu-west-1'],
        adminAccountId: 'admin-123',
        memberAccountIds: ['member-789', 'member-012'],
      };

      const merged = handler.merge(response1, response2);

      expect(merged.regions).toEqual(['us-east-1', 'us-west-2', 'eu-west-1']);
      expect(merged.memberAccountIds).toEqual(['member-456', 'member-789', 'member-012']);
    });
  });
});

describe('ResponseBuilderError', () => {
  it('should create error with message and code', () => {
    const error = new ResponseBuilderError('Test error', ErrorCodes.INVALID_OPERATION);

    expect(error.message).toBe('Test error');
    expect(error.code).toBe(ErrorCodes.INVALID_OPERATION);
    expect(error.name).toBe('ResponseBuilderError');
  });
});

describe('ErrorCodes', () => {
  it('should have all expected error codes', () => {
    expect(ErrorCodes.INVALID_OPERATION).toBe('INVALID_OPERATION');
    expect(ErrorCodes.MISSING_REQUIRED_FIELD).toBe('MISSING_REQUIRED_FIELD');
    expect(ErrorCodes.FACTORY_ERROR).toBe('FACTORY_ERROR');
    expect(ErrorCodes.MERGE_ERROR).toBe('MERGE_ERROR');
    expect(ErrorCodes.INVALID_INPUT).toBe('INVALID_INPUT');
  });
});
