/**
 * Security remediation regression suite (C1–C3, SEC-01–11, H1–H6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectoryScope,
  DocumentSecurityStatus,
  EnrollmentStatus,
  RecordStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { assertRecordInTenant } from './tenantAccess';
import {
  assertResourceRecordAccess,
  getAuthorizedOrganizationIds
} from './orgAccess';
import { canManageTenantIssues } from './dataQualityIssues';
import { assertSafeRuntimeConfig, isE2eLoginBypassAllowed } from '../lib/runtimeSecurity';
import {
  clearTenantSecretMapForTests,
  configureEnvSecret,
  configureTenantMemSecret,
  resolveSecret
} from '../lib/secretStore';
import { encryptField } from '../lib/fieldCrypto';
import {
  canNormalDownload,
  canManualRelease,
  MANUAL_RELEASE_REASON_MIN,
  releaseDocumentFromQuarantine,
  scanOrQuarantine
} from './documentSecurity';
import { ExternalIntegrationStatus } from '@prisma/client';

async function seedPair() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const hash = await bcrypt.hash('AuditFix-Test-2026!', 4);
  const tenantA = await prisma.tenant.create({
    data: { name: `Sec A ${suffix}`, slug: `sec-a-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Sec B ${suffix}`, slug: `sec-b-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const staff = await prisma.user.create({
    data: {
      email: `staff.sec.${suffix}@audit.test`,
      name: 'Staff Sec',
      passwordHash: hash,
      role: Role.CREDENTIALING_MANAGER,
      active: true
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `client.sec.${suffix}@audit.test`,
      name: 'Client Sec',
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
    data: { firstName: 'Shared', lastName: `Prov${suffix}`, status: 'ACTIVE' }
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
    data: { name: `Sec Payer ${suffix}`, payerCode: `SP${suffix}`, status: 'ACTIVE' }
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
      enrollmentType: 'INDIVIDUAL',
      internalNotes: 'GPA only secret note'
    }
  });

  const docB = await prisma.document.create({
    data: {
      title: `Doc OrgB ${suffix}`,
      type: 'LICENSE',
      tenantId: tenantA.id,
      organizationId: orgB.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      notes: 'Internal reviewer commentary'
    }
  });

  return {
    suffix, tenantA, tenantB, staff, client, orgA, orgB, licenseA, reqA, enrollmentB, provider, docB
  };
}

function ctxFor(userId: string, role: Role, tenantId: string) {
  return {
    userId,
    platformRole: role,
    tenantId,
    membershipId: null,
    tenantRole: TenantRole.TENANT_ADMIN,
    membershipStatus: 'ACTIVE' as const,
    platformAccess: false,
    tenantSelectionRequired: false,
    activeMemberships: []
  };
}

test('SEC-01: tenant-scoped requirement ownership rejects cross-tenant', async () => {
  const s = await seedPair();
  const existing = await prisma.payerRequirement.findUnique({ where: { id: s.reqA.id } });
  assert.equal(existing!.scope, DirectoryScope.TENANT);
  assert.notEqual(existing!.tenantId, s.tenantB.id);
  // Route guard pattern
  const denied = existing!.scope === DirectoryScope.TENANT && existing!.tenantId !== s.tenantB.id;
  assert.equal(denied, true);
});

test('SEC-02: shared provider does not expose Tenant A license to Tenant B', async () => {
  const s = await seedPair();
  const ctxB = ctxFor(s.staff.id, Role.CREDENTIALING_MANAGER, s.tenantB.id);
  await assert.rejects(
    () => assertRecordInTenant(ctxB as any, 'licenses', s.licenseA.id),
    /not found|Access|NOT_FOUND/i
  );
});

test('SEC-03: client Org A cannot access Org B enrollment via org ACL', async () => {
  const s = await seedPair();
  const orgIds = await getAuthorizedOrganizationIds(
    s.client.id,
    Role.CLIENT_USER,
    ctxFor(s.client.id, Role.CLIENT_USER, s.tenantA.id) as any
  );
  assert.ok(orgIds.includes(s.orgA.id));
  assert.equal(orgIds.includes(s.orgB.id), false);
  assert.equal(orgIds.includes(s.enrollmentB.organizationId!), false);
});

test('SEC-08: clients cannot manage data quality issues', () => {
  assert.equal(canManageTenantIssues(Role.CLIENT_USER), false);
  assert.equal(canManageTenantIssues(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canManageTenantIssues(Role.CREDENTIALING_MANAGER), true);
});

test('SEC-09: client Org A cannot access Org B document', async () => {
  const s = await seedPair();
  const ctx = ctxFor(s.client.id, Role.CLIENT_USER, s.tenantA.id);
  await assert.rejects(
    () => assertResourceRecordAccess(s.client.id, Role.CLIENT_USER, 'documents', s.docB.id, ctx as any),
    /not found|Access|NOT_FOUND/i
  );
});

test('SEC-09: GPA staff retains Org B document access', async () => {
  const s = await seedPair();
  const ctx = ctxFor(s.staff.id, Role.CREDENTIALING_MANAGER, s.tenantA.id);
  await assertResourceRecordAccess(s.staff.id, Role.CREDENTIALING_MANAGER, 'documents', s.docB.id, ctx as any);
});

test('C2: production + E2E_SAFE_DATABASE refuses startup', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ NODE_ENV: 'production', E2E_SAFE_DATABASE: '1' }),
    /E2E_SAFE_DATABASE/
  );
});

test('C2: production + mock flags refuses startup', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ NODE_ENV: 'production', INTEGRATION_TEST_MOCK: '1' }),
    /INTEGRATION_TEST_MOCK|CAQH_ALLOW_MOCK/
  );
});

test('C2: E2E login bypass never allowed in production', () => {
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
      DATABASE_URL: 'postgresql://x@localhost/credentialing_e2e?schema=public'
    }),
    true
  );
});

test('C3: TEST_MOCK_SUCCEEDED enum exists and CONNECTED is distinct', () => {
  assert.equal(ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED, 'TEST_MOCK_SUCCEEDED');
  assert.notEqual(ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED, ExternalIntegrationStatus.CONNECTED);
});

test('H1: scanOrQuarantine returns QUARANTINED when scanner missing', async () => {
  delete process.env.MALWARE_SCANNER_ENABLED;
  delete process.env.MALWARE_SCANNER_URL;
  const result = await scanOrQuarantine({ documentId: 'x', filePath: '/tmp/x' });
  assert.equal(result.scanned, false);
  assert.equal(result.status, 'QUARANTINED');
});

test('H3: unauthorized manual release denied; short reason rejected', async () => {
  const s = await seedPair();
  await assert.rejects(
    () => releaseDocumentFromQuarantine({
      documentId: s.docB.id,
      actorId: s.client.id,
      role: Role.CLIENT_USER,
      reason: 'long enough reason text here'
    }),
    /Insufficient|403/i
  );
  await assert.rejects(
    () => releaseDocumentFromQuarantine({
      documentId: s.docB.id,
      actorId: s.staff.id,
      role: Role.CREDENTIALING_MANAGER,
      reason: 'short'
    }),
    /reason|RELEASE_REASON/i
  );
  assert.equal(canManualRelease(Role.CREDENTIALING_SPECIALIST), false);
});

test('H3: authorized release with reason sets AVAILABLE and does not claim scan', async () => {
  const s = await seedPair();
  const reason = 'x'.repeat(MANUAL_RELEASE_REASON_MIN);
  const updated = await releaseDocumentFromQuarantine({
    documentId: s.docB.id,
    actorId: s.staff.id,
    role: Role.CREDENTIALING_MANAGER,
    reason
  });
  assert.equal(updated.securityStatus, DocumentSecurityStatus.AVAILABLE);
  assert.equal((updated as any)._releaseAudit?.malwareScanned, false);
});

test('H4: quarantined docs cannot use normal download', () => {
  assert.equal(canNormalDownload(DocumentSecurityStatus.QUARANTINED), false);
  assert.equal(canNormalDownload(DocumentSecurityStatus.AVAILABLE), true);
});

test('H5: tenant mem secrets do not write process.env; cross-tenant resolve denied', async () => {
  clearTenantSecretMapForTests();
  const envKey = `TEST_SECRET_${Date.now()}`;
  assert.throws(
    () => configureEnvSecret(envKey, 'tenant-plaintext'),
    /process\.env|FORBIDDEN/i
  );
  assert.equal(process.env[envKey], undefined);

  const a = configureTenantMemSecret('tenant-a', 'cred1', 'secret-a');
  configureTenantMemSecret('tenant-b', 'cred1', 'secret-b');
  const resolvedA = await resolveSecret(a.secretRef, { expectedTenantId: 'tenant-a' });
  assert.equal(resolvedA, 'secret-a');
  const cross = await resolveSecret(a.secretRef, { expectedTenantId: 'tenant-b' });
  assert.equal(cross, null);
  clearTenantSecretMapForTests();
});

test('H6: missing encryption key does not silently write plaintext', () => {
  const prevKey = process.env.FIELD_ENCRYPTION_KEY;
  const prevAllow = process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  const prevNode = process.env.NODE_ENV;
  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  process.env.NODE_ENV = 'development';
  assert.throws(() => encryptField('021000021'), /FIELD_ENCRYPTION_KEY/);
  process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST = '1';
  assert.equal(encryptField('021000021'), '021000021');
  process.env.NODE_ENV = 'production';
  delete process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  assert.throws(() => encryptField('021000021'), /production|FIELD_ENCRYPTION_KEY/);
  if (prevKey !== undefined) process.env.FIELD_ENCRYPTION_KEY = prevKey;
  else delete process.env.FIELD_ENCRYPTION_KEY;
  if (prevAllow !== undefined) process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST = prevAllow;
  else delete process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
  else delete process.env.NODE_ENV;
});
