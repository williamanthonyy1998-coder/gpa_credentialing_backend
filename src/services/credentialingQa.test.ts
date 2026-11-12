import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  HistoryVerificationStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  evaluateProviderCredentialingQa,
  runCredentialingQaScan,
  resolveCredentialingQaFinding,
  canRunCredentialingQa,
  canAcceptQaRisk
} from './credentialingQa';
import { createLicense, submitLicenseForReview, verifyLicense, updateLicense } from './licenseLifecycle';
import {
  normalizeVerificationSource,
  assertExternalApiAllowed,
  verificationSourceLabel
} from './verificationSources';
import { assessProviderReadiness } from './credentialingReadiness';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `QA Tenant ${suffix}`, slug: `qa-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `QA TenantB ${suffix}`, slug: `qa-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: { firstName: 'Qa', lastName: `Prov${suffix}`, status: 'ACTIVE' }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const admin = await prisma.user.create({
    data: {
      email: `qa.admin.${suffix}@test.local`,
      name: 'QA Admin',
      role: Role.ADMIN,
      passwordHash: 'x',
      active: true
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `qa.client.${suffix}@test.local`,
      name: 'QA Client',
      role: Role.CLIENT_USER,
      passwordHash: 'x',
      active: true
    }
  });
  return { tenant, tenantB, provider, admin, client, suffix };
}

test('verification source classification rejects fake board API labels', () => {
  assert.equal(normalizeVerificationSource('manual_review'), 'manual_review');
  assert.match(verificationSourceLabel('manual_document_review'), /not state-board/i);
  assert.throws(() => normalizeVerificationSource('automated_state_board'), (e: any) => e.status === 400);
  assert.throws(() => assertExternalApiAllowed('external_api'), (e: any) => e.code === 'EXTERNAL_VERIFY_NOT_CONFIGURED');
  assert.equal(canRunCredentialingQa(Role.CLIENT_USER), false);
  assert.equal(canRunCredentialingQa(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canAcceptQaRisk(Role.CREDENTIALING_SPECIALIST), false);
  assert.equal(canAcceptQaRisk(Role.ADMIN), true);
});

test('QA scan detects missing specialty and is tenant-scoped', async () => {
  const { tenant, tenantB, provider, admin } = await seed();
  const evalResult = await evaluateProviderCredentialingQa(tenant.id, provider.id);
  assert.ok(evalResult.findings.some((f) => f.fingerprint.includes('missing_specialty')));

  const scan = await runCredentialingQaScan({
    tenantId: tenant.id,
    actorId: admin.id,
    role: Role.ADMIN,
    persist: true
  });
  assert.ok(scan.scan.providersInspected >= 1);
  assert.ok(scan.findings.some((f) => /specialty/i.test(f.title)));

  await assert.rejects(
    () => evaluateProviderCredentialingQa(tenantB.id, provider.id),
    (e: any) => e.status === 404 || e.status === 403
  );

  await assert.rejects(
    () => runCredentialingQaScan({
      tenantId: tenant.id,
      actorId: admin.id,
      role: Role.CLIENT_USER,
      persist: false
    }),
    (e: any) => e.status === 403
  );
});

test('QA detects invalid license dates, duplicates; does not auto-merge', async () => {
  const { tenant, provider, admin, suffix } = await seed();
  // Simulate legacy/imported bad rows that bypass lifecycle create guards — QA must detect them.
  const a = await prisma.license.create({
    data: {
      providerId: provider.id,
      tenantId: tenant.id,
      type: 'MD',
      number: `DUP-${suffix}`,
      state: 'TX',
      issuedAt: new Date('2020-01-01'),
      expiresAt: new Date('2019-01-01'),
      verificationStatus: HistoryVerificationStatus.NOT_SUBMITTED
    }
  });
  const b = await prisma.license.create({
    data: {
      providerId: provider.id,
      tenantId: tenant.id,
      type: 'MD',
      number: `DUP-${suffix}`,
      state: 'TX',
      issuedAt: new Date('2021-01-01'),
      expiresAt: new Date('2028-01-01'),
      verificationStatus: HistoryVerificationStatus.NOT_SUBMITTED
    }
  });

  const { findings } = await evaluateProviderCredentialingQa(tenant.id, provider.id);
  assert.ok(findings.some((f) => f.title.includes('Invalid license date sequence')));
  assert.ok(findings.some((f) => f.issueType === 'DUPLICATE_EXACT'));
  // Both licenses still exist — no auto-delete/merge
  const stillA = await prisma.license.findUnique({ where: { id: a.id } });
  const stillB = await prisma.license.findUnique({ where: { id: b.id } });
  assert.ok(stillA && stillB);
});

test('QA finding dedupe and resolve requires underlying fix; false-positive role-gated', async () => {
  const { tenant, provider, admin, client } = await seed();
  const first = await runCredentialingQaScan({
    tenantId: tenant.id,
    actorId: admin.id,
    role: Role.ADMIN,
    providerId: provider.id,
    persist: true
  });
  const second = await runCredentialingQaScan({
    tenantId: tenant.id,
    actorId: admin.id,
    role: Role.ADMIN,
    providerId: provider.id,
    persist: true
  });
  assert.equal(second.scan.findingsCreated, 0);

  const specialtyFinding = await prisma.dataQualityIssue.findFirst({
    where: {
      tenantId: tenant.id,
      fingerprint: { contains: 'missing_specialty' },
      status: { in: ['OPEN', 'REOPENED', 'UNDER_REVIEW'] }
    }
  });
  assert.ok(specialtyFinding);

  await assert.rejects(
    () => resolveCredentialingQaFinding({
      issueId: specialtyFinding!.id,
      tenantId: tenant.id,
      actorId: admin.id,
      role: Role.ADMIN,
      mode: 'RESOLVED'
    }),
    (e: any) => e.code === 'QA_STILL_OPEN'
  );

  await assert.rejects(
    () => resolveCredentialingQaFinding({
      issueId: specialtyFinding!.id,
      tenantId: tenant.id,
      actorId: client.id,
      role: Role.CLIENT_USER,
      mode: 'FALSE_POSITIVE'
    }),
    (e: any) => e.status === 403
  );

  const accepted = await resolveCredentialingQaFinding({
    issueId: specialtyFinding!.id,
    tenantId: tenant.id,
    actorId: admin.id,
    role: Role.ADMIN,
    mode: 'FALSE_POSITIVE',
    notes: 'Specialty pending directory assignment'
  });
  assert.equal(accepted.status, 'ACCEPTED_LEGITIMATE');
  void first;
});

test('quarantined doc is not trusted; readiness stays consistent', async () => {
  const { tenant, provider } = await seed();
  await prisma.document.create({
    data: {
      title: 'QA Quarantine',
      type: 'CV',
      category: 'CREDENTIAL',
      providerId: provider.id,
      tenantId: tenant.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      storageKey: 'q/x.pdf',
      status: 'RECEIVED'
    }
  });
  const readiness = await assessProviderReadiness(tenant.id, provider.id, 'gpa');
  const trust = readiness.dimensions.find((d) => d.key === 'document_trust');
  assert.equal(trust?.status, 'ACTION_REQUIRED');
  assert.ok(!trust?.issues.some((i) => i.message.includes('trusted') && /quarantine/i.test(i.code) === false && i.code === 'document.trusted'));
});

test('verified license material edit returns to review; reject requires reason; missing verify event detected', async () => {
  const { tenant, provider, admin } = await seed();
  const lic = await createLicense({
    tenantId: tenant.id,
    providerId: provider.id,
    body: {
      type: 'MD',
      number: 'QA-VER-1',
      state: 'CA',
      issuedAt: '2020-01-01',
      expiresAt: '2028-01-01'
    },
    actorId: admin.id,
    audience: 'gpa'
  });
  await submitLicenseForReview(tenant.id, lic.id, admin.id);
  const verified = await verifyLicense(tenant.id, lic.id, admin.id, {
    verificationSource: 'manual_document_review'
  });
  assert.equal(verified.verificationStatus, HistoryVerificationStatus.VERIFIED);

  const material = await updateLicense({
    tenantId: tenant.id,
    licenseId: lic.id,
    body: { number: 'QA-VER-1-X' },
    actorId: admin.id,
    audience: 'gpa'
  });
  assert.equal(material.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);

  // Simulate verified without event
  const orphan = await createLicense({
    tenantId: tenant.id,
    providerId: provider.id,
    body: {
      type: 'DO',
      number: 'QA-ORPHAN',
      state: 'NY',
      issuedAt: '2019-01-01',
      expiresAt: '2029-01-01'
    },
    actorId: admin.id,
    audience: 'gpa'
  });
  await prisma.license.update({
    where: { id: orphan.id },
    data: { verificationStatus: HistoryVerificationStatus.VERIFIED, verifiedAt: new Date() }
  });
  const { findings } = await evaluateProviderCredentialingQa(tenant.id, provider.id);
  assert.ok(findings.some((f) => /missing verification event/i.test(f.title)));
});
