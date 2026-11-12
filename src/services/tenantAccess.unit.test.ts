import assert from 'node:assert/strict';
import test from 'node:test';
import { Role, TenantMembershipStatus, TenantRole } from '@prisma/client';
import {
  andWhere,
  listWhereForResource,
  requireTenantContext,
  wantsPlatformAccess
} from './tenantAccess';
import { isPlatformAdmin } from './tenants';

test('wantsPlatformAccess accepts explicit flags only', () => {
  assert.equal(wantsPlatformAccess('1'), true);
  assert.equal(wantsPlatformAccess('true'), true);
  assert.equal(wantsPlatformAccess('yes'), true);
  assert.equal(wantsPlatformAccess('0'), false);
  assert.equal(wantsPlatformAccess(undefined), false);
});

test('platform admin helper remains role-based', () => {
  assert.equal(isPlatformAdmin(Role.ADMIN), true);
  assert.equal(isPlatformAdmin(Role.CREDENTIALING_MANAGER), false);
});

test('multi-tenant selection required when no tenant selected', () => {
  assert.throws(
    () => requireTenantContext({
      userId: 'u',
      platformRole: Role.CREDENTIALING_SPECIALIST,
      tenantId: null,
      membershipId: null,
      tenantRole: null,
      membershipStatus: null,
      platformAccess: false,
      tenantSelectionRequired: true,
      activeMemberships: [
        { id: '1', tenantId: 'a', role: TenantRole.TENANT_ADMIN, status: TenantMembershipStatus.ACTIVE, tenant: {} as any },
        { id: '2', tenantId: 'b', role: TenantRole.READ_ONLY, status: TenantMembershipStatus.ACTIVE, tenant: {} as any }
      ]
    }),
    /Tenant selection required/i
  );
});

test('listWhereForResource scopes tenant-owned resources', () => {
  assert.deepEqual(listWhereForResource('organizations', 't1'), { tenantId: 't1' });
  assert.ok(listWhereForResource('providers', 't1'));
  assert.equal(listWhereForResource('payers', 't1'), null);
  assert.equal(listWhereForResource('employees', 't1'), null);
});

test('andWhere composes filters', () => {
  assert.deepEqual(andWhere({ a: 1 }, { b: 2 }), { AND: [{ a: 1 }, { b: 2 }] });
  assert.deepEqual(andWhere({}, { b: 2 }), { b: 2 });
});
