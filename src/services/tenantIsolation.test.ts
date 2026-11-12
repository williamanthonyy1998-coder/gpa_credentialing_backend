import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import {
  Role,
  TenantMembershipStatus,
  TenantRole,
  TenantStatus,
  RecordStatus,
  EnrollmentStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertRecordInTenant,
  denyNotFound,
  listWhereForResource,
  resolveTenantAuthContext,
  requireTenantContext
} from './tenantAccess';
import { membershipGrantsTenantAccess } from './tenants';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.TENANT_TESTS_SKIP !== '1';
const suffix = `iso-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('missing tenant context is denied for tenant-scoped work', () => {
  assert.throws(
    () => requireTenantContext({
      userId: 'u',
      platformRole: Role.CREDENTIALING_SPECIALIST,
      tenantId: null,
      membershipId: null,
      tenantRole: null,
      membershipStatus: null,
      platformAccess: false,
      tenantSelectionRequired: false,
      activeMemberships: []
    } as any),
    /Tenant context required/i
  );
});

test('denyNotFound uses 404 without sensitive detail', () => {
  try {
    denyNotFound();
    assert.fail('expected throw');
  } catch (err: any) {
    assert.equal(err.status, 404);
    assert.match(String(err.message), /not found/i);
  }
});

test('suspended membership does not grant access', () => {
  assert.equal(
    membershipGrantsTenantAccess(
      [{ tenantId: 't1', status: TenantMembershipStatus.SUSPENDED }],
      't1'
    ),
    false
  );
});

test(
  'cross-tenant isolation for orgs, providers, documents, enrollments, dashboard scope',
  { skip: !RUN_DB },
  async () => {
    const passwordHash = await bcrypt.hash('IsoTest-ChangeThis-2026!', 4);

    const tenantA = await prisma.tenant.create({
      data: { name: `Iso Tenant A ${suffix}`, slug: `iso-a-${suffix}`, status: TenantStatus.ACTIVE }
    });
    const tenantB = await prisma.tenant.create({
      data: { name: `Iso Tenant B ${suffix}`, slug: `iso-b-${suffix}`, status: TenantStatus.ACTIVE }
    });

    const userA = await prisma.user.create({
      data: {
        email: `user-a-${suffix}@example.test`,
        name: 'User A',
        passwordHash,
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });
    const userB = await prisma.user.create({
      data: {
        email: `user-b-${suffix}@example.test`,
        name: 'User B',
        passwordHash,
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });
    const platformAdmin = await prisma.user.create({
      data: {
        email: `admin-${suffix}@example.test`,
        name: 'Platform Admin',
        passwordHash,
        role: Role.ADMIN,
        active: true
      }
    });

    await prisma.tenantMembership.create({
      data: { userId: userA.id, tenantId: tenantA.id, role: TenantRole.CREDENTIALING_SPECIALIST, status: TenantMembershipStatus.ACTIVE }
    });
    await prisma.tenantMembership.create({
      data: { userId: userB.id, tenantId: tenantB.id, role: TenantRole.TENANT_ADMIN, status: TenantMembershipStatus.ACTIVE }
    });
    const suspendedMembership = await prisma.tenantMembership.create({
      data: {
        userId: userA.id,
        tenantId: tenantB.id,
        role: TenantRole.READ_ONLY,
        status: TenantMembershipStatus.SUSPENDED
      }
    });

    const orgA = await prisma.organization.create({
      data: { legalName: `Org A ${suffix}`, status: RecordStatus.ACTIVE, tenantId: tenantA.id }
    });
    const orgB = await prisma.organization.create({
      data: { legalName: `Org B ${suffix}`, status: RecordStatus.ACTIVE, tenantId: tenantB.id }
    });
    const practiceA = await prisma.practice.create({
      data: { name: `Practice A ${suffix}`, organizationId: orgA.id, status: RecordStatus.ACTIVE }
    });
    const practiceB = await prisma.practice.create({
      data: { name: `Practice B ${suffix}`, organizationId: orgB.id, status: RecordStatus.ACTIVE }
    });
    const providerA = await prisma.provider.create({
      data: { firstName: 'Prov', lastName: `A-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const providerB = await prisma.provider.create({
      data: { firstName: 'Prov', lastName: `B-${suffix}`, status: RecordStatus.ACTIVE }
    });
    await prisma.tenantProvider.create({ data: { tenantId: tenantA.id, providerId: providerA.id } });
    await prisma.tenantProvider.create({ data: { tenantId: tenantB.id, providerId: providerB.id } });

    const payer = await prisma.payer.create({
      data: { name: `Iso Payer ${suffix}`, payerCode: `ISO-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const plan = await prisma.payerPlan.create({
      data: { payerId: payer.id, name: `Iso Plan ${suffix}` }
    });

    const enrollA = await prisma.enrollmentApplication.create({
      data: {
        applicationNo: `ISO-ENR-A-${suffix}`,
        tenantId: tenantA.id,
        organizationId: orgA.id,
        practiceId: practiceA.id,
        providerId: providerA.id,
        payerPlanId: plan.id,
        status: EnrollmentStatus.PREPARING
      }
    });
    const enrollB = await prisma.enrollmentApplication.create({
      data: {
        applicationNo: `ISO-ENR-B-${suffix}`,
        tenantId: tenantB.id,
        organizationId: orgB.id,
        practiceId: practiceB.id,
        providerId: providerB.id,
        payerPlanId: plan.id,
        status: EnrollmentStatus.PREPARING
      }
    });
    const docA = await prisma.document.create({
      data: {
        title: `Doc A ${suffix}`,
        type: 'CV',
        tenantId: tenantA.id,
        organizationId: orgA.id,
        providerId: providerA.id
      }
    });
    const docB = await prisma.document.create({
      data: {
        title: `Doc B ${suffix}`,
        type: 'CV',
        tenantId: tenantB.id,
        organizationId: orgB.id,
        providerId: providerB.id
      }
    });

    // 1) User A resolves to tenant A with header
    const ctxA = await resolveTenantAuthContext({
      userId: userA.id,
      platformRole: userA.role,
      requestedTenantId: tenantA.id
    });
    assert.equal(ctxA.tenantId, tenantA.id);

    // 10-12) Header/query/body tricks: wrong tenant header denied without existence leak
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: userA.id,
        platformRole: userA.role,
        requestedTenantId: tenantB.id
      }),
      (err: any) => err?.status === 403 && /access denied/i.test(err.message)
    );

    // 14) Suspended membership rejected (activeMemberships excludes suspended)
    const ctxSuspendedAttempt = await resolveTenantAuthContext({
      userId: userA.id,
      platformRole: userA.role,
      requestedTenantId: tenantA.id
    });
    assert.ok(!ctxSuspendedAttempt.activeMemberships.some((m) => m.id === suspendedMembership.id));

    // 2-3) List/detail isolation
    const orgListA = await prisma.organization.findMany({
      where: listWhereForResource('organizations', tenantA.id) as any
    });
    assert.ok(orgListA.some((o) => o.id === orgA.id));
    assert.ok(!orgListA.some((o) => o.id === orgB.id));

    await assert.rejects(
      () => assertRecordInTenant(ctxA, 'organizations', orgB.id),
      (err: any) => err?.status === 404
    );
    await assert.rejects(
      () => assertRecordInTenant(ctxA, 'documents', docB.id),
      (err: any) => err?.status === 404
    );
    await assert.rejects(
      () => assertRecordInTenant(ctxA, 'enrollments', enrollB.id),
      (err: any) => err?.status === 404
    );
    await assert.doesNotReject(() => assertRecordInTenant(ctxA, 'documents', docA.id));
    await assert.doesNotReject(() => assertRecordInTenant(ctxA, 'enrollments', enrollA.id));

    const providersA = await prisma.provider.findMany({
      where: listWhereForResource('providers', tenantA.id) as any
    });
    assert.ok(providersA.some((p) => p.id === providerA.id));
    assert.ok(!providersA.some((p) => p.id === providerB.id));

    // 13) Revoked membership immediately loses access (DB revalidation)
    await prisma.tenantMembership.update({
      where: { id: ctxA.membershipId! },
      data: { status: TenantMembershipStatus.INACTIVE }
    });
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: userA.id,
        platformRole: userA.role,
        requestedTenantId: tenantA.id
      }),
      (err: any) => err?.status === 403
    );

    // 17) Platform admin with explicit platform access can select tenant without membership
    const adminCtx = await resolveTenantAuthContext({
      userId: platformAdmin.id,
      platformRole: platformAdmin.role,
      requestedTenantId: tenantB.id,
      platformAccessHeader: '1'
    });
    assert.equal(adminCtx.tenantId, tenantB.id);
    assert.equal(adminCtx.platformAccess, true);
    await assert.doesNotReject(() => assertRecordInTenant(adminCtx, 'organizations', orgB.id));

    // Platform admin WITHOUT platform access cannot pick arbitrary tenant
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: platformAdmin.id,
        platformRole: platformAdmin.role,
        requestedTenantId: tenantB.id
      }),
      (err: any) => err?.status === 403
    );

    // Cleanup
    await prisma.document.deleteMany({ where: { id: { in: [docA.id, docB.id] } } });
    await prisma.enrollmentApplication.deleteMany({ where: { id: { in: [enrollA.id, enrollB.id] } } });
    await prisma.payerPlan.delete({ where: { id: plan.id } }).catch(() => undefined);
    await prisma.payer.delete({ where: { id: payer.id } }).catch(() => undefined);
    await prisma.tenantProvider.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [providerA.id, providerB.id] } } });
    await prisma.practice.deleteMany({ where: { id: { in: [practiceA.id, practiceB.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id, platformAdmin.id] } } });
  }
);
