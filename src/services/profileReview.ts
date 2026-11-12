import { ProfileReviewStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { assessProviderReadiness } from './credentialingReadiness';
import { syncCredentialingGaps } from './credentialingGaps';
import { notifyUser } from './notifications';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

/** GPA roles that may drive internal profile review (not client/provider). */
export function canDriveProfileReview(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canViewInternalReviewNotes(role: Role) {
  return canDriveProfileReview(role) || role === Role.AUDITOR || role === Role.ENROLLMENT_SPECIALIST;
}

async function getOrCreateReview(tenantId: string, providerId: string) {
  const existing = await prisma.providerProfileReview.findFirst({
    where: { tenantId, providerId },
    orderBy: { updatedAt: 'desc' }
  });
  if (existing) return existing;
  return prisma.providerProfileReview.create({
    data: {
      tenantId,
      providerId,
      status: ProfileReviewStatus.NOT_STARTED
    }
  });
}

function sanitizeReview(row: any, audience: 'gpa' | 'client' | 'provider') {
  if (!row) return null;
  const out: any = {
    id: row.id,
    tenantId: row.tenantId,
    providerId: row.providerId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    correctionsRequestedAt: row.correctionsRequestedAt,
    resubmittedAt: row.resubmittedAt,
    clientVisibleNotes: row.clientVisibleNotes,
    readinessSnapshot: row.readinessSnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (audience === 'gpa') {
    out.internalNotes = row.internalNotes;
    out.startedById = row.startedById;
    out.completedById = row.completedById;
  }
  return out;
}

async function notifyTenantCredentialingManagers(
  tenantId: string,
  payload: { title: string; body: string; entityId: string; href?: string }
) {
  const memberships = await prisma.tenantMembership.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      role: { in: ['TENANT_ADMIN', 'CREDENTIALING_MANAGER'] }
    },
    select: { userId: true }
  });
  await Promise.all(
    memberships.map((m) =>
      notifyUser({
        userId: m.userId,
        title: payload.title,
        body: payload.body,
        type: 'PROFILE_REVIEW',
        entityType: 'ProviderProfileReview',
        entityId: payload.entityId,
        href: payload.href
      })
    )
  );
}

async function notifyExternalProviderForProvider(
  tenantId: string,
  providerId: string,
  payload: { title: string; body: string; entityId: string }
) {
  const intake = await prisma.intakeRequest.findFirst({
    where: { tenantId, convertedProviderId: providerId, providerUserId: { not: null } },
    select: { providerUserId: true }
  });
  if (intake?.providerUserId) {
    await notifyUser({
      userId: intake.providerUserId,
      title: payload.title,
      body: payload.body,
      type: 'PROFILE_REVIEW',
      entityType: 'ProviderProfileReview',
      entityId: payload.entityId,
      href: `/provider-portal`
    });
  }
}

export async function getProfileReview(
  tenantId: string,
  providerId: string,
  audience: 'gpa' | 'client' | 'provider'
) {
  await assertProviderInTenant(tenantId, providerId);
  const row = await prisma.providerProfileReview.findFirst({
    where: { tenantId, providerId },
    orderBy: { updatedAt: 'desc' }
  });
  return sanitizeReview(row, audience);
}

export async function listProfileReviewHistory(tenantId: string, providerId: string) {
  await assertProviderInTenant(tenantId, providerId);
  // Single current review row; history is reflected via audit events.
  const audits = await prisma.auditEvent.findMany({
    where: {
      tenantId,
      entityType: 'ProviderProfileReview',
      OR: [
        { entityId: providerId },
        { after: { path: ['providerId'], equals: providerId } as any }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      action: true,
      actorId: true,
      createdAt: true,
      after: true,
      before: true
    }
  });
  return audits.map((a) => ({
    id: a.id,
    action: a.action,
    actorId: a.actorId,
    createdAt: a.createdAt,
    // Strip any accidental internal notes from client-facing history builders at route layer.
    summary: (a.after as any)?.status || (a.after as any)?.reviewStatus || null
  }));
}

/**
 * Start internal profile review. Does NOT verify licenses or history records.
 */
export async function startProfileReview(
  tenantId: string,
  providerId: string,
  actorId: string,
  role: Role,
  notes?: { internalNotes?: string }
) {
  if (!canDriveProfileReview(role)) deny('Insufficient permissions', 403);
  await assertProviderInTenant(tenantId, providerId);
  const readiness = await assessProviderReadiness(tenantId, providerId, 'gpa');
  const row = await getOrCreateReview(tenantId, providerId);
  if (row.status === ProfileReviewStatus.COMPLETED) {
    // Allow reopening a new cycle by resetting.
  }
  const updated = await prisma.providerProfileReview.update({
    where: { id: row.id },
    data: {
      status: ProfileReviewStatus.IN_PROGRESS,
      startedAt: new Date(),
      startedById: actorId,
      completedAt: null,
      completedById: null,
      internalNotes: notes?.internalNotes ?? row.internalNotes,
      readinessSnapshot: {
        overall: readiness.overall,
        dimensions: readiness.dimensions.map((d) => ({ key: d.key, status: d.status })),
        assessedAt: readiness.assessedAt
      }
    }
  });
  await syncCredentialingGaps(tenantId, providerId, actorId);
  return sanitizeReview(updated, 'gpa');
}

export async function requestProfileCorrections(
  tenantId: string,
  providerId: string,
  actorId: string,
  role: Role,
  input: { clientVisibleNotes: string; internalNotes?: string }
) {
  if (!canDriveProfileReview(role)) deny('Insufficient permissions', 403);
  if (!String(input.clientVisibleNotes || '').trim()) {
    deny('clientVisibleNotes are required when requesting corrections');
  }
  await assertProviderInTenant(tenantId, providerId);
  const readiness = await assessProviderReadiness(tenantId, providerId, 'gpa');
  const row = await getOrCreateReview(tenantId, providerId);
  if (
    row.status !== ProfileReviewStatus.IN_PROGRESS
    && row.status !== ProfileReviewStatus.RESUBMITTED
    && row.status !== ProfileReviewStatus.CORRECTIONS_REQUESTED
  ) {
    deny('Start profile review before requesting corrections', 409, 'REVIEW_NOT_STARTED');
  }
  const updated = await prisma.providerProfileReview.update({
    where: { id: row.id },
    data: {
      status: ProfileReviewStatus.CORRECTIONS_REQUESTED,
      correctionsRequestedAt: new Date(),
      clientVisibleNotes: String(input.clientVisibleNotes).trim(),
      internalNotes: input.internalNotes != null ? String(input.internalNotes) : row.internalNotes,
      readinessSnapshot: {
        overall: readiness.overall,
        dimensions: readiness.dimensions.map((d) => ({ key: d.key, status: d.status })),
        assessedAt: readiness.assessedAt
      }
    }
  });
  await syncCredentialingGaps(tenantId, providerId, actorId);
  await notifyTenantCredentialingManagers(tenantId, {
    title: 'Provider corrections requested',
    body: 'GPA requested missing information or corrections on a provider credentialing profile.',
    entityId: updated.id,
    href: `/providers/${providerId}/profile?step=readiness`
  });
  await notifyExternalProviderForProvider(tenantId, providerId, {
    title: 'Corrections requested on your credentialing profile',
    body: String(input.clientVisibleNotes).trim().slice(0, 400),
    entityId: updated.id
  });
  return sanitizeReview(updated, 'gpa');
}

/**
 * Client/provider marks that corrections were submitted. Does NOT self-verify licenses/history.
 */
export async function submitProfileCorrections(
  tenantId: string,
  providerId: string,
  actorId: string,
  role: Role
) {
  if (role !== Role.CLIENT_USER && role !== Role.EXTERNAL_PROVIDER && !canDriveProfileReview(role)) {
    deny('Insufficient permissions', 403);
  }
  await assertProviderInTenant(tenantId, providerId);
  const row = await getOrCreateReview(tenantId, providerId);
  if (row.status !== ProfileReviewStatus.CORRECTIONS_REQUESTED) {
    deny('No corrections have been requested', 409, 'NO_CORRECTIONS_REQUESTED');
  }
  const readiness = await assessProviderReadiness(tenantId, providerId, 'gpa');
  const updated = await prisma.providerProfileReview.update({
    where: { id: row.id },
    data: {
      status: ProfileReviewStatus.RESUBMITTED,
      resubmittedAt: new Date(),
      readinessSnapshot: {
        overall: readiness.overall,
        dimensions: readiness.dimensions.map((d) => ({ key: d.key, status: d.status })),
        assessedAt: readiness.assessedAt
      }
    }
  });
  await syncCredentialingGaps(tenantId, providerId, actorId);

  // Notify GPA reviewers who started the review when known.
  if (row.startedById) {
    await notifyUser({
      userId: row.startedById,
      title: 'Provider profile corrections submitted',
      body: 'Requested corrections were submitted for reassessment.',
      type: 'PROFILE_REVIEW',
      entityType: 'ProviderProfileReview',
      entityId: updated.id,
      href: `/providers/${providerId}/profile?step=readiness`
    });
  }
  return sanitizeReview(updated, role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER ? 'client' : 'gpa');
}

/**
 * Complete internal profile review. Explicitly does NOT verify licenses or history.
 */
export async function completeProfileReview(
  tenantId: string,
  providerId: string,
  actorId: string,
  role: Role,
  notes?: { internalNotes?: string }
) {
  if (!canDriveProfileReview(role)) deny('Insufficient permissions', 403);
  await assertProviderInTenant(tenantId, providerId);
  const readiness = await assessProviderReadiness(tenantId, providerId, 'gpa');
  const row = await getOrCreateReview(tenantId, providerId);
  if (
    row.status !== ProfileReviewStatus.IN_PROGRESS
    && row.status !== ProfileReviewStatus.RESUBMITTED
  ) {
    deny('Profile review must be in progress or resubmitted to complete', 409, 'INVALID_REVIEW_STATE');
  }
  const updated = await prisma.providerProfileReview.update({
    where: { id: row.id },
    data: {
      status: ProfileReviewStatus.COMPLETED,
      completedAt: new Date(),
      completedById: actorId,
      internalNotes: notes?.internalNotes ?? row.internalNotes,
      readinessSnapshot: {
        overall: readiness.overall,
        dimensions: readiness.dimensions.map((d) => ({ key: d.key, status: d.status })),
        assessedAt: readiness.assessedAt,
        note: 'Profile review completion does not verify individual licenses or history records.'
      }
    }
  });
  await notifyTenantCredentialingManagers(tenantId, {
    title: 'Provider profile review completed',
    body: 'Internal credentialing profile review was marked complete (not payer approval).',
    entityId: updated.id,
    href: `/providers/${providerId}/profile?step=readiness`
  });
  return {
    review: sanitizeReview(updated, 'gpa'),
    readiness,
    notice:
      'Internal profile review completed. Individual licenses and professional history verification statuses were not changed by this action.'
  };
}
