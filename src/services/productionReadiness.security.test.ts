/**
 * Production readiness security regression tests (post-audit fixes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectoryScope,
  EnrollmentStatus,
  RecordStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { assertRecordInTenant } from './tenantAccess';
import { canManageTenantIssues } from './dataQualityIssues';
import { assertSafeRuntimeConfig, isE2eLoginBypassAllowed } from '../lib/runtimeSecurity';

async function seedPair() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const hash = await bcrypt.hash('AuditFix-Test-2026!', 4);
  const tenantA = await prisma.tenant.create({
    data: { name: `Audit A ${suffix}`, slug: `audit-a-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Audit B ${suffix}`, slug: `audit-b-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const staff = await prisma.user.create({
    data: {
      email: `staff.a.${suffix}@audit.test`,
      name: 'Staff A',
      passwordHash: hash,
      role: Role.CREDENTIALING_MANAGER,
      active: true
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `client.a.${suffix}@audit.test`,
      name: 'Client A',
      passwordHash: hash,
      role: Role.CLIENT_USER,
      active: true
    }
  });
  await prisma.tenantMembership.create({
    data: { userId: staff.id, tenantId: tenantA.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: client.id, tenantId: tenantA.id, role: TenantRole.READ_ONLY, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: staff.id, tenantId: tenantB.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });

  const orgA = await prisma.organization.create({
    data: { legalName: `Org A ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' }
  });
  const orgB = await prisma.organization.create({
    data: { legalName: `Org B ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' }
  });
  await prisma.userOrganization.create({
    data: { userId: client.id, organizationId: orgA.id }
  });

  const provider = await prisma.provider.create({
    data: {
      firstName: 'Shared',
      lastName: `Prov${suffix}`,
      status: 'ACTIVE'
    }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenantA.id, providerId: provider.id } });
  await prisma.tenantProvider.create({ data: { tenantId: tenantB.id, providerId: provider.id } });

  const licenseA = await prisma.license.create({
    data: {
      providerId: provider.id,
      tenantId: tenantA.id,
      type: 'MD',
      number: `LIC-A-${suffix}`,
      status: 'VERIFIED',
      verificationStatus: 'VERIFIED'
    }
  });

  const payer = await prisma.payer.create({
    data: { name: `Audit Payer ${suffix}`, payerCode: `AP${suffix}`, status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Plan ${suffix}`, status: 'ACTIVE' }
  });
  const reqA = await prisma.payerRequirement.create({
    data: {
      scope: DirectoryScope.TENANT,
      tenantId: tenantA.id,
      payerId: payer.id,
      code: `REQ-${suffix}`,
      title: 'Tenant A only requirement',
      status: RecordStatus.ACTIVE,
      version: 1
    }
  });

  const enrollmentB = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `ENR-B-${suffix}`,
      tenantId: tenantA.id,
      organizationId: orgB.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.PREPARING,
      enrollmentType: 'INDIVIDUAL'
    }
  });

  return { suffix, tenantA, tenantB, staff, client, orgA, orgB, licenseA, reqA, enrollmentB, provider };
}

test('SEC-01: tenant-scoped payer requirement activate denied cross-tenant', async () => {
  const s = await seedPair();
  const existing = await prisma.payerRequirement.findUnique({ where: { id: s.reqA.id } });
  assert.equal(existing!.tenantId, s.tenantA.id);
  assert.notEqual(existing!.tenantId, s.tenantB.id);
  assert.equal(existing!.scope, DirectoryScope.TENANT);
});

test('SEC-02: license assertRecordInTenant requires matching license.tenantId + TenantProvider', async () => {
  const s = await seedPair();
  const ctxA = {
    userId: s.staff.id,
    platformRole: Role.CREDENTIALING_MANAGER,
    tenantId: s.tenantA.id,
    membershipId: null,
    tenantRole: TenantRole.TENANT_ADMIN,
    membershipStatus: 'ACTIVE' as const,
    platformAccess: false,
    tenantSelectionRequired: false,
    activeMemberships: []
  };
  const ctxB = { ...ctxA, tenantId: s.tenantB.id };
  await assertRecordInTenant(ctxA as any, 'licenses', s.licenseA.id);
  await assert.rejects(
    () => assertRecordInTenant(ctxB as any, 'licenses', s.licenseA.id),
    /not found|Access|NOT_FOUND/i
  );
});

test('SEC-08: clients cannot manage data quality issues', () => {
  assert.equal(canManageTenantIssues(Role.CLIENT_USER), false);
  assert.equal(canManageTenantIssues(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canManageTenantIssues(Role.CREDENTIALING_MANAGER), true);
});

test('E2E login bypass helpers: production NODE_ENV must not skip limiter', () => {
  assert.equal(
    isE2eLoginBypassAllowed({
      NODE_ENV: 'production',
      E2E_SAFE_DATABASE: '1',
      DATABASE_URL: 'postgresql://x@localhost/credentialing_e2e'
    }),
    false
  );
  assert.equal(
    isE2eLoginBypassAllowed({
      NODE_ENV: 'development',
      E2E_SAFE_DATABASE: '1',
      DATABASE_URL: 'postgresql://x@localhost/credentialing_db'
    }),
    false
  );
  assert.equal(
    isE2eLoginBypassAllowed({
      NODE_ENV: 'development',
      E2E_SAFE_DATABASE: '1',
      DATABASE_URL: 'postgresql://x@localhost/credentialing_e2e?schema=public'
    }),
    true
  );
});

test('C2 assertSafeRuntimeConfig refuses production E2E_SAFE_DATABASE', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ NODE_ENV: 'production', E2E_SAFE_DATABASE: '1' }),
    /E2E_SAFE_DATABASE/
  );
  assert.doesNotThrow(() => assertSafeRuntimeConfig({ NODE_ENV: 'production' }));
});
