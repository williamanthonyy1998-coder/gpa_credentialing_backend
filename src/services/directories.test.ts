import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordStatus, Role, TenantRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertPlatformDirectoryWrite,
  canHardDelete,
  createDirectoryRecord,
  deleteDirectoryRecord
} from './directories';
import { createTenant, createTenantMembership } from './tenants';
import { resolveTenantAuthContext } from './tenantAccess';
const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.DIRECTORY_TESTS_SKIP !== '1';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('assertPlatformDirectoryWrite allows ADMIN and CREDENTIALING_MANAGER', () => {
  const ctx = {
    userId: 'u1',
    platformRole: Role.ADMIN,
    tenantId: null,
    membershipId: null,
    tenantRole: null,
    membershipStatus: null,
    platformAccess: false,
    tenantSelectionRequired: false,
    activeMemberships: []
  };
  assert.doesNotThrow(() => assertPlatformDirectoryWrite(ctx, Role.ADMIN));
  assert.doesNotThrow(() => assertPlatformDirectoryWrite(ctx, Role.CREDENTIALING_MANAGER));
  assert.throws(() => assertPlatformDirectoryWrite(ctx, Role.READ_ONLY), (err: any) => err?.status === 403);
});

test(
  'platform specialty create rejects duplicate name',
  { skip: !RUN_DB },
  async () => {
    const name = `Test Specialty ${suffix}`;
    const admin = await prisma.user.create({
      data: {
        email: `dir-spec-admin-${suffix}@example.test`,
        name: 'Dir Test Admin',
        passwordHash: 'hash',
        role: Role.ADMIN,
        active: true
      }
    });
    const ctx = await resolveTenantAuthContext({
      userId: admin.id,
      platformRole: Role.ADMIN,
      requestedTenantId: null,
      platformAccessHeader: null
    });
    const created = await createDirectoryRecord('specialties', { name }, ctx, Role.ADMIN);
    assert.equal(created.name, name);
    await assert.rejects(
      () => createDirectoryRecord('specialties', { name }, ctx, Role.ADMIN),
      (err: any) => err?.status === 409 || err?.code === 'DUPLICATE' || err?.code === 'P2002'
    );
    await prisma.specialty.delete({ where: { id: created.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: admin.id } });
  }
);

test(
  'tenant payer contacts are isolated between tenants',
  { skip: !RUN_DB },
  async () => {
    // Self-contained fixture: do not depend on global seed payers (often empty in local/dev DBs).
    const payer = await prisma.payer.create({
      data: { name: `Dir Payer ${suffix}`, payerCode: `DP-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const tenantA = await createTenant({ name: `Dir A ${suffix}`, slug: `dir-a-${suffix}` });
    const tenantB = await createTenant({ name: `Dir B ${suffix}`, slug: `dir-b-${suffix}` });
    const user = await prisma.user.create({
      data: {
        email: `dir-payer-${suffix}@example.test`,
        name: 'Dir User',
        passwordHash: 'hash',
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });
    await createTenantMembership({ userId: user.id, tenantId: tenantA.id, role: TenantRole.TENANT_ADMIN });
    const ctxA = await resolveTenantAuthContext({
      userId: user.id,
      platformRole: user.role,
      requestedTenantId: tenantA.id
    });
    const contact = await createDirectoryRecord(
      'payerContacts',
      { payerId: payer.id, name: `Contact ${suffix}` },
      ctxA,
      user.role
    );
    const leaked = await prisma.payerContact.findFirst({
      where: { id: contact.id, tenantId: tenantB.id }
    });
    assert.equal(leaked, null);
    await prisma.payerContact.delete({ where: { id: contact.id } });
    await prisma.tenant.delete({ where: { id: tenantA.id } });
    await prisma.tenant.delete({ where: { id: tenantB.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.payer.delete({ where: { id: payer.id } });
  }
);

test('billing entity create requires tenant context', async () => {
  const ctx = await resolveTenantAuthContext({
    userId: 'u',
    platformRole: Role.ADMIN,
    requestedTenantId: null
  });
  await assert.rejects(
    () =>
      createDirectoryRecord(
        'billingEntities',
        { legalName: 'Test Billing LLC' },
        ctx,
        Role.ADMIN
      ),
    (err: any) => err?.status === 403 || err?.message?.includes('Tenant')
  );
});

test(
  'specialty in use is deactivated instead of hard-deleted',
  { skip: !RUN_DB },
  async () => {
    const specialty = await prisma.specialty.create({
      data: { name: `In Use ${suffix}`, status: RecordStatus.ACTIVE }
    });
    const provider = await prisma.provider.create({
      data: {
        firstName: 'Dir',
        lastName: `Test ${suffix}`,
        primarySpecialtyId: specialty.id,
        status: RecordStatus.ACTIVE
      }
    });
    const can = await canHardDelete('specialties', specialty.id);
    assert.equal(can, false);
    const ctx = await resolveTenantAuthContext({
      userId: 'seed-user-admin',
      platformRole: Role.ADMIN,
      requestedTenantId: null
    });
    const admin = await prisma.user.findUnique({ where: { id: 'seed-user-admin' } });
    if (!admin) {
      await prisma.provider.delete({ where: { id: provider.id } });
      await prisma.specialty.delete({ where: { id: specialty.id } });
      return;
    }
    const row = await deleteDirectoryRecord('specialties', specialty.id, ctx, Role.ADMIN);
    assert.equal(row?.status, RecordStatus.INACTIVE);
    const still = await prisma.specialty.findUnique({ where: { id: specialty.id } });
    assert.ok(still);
    await prisma.provider.delete({ where: { id: provider.id } });
    await prisma.specialty.delete({ where: { id: specialty.id } });
  }
);

test(
  'us state seed enforces unique abbreviations',
  { skip: !RUN_DB },
  async () => {
    // Ensure exactly one TX row exists for this assertion (create if seed was never applied).
    let count = await prisma.usState.count({ where: { abbreviation: 'TX' } });
    let created = false;
    if (count === 0) {
      await prisma.usState.create({
        data: { name: 'Texas', abbreviation: 'TX', status: RecordStatus.ACTIVE }
      });
      created = true;
      count = 1;
    }
    assert.equal(count, 1);
    await assert.rejects(
      () =>
        prisma.usState.create({
          data: { name: 'Duplicate Texas', abbreviation: 'TX', status: RecordStatus.ACTIVE }
        }),
      (err: any) => err?.code === 'P2002'
    );
    // Leave seeded TX in place; only clean up if we created a temporary one and duplicates remain impossible.
    void created;
  }
);

test('credential category platform rows are never hard-deleted', async () => {
  assert.equal(await canHardDelete('credentialCategories', 'any-id'), false);
});
