import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Prisma,
  Role,
  TenantMembershipStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertActiveMembership,
  createTenant,
  createTenantMembership,
  isPlatformAdmin,
  listUserTenantMemberships,
  membershipGrantsTenantAccess,
  normalizeTenantSlug
} from './tenants';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.TENANT_TESTS_SKIP !== '1';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('normalizeTenantSlug lowercases and hyphenates', () => {
  assert.equal(normalizeTenantSlug('  Acme Health Group  '), 'acme-health-group');
  assert.equal(normalizeTenantSlug('Demo__Client!!'), 'demo-client');
});

test('platform ADMIN is distinct from tenant membership roles', () => {
  assert.equal(isPlatformAdmin(Role.ADMIN), true);
  assert.equal(isPlatformAdmin(Role.CREDENTIALING_MANAGER), false);
  assert.equal(isPlatformAdmin(Role.READ_ONLY), false);
  // TenantRole has TENANT_ADMIN, not platform ADMIN — GPA admin stays on User.role.
  assert.ok(Object.values(TenantRole).includes(TenantRole.TENANT_ADMIN));
  assert.ok(!Object.values(TenantRole).includes('ADMIN' as TenantRole));
});

test('membership access is tenant-scoped and status-aware', () => {
  const memberships = [
    { tenantId: 'tenant-a', status: TenantMembershipStatus.ACTIVE },
    { tenantId: 'tenant-b', status: TenantMembershipStatus.SUSPENDED }
  ];
  assert.equal(membershipGrantsTenantAccess(memberships, 'tenant-a'), true);
  assert.equal(membershipGrantsTenantAccess(memberships, 'tenant-b'), false);
  assert.equal(membershipGrantsTenantAccess(memberships, 'tenant-c'), false);
});

test('assertActiveMembership rejects missing and inactive memberships', () => {
  const memberships = [
    { tenantId: 'tenant-a', status: TenantMembershipStatus.ACTIVE, role: TenantRole.TENANT_ADMIN },
    { tenantId: 'tenant-b', status: TenantMembershipStatus.INACTIVE, role: TenantRole.READ_ONLY }
  ];
  assert.equal(assertActiveMembership(memberships, 'tenant-a').role, TenantRole.TENANT_ADMIN);
  assert.throws(() => assertActiveMembership(memberships, 'tenant-b'), /INACTIVE/i);
  assert.throws(() => assertActiveMembership(memberships, 'tenant-c'), /not a member/i);
});

test(
  'creates tenants and memberships with uniqueness and multi-tenant roles',
  { skip: !RUN_DB },
  async () => {
    const userA = await prisma.user.create({
      data: {
        email: `tenant-test-a-${suffix}@example.test`,
        name: 'Tenant Test A',
        passwordHash: 'not-a-real-hash',
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });
    const userAdmin = await prisma.user.create({
      data: {
        email: `tenant-test-admin-${suffix}@example.test`,
        name: 'Tenant Test Platform Admin',
        passwordHash: 'not-a-real-hash',
        role: Role.ADMIN,
        active: true
      }
    });

    const tenantOne = await createTenant({
      name: `Demo Client One ${suffix}`,
      slug: `demo-client-one-${suffix}`,
      status: TenantStatus.ACTIVE
    });
    const tenantTwo = await createTenant({
      name: `Demo Client Two ${suffix}`,
      slug: `demo-client-two-${suffix}`
    });

    assert.equal(tenantOne.slug, `demo-client-one-${suffix}`);
    assert.equal(tenantTwo.status, TenantStatus.ACTIVE);

    await assert.rejects(
      () => createTenant({ name: 'Dup', slug: `Demo Client One ${suffix}` }),
      (err: any) => err?.code === 'TENANT_SLUG_CONFLICT' || err instanceof Prisma.PrismaClientKnownRequestError
    );

    const membershipOne = await createTenantMembership({
      userId: userA.id,
      tenantId: tenantOne.id,
      role: TenantRole.CREDENTIALING_SPECIALIST
    });
    const membershipTwo = await createTenantMembership({
      userId: userA.id,
      tenantId: tenantTwo.id,
      role: TenantRole.TENANT_ADMIN
    });

    assert.equal(membershipOne.role, TenantRole.CREDENTIALING_SPECIALIST);
    assert.equal(membershipTwo.role, TenantRole.TENANT_ADMIN);
    assert.notEqual(membershipOne.tenantId, membershipTwo.tenantId);

    await assert.rejects(
      () =>
        createTenantMembership({
          userId: userA.id,
          tenantId: tenantOne.id,
          role: TenantRole.APPROVER
        }),
      (err: any) => err?.code === 'TENANT_MEMBERSHIP_CONFLICT'
    );

    const inactive = await createTenantMembership({
      userId: userAdmin.id,
      tenantId: tenantOne.id,
      role: TenantRole.READ_ONLY,
      status: TenantMembershipStatus.INACTIVE
    });
    assert.equal(inactive.status, TenantMembershipStatus.INACTIVE);
    assert.equal(
      membershipGrantsTenantAccess(
        [{ tenantId: inactive.tenantId, status: inactive.status }],
        tenantOne.id
      ),
      false
    );

    // Platform ADMIN user can also hold a tenant membership without losing User.role ADMIN.
    const adminStillPlatform = await prisma.user.findUniqueOrThrow({ where: { id: userAdmin.id } });
    assert.equal(adminStillPlatform.role, Role.ADMIN);
    assert.equal(isPlatformAdmin(adminStillPlatform.role), true);

    const listed = await listUserTenantMemberships(userA.id);
    assert.equal(listed.length, 2);
    const rolesByTenant = Object.fromEntries(listed.map((m) => [m.tenantId, m.role]));
    assert.equal(rolesByTenant[tenantOne.id], TenantRole.CREDENTIALING_SPECIALIST);
    assert.equal(rolesByTenant[tenantTwo.id], TenantRole.TENANT_ADMIN);

    // Cleanup test rows (tenants cascade memberships).
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantOne.id, tenantTwo.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userAdmin.id] } } });
  }
);
