import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  HistoryVerificationStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  canVerifyLicense,
  computeLicenseAttention,
  createLicense,
  renewLicense,
  rejectLicense,
  submitLicenseForReview,
  updateLicense,
  verifyLicense
} from './licenseLifecycle';
import { getProviderCredentialCompleteness } from './credentialCompleteness';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Lic Tenant ${suffix}`, slug: `lic-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: { firstName: 'Lic', lastName: `Prov${suffix}`, status: 'ACTIVE' }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const admin = await prisma.user.create({
    data: {
      email: `lic.admin.${suffix}@test.local`,
      name: 'Lic Admin',
      role: Role.ADMIN,
      passwordHash: 'x',
      active: true
    }
  });
  return { tenant, provider, admin, suffix };
}

test('computeLicenseAttention windows and expired/current rules', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'VERIFIED',
    expiresAt: '2026-06-01'
  }, now), 'EXPIRED');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'VERIFIED',
    expiresAt: '2026-07-01'
  }, now), 'EXPIRING_30');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'VERIFIED',
    expiresAt: '2026-08-10'
  }, now), 'EXPIRING_60');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'VERIFIED',
    expiresAt: '2026-09-10'
  }, now), 'EXPIRING_90');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'VERIFIED',
    expiresAt: '2027-01-01'
  }, now), 'ACTIVE');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', verificationStatus: 'PENDING_REVIEW',
    expiresAt: '2027-01-01'
  }, now), 'PENDING_REVIEW');
  assert.equal(computeLicenseAttention({ type: 'MD' }, now), 'INCOMPLETE');
  assert.equal(computeLicenseAttention({
    type: 'MD', number: '1', archived: true, verificationStatus: 'VERIFIED'
  }, now), 'ARCHIVED');
});

test('only authorized roles verify licenses', () => {
  assert.equal(canVerifyLicense(Role.ADMIN), true);
  assert.equal(canVerifyLicense(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canVerifyLicense(Role.CLIENT_USER), false);
  assert.equal(canVerifyLicense(Role.CREDENTIALING_SPECIALIST), false);
});

test('license create, duplicate, submit, verify, reject, renew, re-review', async () => {
  const ctx = await seed();
  const created = await createLicense({
    tenantId: ctx.tenant.id,
    providerId: ctx.provider.id,
    body: {
      type: 'MD',
      number: `MD-${ctx.suffix}`,
      state: 'TX',
      issuedAt: '2020-01-01',
      expiresAt: '2027-01-01'
    },
    actorId: ctx.admin.id,
    audience: 'gpa'
  });
  assert.equal(created.verificationStatus, HistoryVerificationStatus.NOT_SUBMITTED);
  assert.ok(['DRAFT', 'INCOMPLETE'].includes(created.attention) || created.attention === 'DRAFT');

  await assert.rejects(
    () => createLicense({
      tenantId: ctx.tenant.id,
      providerId: ctx.provider.id,
      body: { type: 'MD', number: `MD-${ctx.suffix}`, state: 'TX' },
      actorId: ctx.admin.id,
      audience: 'gpa'
    }),
    (e: any) => e.code === 'DUPLICATE_LICENSE'
  );

  const submitted = await submitLicenseForReview(ctx.tenant.id, created.id, ctx.admin.id);
  assert.equal(submitted.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);

  await assert.rejects(
    () => rejectLicense(ctx.tenant.id, created.id, ctx.admin.id, '', {}),
  );

  const verified = await verifyLicense(ctx.tenant.id, created.id, ctx.admin.id, {
    verificationSource: 'manual_review'
  });
  assert.equal(verified.verificationStatus, HistoryVerificationStatus.VERIFIED);

  const edited = await updateLicense({
    tenantId: ctx.tenant.id,
    licenseId: created.id,
    body: { notes: 'material? no' },
    actorId: ctx.admin.id,
    audience: 'gpa'
  });
  // notes-only should not force re-review
  assert.equal(edited.verificationStatus, HistoryVerificationStatus.VERIFIED);

  const material = await updateLicense({
    tenantId: ctx.tenant.id,
    licenseId: created.id,
    body: { number: `MD-${ctx.suffix}-X` },
    actorId: ctx.admin.id,
    audience: 'gpa'
  });
  assert.equal(material.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);

  const renewal = await renewLicense({
    tenantId: ctx.tenant.id,
    licenseId: created.id,
    body: { issuedAt: '2026-01-01', expiresAt: '2028-01-01' },
    actorId: ctx.admin.id,
    audience: 'gpa'
  });
  assert.equal(renewal.renewedFromId || (await prisma.license.findUnique({ where: { id: renewal.id } }))?.renewedFromId, created.id);
  assert.equal(renewal.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);
  // Prior license expiration preserved
  const prior = await prisma.license.findUnique({ where: { id: created.id } });
  assert.ok(prior?.expiresAt);
  assert.notEqual(String(prior?.expiresAt), String(renewal.expiresAt));

  // Quarantined document blocks verify
  const qdoc = await prisma.document.create({
    data: {
      title: 'Lic scan',
      type: 'SUPPORTING',
      category: 'licenses',
      tenantId: ctx.tenant.id,
      providerId: ctx.provider.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      status: 'RECEIVED'
    }
  });
  await prisma.license.update({ where: { id: renewal.id }, data: { documentId: qdoc.id } });
  await assert.rejects(
    () => verifyLicense(ctx.tenant.id, renewal.id, ctx.admin.id, {}),
    (e: any) => e.code === 'DOCUMENT_NOT_TRUSTED'
  );

  const completeness = await getProviderCredentialCompleteness(ctx.tenant.id, ctx.provider.id);
  assert.ok(completeness.counts.licensesTotal >= 2);
  assert.ok(Array.isArray(completeness.unresolved));
  assert.ok(completeness.disclaimer.includes('does not mean'));
});
