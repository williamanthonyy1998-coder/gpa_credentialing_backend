/**
 * Round 2 security remediation regression suite (RT-01 … RT-06).
 * Requires an isolated *_e2e / *_test DATABASE_URL. Refuses credentialing_db.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { databaseNameFromUrl, databaseUrlLooksIsolated } from '../lib/runtimeSecurity';
import { listWhereForResource, assertRecordInTenant } from './tenantAccess';
import {
  assertResourceRecordAccess,
  getAuthorizedOrganizationIds,
  getOrgRestrictionIds
} from './orgAccess';
import { sanitizeDocumentForAudience, stripClientWritableFileFields } from './documentAudience';
import { serializeCredential } from './credentials';
import {
  canNormalDownload,
  releaseDocumentFromQuarantine,
  MANUAL_RELEASE_REASON_MIN
} from './documentSecurity';
import {
  assignUserOrganization,
  revokeUserOrganization
} from './userOrganizations';

function assertIsolatedDatabase() {
  const name = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!name || !databaseUrlLooksIsolated(process.env.DATABASE_URL)) {
    throw new Error(
      `[round2] Refusing DB tests: DATABASE_URL name "${name || 'unset'}" is not an isolated *_e2e / *_test database`
    );
  }
  if (/^credentialing_db$/i.test(name)) {
    throw new Error('[round2] Refusing DB tests against credentialing_db');
  }
}

const dbReady = (() => {
  try {
    assertIsolatedDatabase();
    return true;
  } catch {
    return false;
  }
})();

const suite = dbReady ? test : test.skip;

async function seed() {
  assertIsolatedDatabase();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const hash = await bcrypt.hash('Round2-Test-Password-2026!', 4);
  const tenantA = await prisma.tenant.create({
    data: { name: `RT2 A ${suffix}`, slug: `rt2-a-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `RT2 B ${suffix}`, slug: `rt2-b-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const staff = await prisma.user.create({
    data: {
      email: `rt2.staff.${suffix}@test.local`,
      name: 'RT2 Staff',
      role: Role.CREDENTIALING_MANAGER,
      passwordHash: hash
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `rt2.client.${suffix}@test.local`,
      name: 'RT2 Client',
      role: Role.CLIENT_USER,
      passwordHash: hash
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
  const provider = await prisma.provider.create({
    data: { firstName: 'Pat', lastName: `Prov${suffix}`, npi: `${Date.now()}`.slice(-10).padStart(10, '1') }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenantA.id, providerId: provider.id } });
  await prisma.tenantProvider.create({ data: { tenantId: tenantB.id, providerId: provider.id } });
  const licenseA = await prisma.license.create({
    data: {
      providerId: provider.id,
      tenantId: tenantA.id,
      type: 'MD',
      number: `LIC-A-${suffix}`,
      status: 'RECEIVED'
    }
  });
  const docA = await prisma.document.create({
    data: {
      title: `Doc A ${suffix}`,
      type: 'OTHER',
      tenantId: tenantA.id,
      organizationId: orgA.id,
      notes: 'secret note A',
      storageKey: `quarantine-${suffix}-a.pdf`,
      securityStatus: DocumentSecurityStatus.QUARANTINED
    }
  });
  const docB = await prisma.document.create({
    data: {
      title: `Doc B ${suffix}`,
      type: 'OTHER',
      tenantId: tenantA.id,
      organizationId: orgB.id,
      notes: 'secret note B',
      storageKey: `quarantine-${suffix}-b.pdf`,
      securityStatus: DocumentSecurityStatus.QUARANTINED
    }
  });
  const available = await prisma.document.create({
    data: {
      title: `Doc Available ${suffix}`,
      type: 'OTHER',
      tenantId: tenantA.id,
      organizationId: orgA.id,
      notes: 'released note',
      storageKey: `available-${suffix}.pdf`,
      securityStatus: DocumentSecurityStatus.AVAILABLE
    }
  });
  return { suffix, tenantA, tenantB, staff, client, orgA, orgB, provider, licenseA, docA, docB, available };
}

function ctx(userId: string, role: Role, tenantId: string) {
  return {
    userId,
    platformRole: role,
    tenantId,
    membershipId: null,
    tenantRole: role === Role.CLIENT_USER ? TenantRole.READ_ONLY : TenantRole.TENANT_ADMIN,
    membershipStatus: 'ACTIVE',
    platformAccess: false,
    tenantSelectionRequired: false,
    activeMemberships: []
  };
}

suite('RT-01: stripClientWritableFileFields blocks storageKey patch payload', () => {
  const cleaned = stripClientWritableFileFields({
    title: 'x',
    storageKey: 'other-quarantine.pdf',
    securityStatus: 'AVAILABLE'
  }) as any;
  assert.equal(cleaned.storageKey, undefined);
  assert.equal(cleaned.securityStatus, undefined);
});

suite('RT-02: serializeCredential redacts notes/storageKey for clients', () => {
  const out = serializeCredential(
    {
      id: '1',
      title: 'Bank Letter',
      type: 'Bank Letter',
      notes: 'internal',
      storageKey: 'secret.pdf',
      status: 'RECEIVED',
      documentFacilities: [],
      documentProviders: []
    },
    new Date(),
    Role.CLIENT_USER
  ) as any;
  assert.equal(out.notes, undefined);
  assert.equal(out.storageKey, undefined);
  assert.equal(out.hasFile, true);
});

suite('RT-03: license list where requires tenantId', () => {
  const where = listWhereForResource('licenses', 'tenant-a') as any;
  assert.ok(where.AND);
  assert.equal(where.AND[0].tenantId, 'tenant-a');
});

suite('RT-03/RT-06 DB: shared provider does not leak tenant A license to tenant B', async () => {
  const s = await seed();
  const ctxB = ctx(s.staff.id, Role.CREDENTIALING_MANAGER, s.tenantB.id);
  await assert.rejects(
    () => assertRecordInTenant(ctxB as any, 'licenses', s.licenseA.id),
    /not found|404/i
  );
});

suite('RT-04: object-contract release works for authorized staff', async () => {
  const s = await seed();
  const reason = 'x'.repeat(MANUAL_RELEASE_REASON_MIN);
  const updated = await releaseDocumentFromQuarantine({
    documentId: s.docA.id,
    actorId: s.staff.id,
    role: Role.CREDENTIALING_MANAGER,
    reason
  });
  assert.equal(updated.securityStatus, DocumentSecurityStatus.AVAILABLE);
  await assert.rejects(
    () => releaseDocumentFromQuarantine({
      documentId: s.docB.id,
      actorId: s.client.id,
      role: Role.CLIENT_USER,
      reason
    }),
    /Insufficient|403/i
  );
});

suite('RT-05: canNormalDownload blocks quarantine extraction gate', () => {
  assert.equal(canNormalDownload(DocumentSecurityStatus.QUARANTINED), false);
  assert.equal(canNormalDownload(DocumentSecurityStatus.AVAILABLE), true);
  assert.equal(canNormalDownload(DocumentSecurityStatus.REJECTED), false);
});

suite('RT-06: CLIENT_USER without UserOrganization gets empty allow-list', async () => {
  const s = await seed();
  const ctxClient = ctx(s.client.id, Role.CLIENT_USER, s.tenantA.id);
  const allowed = await getAuthorizedOrganizationIds(s.client.id, Role.CLIENT_USER, ctxClient as any);
  assert.deepEqual(allowed, []);
  const restriction = await getOrgRestrictionIds(s.client.id, Role.CLIENT_USER, ctxClient as any);
  assert.deepEqual(restriction, []);
  await assert.rejects(
    () => assertResourceRecordAccess(s.client.id, Role.CLIENT_USER, 'documents', s.docA.id, ctxClient as any),
    /not found|404/i
  );
});

suite('RT-06: assign/revoke UserOrganization enables and removes access', async () => {
  const s = await seed();
  const ctxClient = ctx(s.client.id, Role.CLIENT_USER, s.tenantA.id);
  await assignUserOrganization({
    tenantId: s.tenantA.id,
    userId: s.client.id,
    organizationId: s.orgA.id,
    actorId: s.staff.id,
    actorPlatformRole: Role.CREDENTIALING_MANAGER,
    actorTenantRole: TenantRole.TENANT_ADMIN
  });
  await assertResourceRecordAccess(s.client.id, Role.CLIENT_USER, 'documents', s.docA.id, ctxClient as any);
  await assert.rejects(
    () => assertResourceRecordAccess(s.client.id, Role.CLIENT_USER, 'documents', s.docB.id, ctxClient as any),
    /not found|404/i
  );
  await revokeUserOrganization({
    tenantId: s.tenantA.id,
    userId: s.client.id,
    organizationId: s.orgA.id,
    actorPlatformRole: Role.CREDENTIALING_MANAGER,
    actorTenantRole: TenantRole.TENANT_ADMIN
  });
  await assert.rejects(
    () => assertResourceRecordAccess(s.client.id, Role.CLIENT_USER, 'documents', s.docA.id, ctxClient as any),
    /not found|404/i
  );
});

suite('RT-06: GPA staff remain tenant-wide without UserOrganization', async () => {
  const s = await seed();
  const ctxStaff = ctx(s.staff.id, Role.CREDENTIALING_MANAGER, s.tenantA.id);
  await assertResourceRecordAccess(
    s.staff.id,
    Role.CREDENTIALING_MANAGER,
    'documents',
    s.docB.id,
    ctxStaff as any
  );
});

suite('RT-02 audience helper independent of DB', () => {
  const out = sanitizeDocumentForAudience(
    { notes: 'n', storageKey: 'k', title: 't' },
    Role.CLIENT_USER
  ) as any;
  assert.equal(out.notes, undefined);
  assert.equal(out.storageKey, undefined);
});

if (!dbReady) {
  test('Round2 DB suites skipped — DATABASE_URL is not an isolated e2e/test database', () => {
    const name = databaseNameFromUrl(process.env.DATABASE_URL) || 'unset';
    assert.ok(true, `skipped because database name is ${name}`);
  });
}
