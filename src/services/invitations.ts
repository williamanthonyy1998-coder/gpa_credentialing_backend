import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import {
  InvitationDeliveryStatus,
  InvitationStatus,
  Prisma,
  Role,
  TenantOnboardingStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { appBaseUrl, escapeHtml, isEmailConfigured, sendEmail } from './email';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code || 'INVITATION_ERROR';
  throw err;
}

export function invitationExpiryDays(): number {
  const n = Number(process.env.INVITATION_EXPIRY_DAYS || 7);
  return Number.isFinite(n) && n > 0 ? Math.min(90, n) : 7;
}

/** Cryptographically secure raw token — returned once; only hash is persisted. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const CLIENT_INVITE_ROLES: TenantRole[] = [
  TenantRole.TENANT_ADMIN,
  TenantRole.CREDENTIALING_MANAGER,
  TenantRole.CREDENTIALING_SPECIALIST,
  TenantRole.ENROLLMENT_SPECIALIST,
  TenantRole.APPROVER,
  TenantRole.AUDITOR,
  TenantRole.READ_ONLY
];

export function assertInvitableTenantRole(role: TenantRole) {
  if (!CLIENT_INVITE_ROLES.includes(role)) deny('Invalid invitation role');
  // Never invite to platform admin via this flow (platform Role is separate).
}

export function platformRoleForClientUser(): Role {
  return Role.CLIENT_USER;
}

function invitationSelect() {
  return {
    id: true,
    tenantId: true,
    email: true,
    role: true,
    status: true,
    deliveryStatus: true,
    deliveryError: true,
    expiresAt: true,
    acceptedAt: true,
    revokedAt: true,
    lastSentAt: true,
    acceptedUserId: true,
    createdAt: true,
    updatedAt: true,
    invitedBy: { select: { id: true, name: true, email: true } },
    tenant: { select: { id: true, name: true, slug: true, status: true, onboardingStatus: true } }
  } as const;
}

export async function createInvitation(input: {
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedById: string;
  send?: boolean;
}) {
  assertInvitableTenantRole(input.role);
  const email = input.email.trim().toLowerCase();
  if (!email) deny('Invitation email is required');

  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) deny('Client account not found', 404);
  if (tenant.status === TenantStatus.INACTIVE) deny('Cannot invite users to an inactive client');

  const existingPending = await prisma.tenantInvitation.findFirst({
    where: { tenantId: input.tenantId, email, status: InvitationStatus.PENDING }
  });
  if (existingPending && existingPending.expiresAt > new Date()) {
    deny('A pending invitation already exists for this email', 409, 'INVITATION_PENDING_EXISTS');
  }

  const existingMembership = await prisma.tenantMembership.findFirst({
    where: {
      tenantId: input.tenantId,
      user: { email }
    }
  });
  if (existingMembership?.status === 'ACTIVE') {
    deny('User is already an active member of this client', 409, 'MEMBERSHIP_EXISTS');
  }

  const rawToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(rawToken);
  const expiresAt = new Date(Date.now() + invitationExpiryDays() * 24 * 60 * 60 * 1000);

  const row = await prisma.tenantInvitation.create({
    data: {
      tenantId: input.tenantId,
      email,
      role: input.role,
      invitedById: input.invitedById,
      tokenHash,
      status: InvitationStatus.PENDING,
      expiresAt,
      deliveryStatus: InvitationDeliveryStatus.NOT_SENT
    },
    select: invitationSelect()
  });

  if (tenant.onboardingStatus === TenantOnboardingStatus.NOT_STARTED) {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { onboardingStatus: TenantOnboardingStatus.INVITED }
    });
  }

  let delivery: { sent: boolean; error?: string; configured?: boolean } = { sent: false };
  if (input.send !== false) {
    delivery = await deliverInvitationEmail({
      invitationId: row.id,
      rawToken,
      email,
      tenantName: tenant.name,
      inviterName: row.invitedBy?.name || 'GPA Administrator',
      role: input.role,
      expiresAt
    });
  }

  // Never return raw token except when email is not configured (dev handoff).
  return {
    invitation: row,
    delivery,
    // Only expose acceptance URL when email was not delivered so GPA can share out-of-band.
    acceptanceUrl:
      !delivery.sent
        ? `${appBaseUrl()}/accept-invitation/${rawToken}`
        : undefined
  };
}

export async function deliverInvitationEmail(input: {
  invitationId: string;
  rawToken: string;
  email: string;
  tenantName: string;
  inviterName: string;
  role: TenantRole;
  expiresAt: Date;
}) {
  if (!isEmailConfigured()) {
    await prisma.tenantInvitation.update({
      where: { id: input.invitationId },
      data: {
        deliveryStatus: InvitationDeliveryStatus.FAILED,
        deliveryError: 'Email service is not configured'
      }
    });
    return { sent: false, configured: false, error: 'Email service is not configured' };
  }

  const acceptUrl = `${appBaseUrl()}/accept-invitation/${input.rawToken}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#19324a">
  <h2>You're invited to GPA Credentialing</h2>
  <p>${escapeHtml(input.inviterName)} invited you to join <b>${escapeHtml(input.tenantName)}</b> as <b>${escapeHtml(input.role.replaceAll('_', ' '))}</b>.</p>
  <p><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#087e8b;color:#fff;padding:12px 18px;border-radius:7px;text-decoration:none">Accept invitation</a></p>
  <p>This invitation expires on <b>${escapeHtml(input.expiresAt.toUTCString())}</b>.</p>
  <p>If you were not expecting this email, ignore it or contact GPA support. Do not forward this link.</p>
</div>`;

  const result = await sendEmail({
    to: input.email,
    subject: `Invitation to ${input.tenantName} on GPA Credentialing`,
    html
  });

  await prisma.tenantInvitation.update({
    where: { id: input.invitationId },
    data: result.ok
      ? {
          deliveryStatus: InvitationDeliveryStatus.SENT,
          deliveryError: null,
          lastSentAt: new Date()
        }
      : {
          deliveryStatus: InvitationDeliveryStatus.FAILED,
          deliveryError: result.error.slice(0, 500)
        }
  });

  if (!result.ok) {
    return { sent: false, configured: result.configured, error: result.error };
  }
  return { sent: true, configured: true };
}

export async function resendInvitation(invitationId: string, actorId: string) {
  const row = await prisma.tenantInvitation.findUnique({
    where: { id: invitationId },
    include: {
      tenant: true,
      invitedBy: { select: { name: true } }
    }
  });
  if (!row) deny('Invitation not found', 404);
  if (row.status !== InvitationStatus.PENDING) deny('Only pending invitations can be resent');
  if (row.expiresAt <= new Date()) {
    await prisma.tenantInvitation.update({
      where: { id: row.id },
      data: { status: InvitationStatus.EXPIRED }
    });
    deny('Invitation has expired');
  }

  // Rotate token on resend so old links stop working.
  const rawToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(rawToken);
  await prisma.tenantInvitation.update({
    where: { id: row.id },
    data: { tokenHash, invitedById: actorId }
  });

  const delivery = await deliverInvitationEmail({
    invitationId: row.id,
    rawToken,
    email: row.email,
    tenantName: row.tenant.name,
    inviterName: row.invitedBy?.name || 'GPA Administrator',
    role: row.role,
    expiresAt: row.expiresAt
  });

  const updated = await prisma.tenantInvitation.findUniqueOrThrow({
    where: { id: row.id },
    select: invitationSelect()
  });

  return {
    invitation: updated,
    delivery,
    acceptanceUrl: !delivery.sent ? `${appBaseUrl()}/accept-invitation/${rawToken}` : undefined
  };
}

export async function revokeInvitation(invitationId: string) {
  const row = await prisma.tenantInvitation.findUnique({ where: { id: invitationId } });
  if (!row) deny('Invitation not found', 404);
  if (row.status !== InvitationStatus.PENDING) deny('Only pending invitations can be revoked');
  return prisma.tenantInvitation.update({
    where: { id: invitationId },
    data: {
      status: InvitationStatus.REVOKED,
      revokedAt: new Date(),
      // Invalidate token hash so the raw link cannot be validated.
      tokenHash: hashInvitationToken(`revoked:${row.id}:${randomBytes(16).toString('hex')}`)
    },
    select: invitationSelect()
  });
}

export async function validateInvitationToken(rawToken: string) {
  const tokenHash = hashInvitationToken(rawToken);
  const row = await prisma.tenantInvitation.findUnique({
    where: { tokenHash },
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true, onboardingStatus: true } }
    }
  });
  // Generic messaging — do not distinguish missing vs invalid.
  if (!row) deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');

  if (row.status === InvitationStatus.REVOKED) deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  if (row.status === InvitationStatus.ACCEPTED) deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  if (row.status === InvitationStatus.EXPIRED || row.expiresAt <= new Date()) {
    if (row.status === InvitationStatus.PENDING) {
      await prisma.tenantInvitation.update({
        where: { id: row.id },
        data: { status: InvitationStatus.EXPIRED }
      });
    }
    deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  }
  if (row.tenant.status === TenantStatus.INACTIVE || row.tenant.status === TenantStatus.SUSPENDED) {
    deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: row.email },
    select: { id: true, email: true, name: true, active: true }
  });

  return {
    invitationId: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    tenant: row.tenant,
    userExists: Boolean(existingUser),
    // Do not leak whether user exists beyond boolean needed for UX; keep generic on errors.
  };
}

export async function acceptInvitation(input: {
  rawToken: string;
  email: string;
  /** Required when registering a new user. */
  name?: string;
  password?: string;
  /** When accepting while authenticated. */
  authenticatedUserId?: string | null;
}) {
  const tokenHash = hashInvitationToken(input.rawToken);
  const email = input.email.trim().toLowerCase();

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.tenantInvitation.findUnique({
      where: { tokenHash },
      include: { tenant: true }
    });
    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }
    if (invitation.expiresAt <= new Date()) {
      await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED }
      });
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }
    if (invitation.email !== email) {
      deny('Invitation email does not match', 400, 'EMAIL_MISMATCH');
    }
    if (
      invitation.tenant.status === TenantStatus.INACTIVE ||
      invitation.tenant.status === TenantStatus.SUSPENDED
    ) {
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }

    let user = await tx.user.findUnique({ where: { email } });
    if (input.authenticatedUserId) {
      if (!user || user.id !== input.authenticatedUserId) {
        deny('Signed-in account does not match the invitation email', 403, 'EMAIL_MISMATCH');
      }
    } else if (user) {
      // Existing account must authenticate separately — do not accept password here for existing users
      // without verifying they own the account. Caller must login first.
      deny('An account with this email already exists. Sign in to accept the invitation.', 409, 'USER_EXISTS');
    } else {
      const name = String(input.name || '').trim();
      const password = String(input.password || '');
      if (name.length < 2) deny('Name is required');
      if (password.length < 12) deny('Password must be at least 12 characters');
      user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash: await bcrypt.hash(password, 12),
          role: platformRoleForClientUser(),
          active: true
        }
      });
    }

    const existingMembership = await tx.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: user!.id, tenantId: invitation.tenantId } }
    });
    if (existingMembership) {
      await tx.tenantMembership.update({
        where: { id: existingMembership.id },
        data: {
          role: invitation.role,
          status: 'ACTIVE'
        }
      });
    } else {
      try {
        await tx.tenantMembership.create({
          data: {
            userId: user!.id,
            tenantId: invitation.tenantId,
            role: invitation.role,
            status: 'ACTIVE'
          }
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          deny('Membership already exists', 409);
        }
        throw e;
      }
    }

    // Invitation acceptance never elevates User.role to platform ADMIN.

    await tx.tenantInvitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedUserId: user!.id,
        // Rotate hash so the raw token cannot be reused.
        tokenHash: hashInvitationToken(`accepted:${invitation.id}:${randomBytes(16).toString('hex')}`)
      }
    });

    const onboarding =
      invitation.tenant.onboardingStatus === TenantOnboardingStatus.NOT_STARTED ||
      invitation.tenant.onboardingStatus === TenantOnboardingStatus.INVITED
        ? TenantOnboardingStatus.ACCOUNT_ACTIVATED
        : invitation.tenant.onboardingStatus;

    if (onboarding !== invitation.tenant.onboardingStatus) {
      await tx.tenant.update({
        where: { id: invitation.tenantId },
        data: { onboardingStatus: onboarding }
      });
    }

    return {
      userId: user!.id,
      tenantId: invitation.tenantId,
      role: invitation.role,
      email: user!.email,
      name: user!.name
    };
  });
}

export async function listInvitations(tenantId: string) {
  // Expire stale pending rows opportunistically
  await prisma.tenantInvitation.updateMany({
    where: { tenantId, status: InvitationStatus.PENDING, expiresAt: { lte: new Date() } },
    data: { status: InvitationStatus.EXPIRED }
  });
  return prisma.tenantInvitation.findMany({
    where: { tenantId },
    select: invitationSelect(),
    orderBy: { createdAt: 'desc' },
    take: 200
  });
}
