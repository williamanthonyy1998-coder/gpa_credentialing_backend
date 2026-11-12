import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import {
  InvitationDeliveryStatus,
  InvitationStatus,
  IntakeStatus,
  Prisma,
  Role,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { appBaseUrl, escapeHtml, isEmailConfigured, sendEmail } from './email';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code || 'PROVIDER_INVITE_ERROR';
  throw err;
}

export function providerInviteExpiryDays(): number {
  const n = Number(process.env.PROVIDER_INTAKE_INVITE_EXPIRY_DAYS || process.env.INVITATION_EXPIRY_DAYS || 14);
  return Number.isFinite(n) && n > 0 ? Math.min(90, n) : 14;
}

export function generateProviderInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashProviderInviteToken(rawToken: string): string {
  return createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

export function providerTokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function inviteSelect() {
  return {
    id: true,
    tenantId: true,
    intakeRequestId: true,
    email: true,
    knownProviderId: true,
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
    tenant: { select: { id: true, name: true, slug: true, status: true } },
    intakeRequest: { select: { id: true, referenceNo: true, status: true, kind: true } }
  } as const;
}

export async function createProviderIntakeInvitation(input: {
  tenantId: string;
  intakeRequestId: string;
  email: string;
  invitedById: string;
  knownProviderId?: string | null;
  send?: boolean;
}) {
  const email = input.email.trim().toLowerCase();
  if (!email) deny('Invitation email is required');

  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) deny('Client account not found', 404);
  if (tenant.status === TenantStatus.INACTIVE || tenant.status === TenantStatus.SUSPENDED) {
    deny('Cannot invite providers to an inactive or suspended client');
  }

  const intake = await prisma.intakeRequest.findUnique({ where: { id: input.intakeRequestId } });
  if (!intake || intake.tenantId !== input.tenantId) deny('Intake request not found', 404);
  if (['CONVERTED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(intake.status)) {
    deny('Cannot invite for a closed intake request');
  }

  const existingPending = await prisma.providerIntakeInvitation.findFirst({
    where: {
      intakeRequestId: intake.id,
      email,
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() }
    }
  });
  if (existingPending) deny('A pending provider invitation already exists for this email', 409, 'INVITATION_PENDING_EXISTS');

  const rawToken = generateProviderInviteToken();
  const tokenHash = hashProviderInviteToken(rawToken);
  const expiresAt = new Date(Date.now() + providerInviteExpiryDays() * 24 * 60 * 60 * 1000);

  const row = await prisma.providerIntakeInvitation.create({
    data: {
      tenantId: input.tenantId,
      intakeRequestId: intake.id,
      email,
      knownProviderId: input.knownProviderId || null,
      invitedById: input.invitedById,
      tokenHash,
      status: InvitationStatus.PENDING,
      expiresAt,
      deliveryStatus: InvitationDeliveryStatus.NOT_SENT
    },
    select: inviteSelect()
  });

  {
    const { assertTransition } = await import('./intakeStateMachine');
    let nextStatus = intake.status;
    if (intake.status === IntakeStatus.DRAFT || intake.status === IntakeStatus.SENT) {
      assertTransition(intake.status, IntakeStatus.INVITED, 'invite provider');
      nextStatus = IntakeStatus.INVITED;
    }
    await prisma.intakeRequest.update({
      where: { id: intake.id },
      data: {
        invitedEmail: email,
        status: nextStatus,
        sentAt: intake.sentAt || new Date()
      }
    });
  }

  await prisma.intakeEvent.create({
    data: {
      intakeId: intake.id,
      action: 'PROVIDER_INVITED',
      actorId: input.invitedById,
      detail: { invitationId: row.id, email }
    }
  });

  let delivery: { sent: boolean; error?: string; configured?: boolean } = { sent: false };
  if (input.send !== false) {
    delivery = await deliverProviderInviteEmail({
      invitationId: row.id,
      rawToken,
      email,
      tenantName: tenant.name,
      inviterName: row.invitedBy?.name || 'GPA Credentialing',
      referenceNo: intake.referenceNo,
      expiresAt
    });
  }

  return {
    invitation: row,
    delivery,
    acceptanceUrl: !delivery.sent
      ? `${appBaseUrl()}/accept-provider-invitation/${rawToken}`
      : undefined
  };
}

async function deliverProviderInviteEmail(input: {
  invitationId: string;
  rawToken: string;
  email: string;
  tenantName: string;
  inviterName: string;
  referenceNo: string;
  expiresAt: Date;
}) {
  if (!isEmailConfigured()) {
    await prisma.providerIntakeInvitation.update({
      where: { id: input.invitationId },
      data: {
        deliveryStatus: InvitationDeliveryStatus.FAILED,
        deliveryError: 'Email service is not configured'
      }
    });
    return { sent: false, configured: false, error: 'Email service is not configured' };
  }

  const acceptUrl = `${appBaseUrl()}/accept-provider-invitation/${input.rawToken}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#19324a">
  <h2>Provider credentialing intake invitation</h2>
  <p>${escapeHtml(input.inviterName)} invited you to complete a credentialing intake for <b>${escapeHtml(input.tenantName)}</b>.</p>
  <p>Reference: <b>${escapeHtml(input.referenceNo)}</b></p>
  <p><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#087e8b;color:#fff;padding:12px 18px;border-radius:7px;text-decoration:none">Open intake invitation</a></p>
  <p>This invitation expires on <b>${escapeHtml(input.expiresAt.toUTCString())}</b>.</p>
  <p>If you were not expecting this email, ignore it or contact GPA support. Do not forward this link.</p>
</div>`;

  const result = await sendEmail({
    to: input.email,
    subject: `Provider intake invitation — ${input.referenceNo}`,
    html
  });

  await prisma.providerIntakeInvitation.update({
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

  return result.ok
    ? { sent: true, configured: true }
    : { sent: false, configured: true, error: result.error };
}

export async function resendProviderIntakeInvitation(invitationId: string, actorId: string) {
  const row = await prisma.providerIntakeInvitation.findUnique({
    where: { id: invitationId },
    include: {
      tenant: true,
      intakeRequest: true,
      invitedBy: { select: { name: true } }
    }
  });
  if (!row) deny('Invitation not found', 404);
  if (row.status !== InvitationStatus.PENDING) deny('Only pending invitations can be resent');
  if (row.expiresAt <= new Date()) {
    await prisma.providerIntakeInvitation.update({
      where: { id: row.id },
      data: { status: InvitationStatus.EXPIRED }
    });
    deny('Invitation has expired');
  }

  const rawToken = generateProviderInviteToken();
  const tokenHash = hashProviderInviteToken(rawToken);
  await prisma.providerIntakeInvitation.update({
    where: { id: row.id },
    data: { tokenHash }
  });

  const delivery = await deliverProviderInviteEmail({
    invitationId: row.id,
    rawToken,
    email: row.email,
    tenantName: row.tenant.name,
    inviterName: row.invitedBy?.name || 'GPA Credentialing',
    referenceNo: row.intakeRequest.referenceNo,
    expiresAt: row.expiresAt
  });

  await prisma.intakeEvent.create({
    data: {
      intakeId: row.intakeRequestId,
      action: 'PROVIDER_INVITE_RESENT',
      actorId,
      detail: { invitationId: row.id, email: row.email }
    }
  });

  const updated = await prisma.providerIntakeInvitation.findUniqueOrThrow({
    where: { id: row.id },
    select: inviteSelect()
  });

  return {
    invitation: updated,
    delivery,
    acceptanceUrl: !delivery.sent
      ? `${appBaseUrl()}/accept-provider-invitation/${rawToken}`
      : undefined
  };
}

export async function revokeProviderIntakeInvitation(invitationId: string, actorId?: string) {
  const row = await prisma.providerIntakeInvitation.findUnique({ where: { id: invitationId } });
  if (!row) deny('Invitation not found', 404);
  if (row.status !== InvitationStatus.PENDING) deny('Only pending invitations can be revoked');
  const updated = await prisma.providerIntakeInvitation.update({
    where: { id: invitationId },
    data: {
      status: InvitationStatus.REVOKED,
      revokedAt: new Date(),
      tokenHash: hashProviderInviteToken(`revoked:${invitationId}:${randomBytes(16).toString('hex')}`)
    },
    select: inviteSelect()
  });
  if (actorId) {
    await prisma.intakeEvent.create({
      data: {
        intakeId: row.intakeRequestId,
        action: 'PROVIDER_INVITE_REVOKED',
        actorId,
        detail: { invitationId: row.id, email: row.email }
      }
    });
  }
  return updated;
}

export async function validateProviderInviteToken(rawToken: string) {
  const tokenHash = hashProviderInviteToken(rawToken);
  const row = await prisma.providerIntakeInvitation.findUnique({
    where: { tokenHash },
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true } },
      intakeRequest: { select: { id: true, referenceNo: true, status: true, kind: true } }
    }
  });
  if (!row) deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  if (row.status === InvitationStatus.REVOKED || row.status === InvitationStatus.ACCEPTED) {
    deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  }
  if (row.status === InvitationStatus.EXPIRED || row.expiresAt <= new Date()) {
    if (row.status === InvitationStatus.PENDING) {
      await prisma.providerIntakeInvitation.update({
        where: { id: row.id },
        data: { status: InvitationStatus.EXPIRED }
      });
    }
    deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  }
  if (row.tenant.status !== TenantStatus.ACTIVE) {
    deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: row.email },
    select: { id: true, email: true, active: true }
  });

  return {
    invitationId: row.id,
    email: row.email,
    expiresAt: row.expiresAt,
    tenant: row.tenant,
    intake: row.intakeRequest,
    userExists: Boolean(existingUser)
  };
}

export async function acceptProviderIntakeInvitation(input: {
  rawToken: string;
  email: string;
  name?: string;
  password?: string;
  authenticatedUserId?: string | null;
}) {
  const tokenHash = hashProviderInviteToken(input.rawToken);
  const email = input.email.trim().toLowerCase();

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.providerIntakeInvitation.findUnique({
      where: { tokenHash },
      include: { tenant: true, intakeRequest: true }
    });
    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }
    if (invitation.expiresAt <= new Date()) {
      await tx.providerIntakeInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED }
      });
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }
    if (invitation.email !== email) deny('Invitation email does not match', 400, 'EMAIL_MISMATCH');
    if (invitation.tenant.status !== TenantStatus.ACTIVE) {
      deny('Invitation is invalid or no longer available', 400, 'INVITATION_INVALID');
    }

    let user = await tx.user.findUnique({ where: { email } });
    if (input.authenticatedUserId) {
      if (!user || user.id !== input.authenticatedUserId) {
        deny('Signed-in account does not match the invitation email', 403, 'EMAIL_MISMATCH');
      }
    } else if (user) {
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
          role: Role.EXTERNAL_PROVIDER,
          active: true
        }
      });
    }

    // Never create TenantMembership for external providers.
    // Never elevate existing CLIENT_USER / staff to ADMIN.
    if (user!.role !== Role.EXTERNAL_PROVIDER && user!.role !== Role.CLIENT_USER) {
      // Existing staff accepting a provider invite keeps their platform role but only gets intake assignment.
    } else if (user!.role === Role.CLIENT_USER) {
      // Keep CLIENT_USER; intake access is via providerUserId assignment.
    } else if (!input.authenticatedUserId) {
      // new user already EXTERNAL_PROVIDER
    }

    {
      const { assertTransition } = await import('./intakeStateMachine');
      const from = invitation.intakeRequest.status;
      if (from !== IntakeStatus.IN_PROGRESS) {
        // Invite creation should have moved DRAFT/SENT → INVITED; accept continues to IN_PROGRESS.
        assertTransition(from, IntakeStatus.IN_PROGRESS, 'accept provider invite');
      }
    }
    await tx.intakeRequest.update({
      where: { id: invitation.intakeRequestId },
      data: {
        providerUserId: user!.id,
        invitedEmail: email,
        status: IntakeStatus.IN_PROGRESS
      }
    });

    await tx.providerIntakeInvitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedUserId: user!.id,
        tokenHash: hashProviderInviteToken(`accepted:${invitation.id}:${randomBytes(16).toString('hex')}`)
      }
    });

    await tx.intakeEvent.create({
      data: {
        intakeId: invitation.intakeRequestId,
        action: 'PROVIDER_INVITE_ACCEPTED',
        actorId: user!.id,
        detail: { invitationId: invitation.id }
      }
    });

    return {
      userId: user!.id,
      tenantId: invitation.tenantId,
      intakeRequestId: invitation.intakeRequestId,
      email: user!.email,
      name: user!.name,
      role: user!.role
    };
  });
}

export async function listProviderInvitations(tenantId: string, intakeRequestId?: string) {
  await prisma.providerIntakeInvitation.updateMany({
    where: {
      tenantId,
      status: InvitationStatus.PENDING,
      expiresAt: { lte: new Date() },
      ...(intakeRequestId ? { intakeRequestId } : {})
    },
    data: { status: InvitationStatus.EXPIRED }
  });
  return prisma.providerIntakeInvitation.findMany({
    where: {
      tenantId,
      ...(intakeRequestId ? { intakeRequestId } : {})
    },
    select: inviteSelect(),
    orderBy: { createdAt: 'desc' },
    take: 200
  });
}
