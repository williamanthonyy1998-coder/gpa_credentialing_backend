import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import {
  InvitationStatus,
  Role,
  TenantMembershipStatus,
  TenantOnboardingStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  acceptInvitation,
  assertInvitableTenantRole,
  createInvitation,
  generateInvitationToken,
  hashInvitationToken,
  platformRoleForClientUser,
  revokeInvitation,
  tokensEqual,
  validateInvitationToken
} from './invitations';
import {
  assertGpaClientAdmin,
  createClientAccount,
  sanitizeClientForPortal
} from './clients';
import { resolveTenantAuthContext } from './tenantAccess';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.TENANT_TESTS_SKIP !== '1';
const suffix = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('invitation tokens are hashed with SHA-256 and compared safely', () => {
  const raw = generateInvitationToken();
  assert.ok(raw.length >= 32);
  const hash = hashInvitationToken(raw);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, raw);
  assert.equal(tokensEqual(hash, hashInvitationToken(raw)), true);
  assert.equal(tokensEqual(hash, hashInvitationToken(raw + 'x')), false);
});

test('client invitations never use platform ADMIN role', () => {
  assert.equal(platformRoleForClientUser(), Role.CLIENT_USER);
  assert.throws(() => assertInvitableTenantRole('ADMIN' as TenantRole));
  assert.doesNotThrow(() => assertInvitableTenantRole(TenantRole.TENANT_ADMIN));
});

test('GPA client admin gate and internal notes sanitization', () => {
  assert.doesNotThrow(() => assertGpaClientAdmin(Role.ADMIN));
  assert.doesNotThrow(() => assertGpaClientAdmin(Role.CREDENTIALING_MANAGER));
  assert.throws(() => assertGpaClientAdmin(Role.CLIENT_USER), /Insufficient/);
  assert.throws(() => assertGpaClientAdmin(Role.CREDENTIALING_SPECIALIST), /Insufficient/);
  const safe = sanitizeClientForPortal({
    id: 't1',
    name: 'Acme',
    internalNotes: 'secret GPA note'
  });
  assert.equal(safe.internalNotes, undefined);
  assert.equal(safe.name, 'Acme');
});

test(
  'client create, invite hash storage, single-use accept, expiry, revoke, email mismatch, isolation',
  { skip: !RUN_DB },
  async () => {
    const passwordHash = await bcrypt.hash('InviteTest-ChangeThis-2026!', 4);

    const gpaAdmin = await prisma.user.create({
      data: {
        email: `gpa-admin-${suffix}@example.test`,
        name: 'GPA Admin',
        passwordHash,
        role: Role.ADMIN,
        active: true
      }
    });
    const unauthorized = await prisma.user.create({
      data: {
        email: `specialist-${suffix}@example.test`,
        name: 'Specialist',
        passwordHash,
        role: Role.CREDENTIALING_SPECIALIST,
        active: true
      }
    });

    assert.throws(() => assertGpaClientAdmin(unauthorized.role), /Insufficient/);

    const clientA = await createClientAccount({
      name: `Client A ${suffix}`,
      slug: `client-a-${suffix}`,
      primaryContactEmail: `contact-a-${suffix}@example.test`,
      internalNotes: 'GPA only note A'
    });
    const clientB = await createClientAccount({
      name: `Client B ${suffix}`,
      slug: `client-b-${suffix}`,
      internalNotes: 'GPA only note B'
    });
    assert.equal(clientA.onboardingStatus, TenantOnboardingStatus.NOT_STARTED);
    assert.ok(clientA.internalNotes);

    const inviteResult = await createInvitation({
      tenantId: clientA.id,
      email: `new-user-${suffix}@example.test`,
      role: TenantRole.TENANT_ADMIN,
      invitedById: gpaAdmin.id,
      send: false
    });
    assert.ok(inviteResult.acceptanceUrl);
    const rawToken = inviteResult.acceptanceUrl!.split('/accept-invitation/')[1];
    assert.ok(rawToken);
    const stored = await prisma.tenantInvitation.findUniqueOrThrow({
      where: { id: inviteResult.invitation.id }
    });
    assert.equal(stored.tokenHash, hashInvitationToken(rawToken));
    assert.notEqual(stored.tokenHash, rawToken);
    assert.equal(JSON.stringify(stored).includes(rawToken), false);

    const refreshedTenant = await prisma.tenant.findUniqueOrThrow({ where: { id: clientA.id } });
    assert.equal(refreshedTenant.onboardingStatus, TenantOnboardingStatus.INVITED);

    await assert.rejects(
      () => createInvitation({
        tenantId: clientA.id,
        email: `new-user-${suffix}@example.test`,
        role: TenantRole.TENANT_ADMIN,
        invitedById: gpaAdmin.id,
        send: false
      }),
      /pending invitation already exists/i
    );

    await assert.rejects(
      () => acceptInvitation({
        rawToken,
        email: `other-${suffix}@example.test`,
        name: 'Wrong Email',
        password: 'SecurePassword123!'
      }),
      /email does not match/i
    );

    const accepted = await acceptInvitation({
      rawToken,
      email: `new-user-${suffix}@example.test`,
      name: 'New Client Admin',
      password: 'SecurePassword123!'
    });
    assert.equal(accepted.tenantId, clientA.id);
    assert.equal(accepted.role, TenantRole.TENANT_ADMIN);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: accepted.userId } });
    assert.equal(user.role, Role.CLIENT_USER);
    assert.notEqual(user.role, Role.ADMIN);

    const memberships = await prisma.tenantMembership.findMany({
      where: { userId: user.id, tenantId: clientA.id }
    });
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].role, TenantRole.TENANT_ADMIN);

    const invitationAfter = await prisma.tenantInvitation.findUniqueOrThrow({
      where: { id: inviteResult.invitation.id }
    });
    assert.equal(invitationAfter.status, InvitationStatus.ACCEPTED);
    assert.notEqual(invitationAfter.tokenHash, hashInvitationToken(rawToken));

    await assert.rejects(
      () => acceptInvitation({
        rawToken,
        email: `new-user-${suffix}@example.test`,
        name: 'Reuse',
        password: 'SecurePassword123!'
      }),
      /invalid or no longer available/i
    );

    // Existing user accepts second invite without duplicate account
    const existingInvite = await createInvitation({
      tenantId: clientA.id,
      email: `existing-${suffix}@example.test`,
      role: TenantRole.CREDENTIALING_SPECIALIST,
      invitedById: gpaAdmin.id,
      send: false
    });
    const existingRaw = existingInvite.acceptanceUrl!.split('/accept-invitation/')[1];
    const existingUser = await prisma.user.create({
      data: {
        email: `existing-${suffix}@example.test`,
        name: 'Existing User',
        passwordHash,
        role: Role.CLIENT_USER,
        active: true
      }
    });
    await assert.rejects(
      () => acceptInvitation({
        rawToken: existingRaw,
        email: existingUser.email,
        name: 'Should Fail',
        password: 'SecurePassword123!'
      }),
      /already exists/i
    );
    const authAccept = await acceptInvitation({
      rawToken: existingRaw,
      email: existingUser.email,
      authenticatedUserId: existingUser.id
    });
    assert.equal(authAccept.userId, existingUser.id);
    const dupUsers = await prisma.user.count({ where: { email: existingUser.email } });
    assert.equal(dupUsers, 1);

    // Expired invitation rejected
    const expiredInvite = await createInvitation({
      tenantId: clientA.id,
      email: `expired-${suffix}@example.test`,
      role: TenantRole.READ_ONLY,
      invitedById: gpaAdmin.id,
      send: false
    });
    const expiredRaw = expiredInvite.acceptanceUrl!.split('/accept-invitation/')[1];
    await prisma.tenantInvitation.update({
      where: { id: expiredInvite.invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) }
    });
    await assert.rejects(
      () => validateInvitationToken(expiredRaw),
      /invalid or no longer available/i
    );

    // Revoked invitation rejected
    const revokeInvite = await createInvitation({
      tenantId: clientA.id,
      email: `revoke-${suffix}@example.test`,
      role: TenantRole.AUDITOR,
      invitedById: gpaAdmin.id,
      send: false
    });
    const revokeRaw = revokeInvite.acceptanceUrl!.split('/accept-invitation/')[1];
    await revokeInvitation(revokeInvite.invitation.id);
    await assert.rejects(
      () => validateInvitationToken(revokeRaw),
      /invalid or no longer available/i
    );

    // Cross-tenant isolation: client A user cannot resolve as member of B
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: user.id,
        platformRole: user.role,
        requestedTenantId: clientB.id,
        platformAccessHeader: undefined
      }),
      /Access denied/i
    );
    const ctxOwn = await resolveTenantAuthContext({
      userId: user.id,
      platformRole: user.role,
      requestedTenantId: clientA.id,
      platformAccessHeader: undefined
    });
    assert.equal(ctxOwn.tenantId, clientA.id);
    assert.ok(!ctxOwn.activeMemberships.some((m) => m.tenantId === clientB.id));

    // Org isolation: org in B not visible via A list filter
    const orgB = await prisma.organization.create({
      data: {
        tenantId: clientB.id,
        legalName: `Org B ${suffix}`,
        status: 'ACTIVE'
      }
    });
    const orgsA = await prisma.organization.findMany({ where: { tenantId: clientA.id } });
    assert.equal(orgsA.some((o) => o.id === orgB.id), false);

    // Suspended membership loses access
    await prisma.tenantMembership.update({
      where: { id: memberships[0].id },
      data: { status: TenantMembershipStatus.SUSPENDED }
    });
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: user.id,
        platformRole: Role.CLIENT_USER,
        requestedTenantId: clientA.id,
        platformAccessHeader: undefined
      }),
      /Access denied/i
    );

    // Suspended client account blocks usable tenant access
    await prisma.tenantMembership.update({
      where: { id: memberships[0].id },
      data: { status: TenantMembershipStatus.ACTIVE }
    });
    await prisma.tenant.update({
      where: { id: clientA.id },
      data: { status: TenantStatus.SUSPENDED, onboardingStatus: TenantOnboardingStatus.SUSPENDED }
    });
    await assert.rejects(
      () => resolveTenantAuthContext({
        userId: user.id,
        platformRole: Role.CLIENT_USER,
        requestedTenantId: clientA.id,
        platformAccessHeader: undefined
      }),
      /Access denied/i
    );
    const tenantRow = await prisma.tenant.findUniqueOrThrow({ where: { id: clientA.id } });
    assert.equal(tenantRow.status, TenantStatus.SUSPENDED);

    // Raw invitation tokens must never appear in persisted invitation rows after accept
    const acceptedRow = await prisma.tenantInvitation.findUniqueOrThrow({
      where: { id: inviteResult.invitation.id }
    });
    assert.equal(JSON.stringify(acceptedRow).includes(rawToken), false);
    assert.equal(JSON.stringify(acceptedRow).includes(existingRaw), false);
  }
);
