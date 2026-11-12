import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  InvitationStatus,
  IntakeStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  acceptProviderIntakeInvitation,
  createProviderIntakeInvitation,
  generateProviderInviteToken,
  hashProviderInviteToken,
  revokeProviderIntakeInvitation,
  validateProviderInviteToken
} from './providerInvitations';
import {
  assertProviderOwnsIntake,
  createIntakeDocumentMeta,
  listProviderIntakes,
  requestIntakeChanges,
  saveProviderDraft,
  submitProviderIntake,
  approveIntake,
  resolveAmbiguousIdentity
} from './providerIntake';
import { convertIntake } from './intakeConvert';
import { validateUploadedFile, GENERAL_ALLOWED_MIME } from './fileMagic';
import { resolveTenantAuthContext } from './tenantAccess';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.TENANT_TESTS_SKIP !== '1';
const suffix = `pi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('provider invite tokens are hashed and never equal raw', () => {
  const raw = generateProviderInviteToken();
  const hash = hashProviderInviteToken(raw);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, raw);
});

test('file magic rejects path-like names and bad mime for intake uploads', () => {
  const tmp = path.join(os.tmpdir(), `cred-upload-${suffix}.txt`);
  fs.writeFileSync(tmp, 'not a pdf');
  const bad = validateUploadedFile({
    filePath: tmp,
    originalName: '../evil.exe',
    declaredMime: 'application/pdf',
    allowedMimes: GENERAL_ALLOWED_MIME
  });
  assert.equal(bad.ok, false);
  fs.unlinkSync(tmp);
});

test(
  'provider invitation, access isolation, draft/submit/changes, conversion with TenantProvider',
  { skip: !RUN_DB },
  async () => {
    const passwordHash = await bcrypt.hash('ProviderIntake-Test-2026!', 4);
    const gpaAdmin = await prisma.user.create({
      data: {
        email: `gpa-${suffix}@example.test`,
        name: 'GPA Admin',
        passwordHash,
        role: Role.ADMIN,
        active: true
      }
    });
    const specialist = await prisma.user.create({
      data: {
        email: `spec-${suffix}@example.test`,
        name: 'Specialist',
        passwordHash,
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });

    const tenantA = await prisma.tenant.create({
      data: { name: `PI Tenant A ${suffix}`, slug: `pi-a-${suffix}`, status: TenantStatus.ACTIVE }
    });
    const tenantB = await prisma.tenant.create({
      data: { name: `PI Tenant B ${suffix}`, slug: `pi-b-${suffix}`, status: TenantStatus.ACTIVE }
    });

    await prisma.tenantMembership.create({
      data: {
        userId: specialist.id,
        tenantId: tenantA.id,
        role: TenantRole.CREDENTIALING_SPECIALIST,
        status: 'ACTIVE'
      }
    });

    const intakeA = await prisma.intakeRequest.create({
      data: {
        tenantId: tenantA.id,
        referenceNo: `INT-A-${suffix}`,
        kind: 'PROVIDER',
        status: IntakeStatus.DRAFT,
        createdById: gpaAdmin.id,
        contactEmail: `prov-${suffix}@example.test`,
        payload: {}
      }
    });
    const intakeB = await prisma.intakeRequest.create({
      data: {
        tenantId: tenantB.id,
        referenceNo: `INT-B-${suffix}`,
        kind: 'PROVIDER',
        status: IntakeStatus.DRAFT,
        createdById: gpaAdmin.id,
        contactEmail: `other-${suffix}@example.test`,
        payload: {}
      }
    });

    // Unauthorized role gate is enforced at route layer; service allows create for valid tenant
    const invite = await createProviderIntakeInvitation({
      tenantId: tenantA.id,
      intakeRequestId: intakeA.id,
      email: `prov-${suffix}@example.test`,
      invitedById: gpaAdmin.id,
      send: false
    });
    assert.ok(invite.acceptanceUrl);
    const raw = invite.acceptanceUrl!.split('/accept-provider-invitation/')[1];
    const stored = await prisma.providerIntakeInvitation.findUniqueOrThrow({ where: { id: invite.invitation.id } });
    assert.equal(stored.tokenHash, hashProviderInviteToken(raw));
    assert.equal(JSON.stringify(stored).includes(raw), false);

    await assert.rejects(
      () => createProviderIntakeInvitation({
        tenantId: tenantA.id,
        intakeRequestId: intakeA.id,
        email: `prov-${suffix}@example.test`,
        invitedById: gpaAdmin.id,
        send: false
      }),
      /pending provider invitation already exists/i
    );

    await assert.rejects(
      () => acceptProviderIntakeInvitation({
        rawToken: raw,
        email: `wrong-${suffix}@example.test`,
        name: 'Wrong',
        password: 'SecurePassword123!'
      }),
      /email does not match/i
    );

    const accepted = await acceptProviderIntakeInvitation({
      rawToken: raw,
      email: `prov-${suffix}@example.test`,
      name: 'External Provider',
      password: 'SecurePassword123!'
    });
    const providerUser = await prisma.user.findUniqueOrThrow({ where: { id: accepted.userId } });
    assert.equal(providerUser.role, Role.EXTERNAL_PROVIDER);
    // No TenantMembership created
    const memberships = await prisma.tenantMembership.count({ where: { userId: providerUser.id } });
    assert.equal(memberships, 0);

    await assert.rejects(() => acceptProviderIntakeInvitation({
      rawToken: raw,
      email: `prov-${suffix}@example.test`,
      name: 'Reuse',
      password: 'SecurePassword123!'
    }), /invalid or no longer available/i);

    // Expired
    const expInvite = await createProviderIntakeInvitation({
      tenantId: tenantA.id,
      intakeRequestId: intakeA.id,
      email: `exp-${suffix}@example.test`,
      invitedById: gpaAdmin.id,
      send: false
    });
    const expRaw = expInvite.acceptanceUrl!.split('/accept-provider-invitation/')[1];
    await prisma.providerIntakeInvitation.update({
      where: { id: expInvite.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    await assert.rejects(() => validateProviderInviteToken(expRaw), /invalid or no longer available/i);

    // Revoked
    const revInvite = await createProviderIntakeInvitation({
      tenantId: tenantA.id,
      intakeRequestId: intakeA.id,
      email: `rev-${suffix}@example.test`,
      invitedById: gpaAdmin.id,
      send: false
    });
    const revRaw = revInvite.acceptanceUrl!.split('/accept-provider-invitation/')[1];
    await revokeProviderIntakeInvitation(revInvite.invitation.id, gpaAdmin.id);
    await assert.rejects(() => validateProviderInviteToken(revRaw), /invalid or no longer available/i);

    // Assign intake B to another provider — provider A cannot access
    const otherUser = await prisma.user.create({
      data: {
        email: `other-user-${suffix}@example.test`,
        name: 'Other Provider',
        passwordHash,
        role: Role.EXTERNAL_PROVIDER,
        active: true
      }
    });
    await prisma.intakeRequest.update({
      where: { id: intakeB.id },
      data: { providerUserId: otherUser.id, status: IntakeStatus.IN_PROGRESS }
    });

    await assert.rejects(
      () => assertProviderOwnsIntake(providerUser.id, intakeB.id),
      /not found/i
    );
    const mine = await listProviderIntakes(providerUser.id);
    assert.ok(mine.every((i) => i.id !== intakeB.id));
    assert.ok(mine.some((i) => i.id === intakeA.id));

    // Draft + submit
    // Use a valid NPI checksum: 1679578061 is commonly used in examples — verify with validateNpi
    const { validateNpi } = await import('./npiValidation');
    // Generate a known-valid NPI: 1234567893 is a classic valid example
    const npi = '1234567893';
    assert.equal(validateNpi(npi).ok, true);

    await saveProviderDraft(providerUser.id, intakeA.id, {
      provider: {
        firstName: 'Pat',
        lastName: 'Provider',
        npi,
        email: `prov-${suffix}@example.test`,
        licenses: [{ type: 'MD', number: `L-${suffix}`, state: 'TX' }]
      }
    });
    const submitted = await submitProviderIntake(providerUser.id, intakeA.id);
    assert.equal(submitted.status, IntakeStatus.SUBMITTED);
    assert.ok(submitted.submittedPayload);

    // Editing draft after submit should fail
    await assert.rejects(
      () => saveProviderDraft(providerUser.id, intakeA.id, { provider: { firstName: 'X' } }),
      /can no longer be edited/i
    );

    // Changes requested → resubmit preserves new snapshot
    await requestIntakeChanges(intakeA.id, gpaAdmin.id, 'Please fix specialty', {});
    await saveProviderDraft(providerUser.id, intakeA.id, {
      provider: {
        firstName: 'Pat',
        lastName: 'Provider',
        npi,
        primarySpecialty: 'Family Medicine',
        licenses: [{ type: 'MD', number: `L-${suffix}`, state: 'TX' }]
      }
    });
    const resub = await submitProviderIntake(providerUser.id, intakeA.id);
    assert.equal(resub.status, IntakeStatus.RESUBMITTED);

    // If NPI already exists from prior runs / other tenants, explicitly resolve before approve.
    const pending = await prisma.intakeRequest.findUniqueOrThrow({ where: { id: intakeA.id } });
    if (pending.identityMatch === 'AMBIGUOUS' || pending.identityMatch === 'MATCHED') {
      await resolveAmbiguousIdentity(
        intakeA.id,
        gpaAdmin.id,
        'USE_EXISTING',
        pending.matchedProviderId
      );
    }
    await approveIntake(intakeA.id, gpaAdmin.id, {});
    const converted = await convertIntake(intakeA.id, gpaAdmin.id);
    assert.ok(converted.providerId);
    const link = await prisma.tenantProvider.findUnique({
      where: { tenantId_providerId: { tenantId: tenantA.id, providerId: converted.providerId! } }
    });
    assert.ok(link);

    // Cross-tenant: provider cannot resolve tenant B context without membership
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: providerUser.id,
        platformRole: Role.EXTERNAL_PROVIDER,
        requestedTenantId: tenantB.id
      }),
      /Access denied/i
    );

    // Document metadata quarantined
    const doc = await createIntakeDocumentMeta({
      tenantId: tenantA.id,
      intakeRequestId: intakeA.id,
      createdById: providerUser.id,
      title: 'License copy',
      type: 'LICENSE'
    });
    assert.equal(doc.securityStatus, 'QUARANTINED');

    // Specialist cannot invent cross-tenant invite
    await assert.rejects(
      () => createProviderIntakeInvitation({
        tenantId: tenantB.id,
        intakeRequestId: intakeA.id,
        email: `cross-${suffix}@example.test`,
        invitedById: specialist.id,
        send: false
      }),
      /not found/i
    );

    assert.equal(InvitationStatus.PENDING, 'PENDING');
  }
);
