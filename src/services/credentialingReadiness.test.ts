import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  HistoryVerificationStatus,
  Role,
  ProfileReviewStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assessProviderReadiness } from './credentialingReadiness';
import { syncCredentialingGaps, attemptResolveGap, GAP_SOURCE } from './credentialingGaps';
import {
  startProfileReview,
  requestProfileCorrections,
  completeProfileReview,
  submitProfileCorrections,
  canDriveProfileReview
} from './profileReview';
import { getUnifiedCredentialingProfile } from './credentialingProfile';
import { createLicense, submitLicenseForReview } from './licenseLifecycle';
import { createEducation, rejectHistoryRecord } from './professionalHistory';
import { ProfessionalHistorySection } from '@prisma/client';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Rdy Tenant ${suffix}`, slug: `rdy-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Rdy TenantB ${suffix}`, slug: `rdy-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: { firstName: 'Ready', lastName: `Prov${suffix}`, status: 'ACTIVE' }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const admin = await prisma.user.create({
    data: {
      email: `rdy.admin.${suffix}@test.local`,
      name: 'Rdy Admin',
      role: Role.ADMIN,
      passwordHash: 'x',
      active: true
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `rdy.client.${suffix}@test.local`,
      name: 'Rdy Client',
      role: Role.CLIENT_USER,
      passwordHash: 'x',
      active: true
    }
  });
  await prisma.tenantMembership.create({
    data: { userId: client.id, tenantId: tenant.id, role: 'TENANT_ADMIN', status: 'ACTIVE' }
  });
  return { tenant, tenantB, provider, admin, client, suffix };
}

test('missing specialty identified; readiness computed server-side', async () => {
  const { tenant, provider } = await seed();
  const r = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  assert.equal(r.providerId, provider.id);
  const specialty = r.dimensions.find((d) => d.key === 'specialty');
  assert.equal(specialty?.status, 'INCOMPLETE');
  assert.ok(specialty?.issues.some((i) => i.code === 'specialty.primary_missing'));
  assert.ok(r.disclaimer.includes('Operational readiness'));
  assert.notEqual(r.overall, undefined);
});

test('unified profile is tenant-scoped and includes history without duplicates', async () => {
  const { tenant, tenantB, provider, admin } = await seed();
  await createEducation(tenant.id, provider.id, {
    institutionName: 'State U',
    degreeName: 'MD',
    startDate: '2010-01-01',
    endDate: '2014-01-01'
  }, admin.id);

  const profile = await getUnifiedCredentialingProfile(tenant.id, provider.id, 'gpa');
  assert.equal(profile.tenantId, tenant.id);
  assert.equal(profile.professionalHistory.education, 1);
  assert.ok(Array.isArray(profile.licenses));

  await assert.rejects(
    () => getUnifiedCredentialingProfile(tenantB.id, provider.id, 'gpa'),
    (e: any) => e.status === 403 || e.status === 404
  );
});

test('expired license produces expired readiness dimension; pending distinct from complete', async () => {
  const { tenant, provider, admin } = await seed();
  const lic = await createLicense({
    tenantId: tenant.id,
    providerId: provider.id,
    body: {
      type: 'MD',
      number: 'EXP-1',
      state: 'TX',
      issuedAt: '2010-01-01',
      expiresAt: '2020-01-01'
    },
    actorId: admin.id,
    audience: 'gpa'
  });
  await submitLicenseForReview(tenant.id, lic.id, admin.id);

  const r = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  const licensesDim = r.dimensions.find((d) => d.key === 'licenses');
  const verifyDim = r.dimensions.find((d) => d.key === 'license_verification');
  const expDim = r.dimensions.find((d) => d.key === 'expiration_attention');
  assert.ok(
    licensesDim?.status === 'EXPIRED' || expDim?.status === 'EXPIRED',
    `expected expired attention, got licenses=${licensesDim?.status} exp=${expDim?.status}`
  );
  assert.notEqual(verifyDim?.status, 'COMPLETE');
  assert.equal(r.overall, 'EXPIRED_OR_INVALID_CREDENTIALS');
});

test('quarantined documents are not trusted evidence', async () => {
  const { tenant, provider } = await seed();
  await prisma.document.create({
    data: {
      title: 'Quarantined CV',
      type: 'CV',
      category: 'CREDENTIAL',
      providerId: provider.id,
      tenantId: tenant.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      storageKey: 'quarantine/x.pdf',
      status: 'RECEIVED'
    }
  });
  const r = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  const trust = r.dimensions.find((d) => d.key === 'document_trust');
  assert.equal(trust?.status, 'ACTION_REQUIRED');
  assert.ok(trust?.issues.some((i) => i.code === 'document.quarantined'));
  const evidence = r.dimensions.find((d) => d.key === 'credential_evidence');
  assert.ok(!evidence?.issues.some((i) => /trusted/i.test(i.message) && i.code.includes('quarantine')));
});

test('rejected history produces actionable gaps; recalc does not duplicate; resolve cannot bypass', async () => {
  const { tenant, provider, admin } = await seed();
  const edu = await createEducation(tenant.id, provider.id, {
    institutionName: 'Reject U',
    degreeName: 'MD',
    startDate: '2011-01-01',
    endDate: '2015-01-01'
  }, admin.id);
  await prisma.providerEducation.update({
    where: { id: edu.id },
    data: { verificationStatus: HistoryVerificationStatus.PENDING_REVIEW }
  });
  await rejectHistoryRecord(
    ProfessionalHistorySection.EDUCATION,
    tenant.id,
    provider.id,
    edu.id,
    admin.id,
    'Incomplete dates',
    {}
  );

  const first = await syncCredentialingGaps(tenant.id, provider.id, admin.id);
  assert.ok(first.gaps.length >= 1);
  const second = await syncCredentialingGaps(tenant.id, provider.id, admin.id);
  const gapIds = second.gaps.map((g) => g.fingerprint).sort();
  const unique = [...new Set(gapIds)];
  assert.equal(gapIds.length, unique.length);

  const openGap = second.gaps[0];
  await assert.rejects(
    () => attemptResolveGap(tenant.id, provider.id, openGap.id, admin.id),
    (e: any) => e.status === 409 && e.code === 'GAP_STILL_OPEN'
  );

  const tasks = await prisma.task.findMany({
    where: { tenantId: tenant.id, providerId: provider.id, source: GAP_SOURCE }
  });
  assert.ok(tasks.every((t) => t.fingerprint));
});

test('client audience cannot see GPA internal notes', async () => {
  const { tenant, provider, admin } = await seed();
  await startProfileReview(tenant.id, provider.id, admin.id, Role.ADMIN, {
    internalNotes: 'SECRET_INTERNAL_NOTE'
  });
  await requestProfileCorrections(tenant.id, provider.id, admin.id, Role.ADMIN, {
    clientVisibleNotes: 'Please add specialty',
    internalNotes: 'SECRET_INTERNAL_NOTE'
  });
  const clientView = await assessProviderReadiness(tenant.id, provider.id, 'client');
  assert.equal((clientView.profileReview as any)?.internalNotes, undefined);
  assert.equal(clientView.profileReview?.clientVisibleNotes, 'Please add specialty');

  const gpaView = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  assert.equal(gpaView.profileReview?.internalNotes, 'SECRET_INTERNAL_NOTE');
});

test('profile review complete does not self-verify licenses or history', async () => {
  const { tenant, provider, admin } = await seed();
  const lic = await createLicense({
    tenantId: tenant.id,
    providerId: provider.id,
    body: {
      type: 'MD',
      number: 'REV-1',
      state: 'CA',
      issuedAt: '2020-01-01',
      expiresAt: '2028-01-01'
    },
    actorId: admin.id,
    audience: 'gpa'
  });
  await submitLicenseForReview(tenant.id, lic.id, admin.id);

  await startProfileReview(tenant.id, provider.id, admin.id, Role.ADMIN);
  const done = await completeProfileReview(tenant.id, provider.id, admin.id, Role.ADMIN);
  assert.equal(done.review?.status, ProfileReviewStatus.COMPLETED);
  assert.match(done.notice, /were not changed/i);

  const after = await prisma.license.findUnique({ where: { id: lic.id } });
  assert.equal(after?.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);
});

test('client cannot drive GPA profile review; can submit corrections', async () => {
  assert.equal(canDriveProfileReview(Role.CLIENT_USER), false);
  assert.equal(canDriveProfileReview(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canDriveProfileReview(Role.ADMIN), true);

  const { tenant, provider, admin, client } = await seed();
  await startProfileReview(tenant.id, provider.id, admin.id, Role.ADMIN);
  await requestProfileCorrections(tenant.id, provider.id, admin.id, Role.ADMIN, {
    clientVisibleNotes: 'Need NPI'
  });
  await assert.rejects(
    () => startProfileReview(tenant.id, provider.id, client.id, Role.CLIENT_USER),
    (e: any) => e.status === 403
  );
  const submitted = await submitProfileCorrections(tenant.id, provider.id, client.id, Role.CLIENT_USER);
  assert.equal(submitted?.status, ProfileReviewStatus.RESUBMITTED);
});

test('unconfigured evidence is not marked mandatory in issues', async () => {
  const { tenant, provider, admin } = await seed();
  await createEducation(tenant.id, provider.id, {
    institutionName: 'No Doc U',
    degreeName: 'MD',
    startDate: '2012-01-01',
    endDate: '2016-01-01'
  }, admin.id);
  const r = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  assert.ok(!r.issues.some((i) => /mandatory evidence/i.test(i.message)));
  assert.ok(!r.issues.some((i) => i.code.endsWith('.evidence_required')));
});
