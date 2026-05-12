import { AccountsConfigValidator } from '../../../../validator/accounts-config-validator';
import { OrganizationConfig } from '../../../../lib/organization-config';
import { AccountsConfig } from '../../../../lib/accounts-config';
import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('AccountsConfigValidator - AWS Organizations API constraints', () => {
  const organization = OrganizationConfig.loadRawOrganizationsConfig(
    path.resolve(__dirname, '../account-aliases/duplicate-config'),
  );

  function validBase(workloadOverrides?: { name?: string; email?: string }[]) {
    const workloads = (workloadOverrides ?? []).map(w => ({
      name: w.name ?? 'Workload1',
      email: w.email ?? 'length+workload1@example.com',
      organizationalUnit: 'Root',
    }));
    return new AccountsConfig(
      {
        managementAccountEmail: 'length+mgmt@example.com',
        logArchiveAccountEmail: 'length+log@example.com',
        auditAccountEmail: 'length+audit@example.com',
      },
      {
        mandatoryAccounts: [
          { name: 'Management', email: 'length+mgmt@example.com', organizationalUnit: 'Root' },
          { name: 'LogArchive', email: 'length+log@example.com', organizationalUnit: 'Root' },
          { name: 'Audit', email: 'length+audit@example.com', organizationalUnit: 'Root' },
        ],
        workloadAccounts: workloads,
        accountIds: [],
      },
    );
  }

  // Account name length constraints
  it('should throw error when account name exceeds 50 characters', () => {
    const longName = 'a'.repeat(51);
    const config = validBase([{ name: longName }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow(`exceeds the maximum length of 50 characters (found 51)`);
  });

  it('should pass when account name is exactly 50 characters', () => {
    const config = validBase([{ name: 'a'.repeat(50) }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).not.toThrow();
  });

  // Account name character constraints (printable ASCII only)
  it('should throw error when account name contains non-printable ASCII', () => {
    const config = validBase([{ name: 'Account\tName' }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('contains invalid characters');
  });

  it('should throw error when account name contains unicode characters', () => {
    const config = validBase([{ name: 'Account\u00E9Name' }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('contains invalid characters');
  });

  it('should pass when account name contains valid printable ASCII including special chars', () => {
    const config = validBase([{ name: 'MyAccount(Prod)#1-US' }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).not.toThrow();
  });

  // Email length constraints
  it('should throw error when email exceeds 64 characters', () => {
    const longEmail = 'a'.repeat(53) + '@example.com'; // 65 chars
    const config = validBase([{ email: longEmail }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('must be between 6 and 64 characters');
  });

  it('should throw error when email is shorter than 6 characters', () => {
    const shortEmail = 'ab@cd'; // 5 chars
    const config = validBase([{ email: shortEmail }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('must be between 6 and 64 characters');
  });

  it('should pass when email is exactly 64 characters', () => {
    const email64 = 'a'.repeat(52) + '@example.com'; // 64 chars
    const config = validBase([{ email: email64 }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).not.toThrow();
  });

  // Email local part forbidden characters
  it('should throw error when email local part contains forbidden characters', () => {
    const config = validBase([{ email: "user'name@example.com" }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('contains characters in the local name not allowed by AWS Organizations');
  });

  it('should throw error when email local part contains percent sign', () => {
    const config = validBase([{ email: 'user%name@example.com' }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).toThrow('contains characters in the local name not allowed by AWS Organizations');
  });

  it('should pass with valid email using plus addressing', () => {
    const config = validBase([{ email: 'user+tag@example.com' }]);
    expect(() => {
      new AccountsConfigValidator(config, organization).validate();
    }).not.toThrow();
  });
});
