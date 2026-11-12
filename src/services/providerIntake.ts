import {
  DocumentSecurityStatus,
  IntakeStatus,
  ProviderIdentityMatch,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { missingIntakeFields } from './intakeConvert';
import { validateNpi } from './npiValidation';
import { appBaseUrl, escapeHtml, isEmailConfigured, sendEmail } from './email';
import { notifyUser } from './notifications';
import {
  assertTransition,
  isEditableByProvider,
  isSubmittableByProvider
} from './intakeStateMachine';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code || 'PROVIDER_INTAKE_ERROR';
  throw err;
}

export function sanitizeIntakeForProvider(row: any) {
  if (!row) return row;
  const { internalNotes, ...safe } = row;
  return safe;
}

export function sanitizeIntakeForClient(row: any) {
  if (!row) return row;
  const { internalNotes, ...safe } = row;
  return safe;
}

export async function assertProviderOwnsIntake(userId: string, intakeId: string) {
  const row = await prisma.intakeRequest.findUnique({
    where: { id: intakeId },
    include: {
      tenant: { select: { id: true, name: true, status: true } },
      organization: { select: { id: true, legalName: true } },
      events: { orderBy: { createdAt: 'desc' }, take: 50 },
      documents: {
        where: { securityStatus: { not: DocumentSecurityStatus.DELETED } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          type: true,
          category: true,
          status: true,
          securityStatus: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          uploadedAt: true,
          createdAt: true,
          // Never expose storageKey to providers
        }
      },
      submissions: {
        orderBy: { version: 'desc' },
        take: 20,
        select: {
          id: true,
          version: true,
          submittedAt: true,
          reviewAction: true,
          reviewComments: true,
          reviewedAt: true
        }
      }
    }
  });
  if (!row || row.providerUserId !== userId) deny('Intake request not found', 404);
  return row;
}

export async function listProviderIntakes(userId: string) {
  const rows = await prisma.intakeRequest.findMany({
    where: { providerUserId: userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      referenceNo: true,
      kind: true,
      status: true,
      invitedEmail: true,
      lastSavedAt: true,
      submittedAt: true,
      changesRequestedAt: true,
      approvedAt: true,
      rejectedAt: true,
      convertedAt: true,
      convertedProviderId: true,
      reviewerComments: true,
      rejectionReason: true,
      createdAt: true,
      updatedAt: true,
      tenant: { select: { id: true, name: true } },
      missingFields: true
    }
  });
  return rows;
}

export async function getProviderDashboard(userId: string) {
  const intakes = await listProviderIntakes(userId);
  const counts = {
    total: intakes.length,
    draft: intakes.filter((i) => ['INVITED', 'IN_PROGRESS', 'DRAFT'].includes(i.status)).length,
    submitted: intakes.filter((i) => ['SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW'].includes(i.status)).length,
    changesRequested: intakes.filter((i) => i.status === 'CHANGES_REQUESTED').length,
    approved: intakes.filter((i) => ['APPROVED', 'CONVERTED'].includes(i.status)).length,
    rejected: intakes.filter((i) => i.status === 'REJECTED').length
  };
  const convertedProviders = intakes
    .filter((i: any) => i.convertedProviderId)
    .map((i: any) => ({
      providerId: i.convertedProviderId,
      referenceNo: i.referenceNo,
      tenantName: i.tenant?.name || null,
      intakeId: i.id
    }));
  // Dedupe by providerId
  const seen = new Set<string>();
  const uniqueProviders = convertedProviders.filter((p) => {
    if (seen.has(p.providerId)) return false;
    seen.add(p.providerId);
    return true;
  });
  return { counts, intakes: intakes.slice(0, 20), convertedProviders: uniqueProviders };
}

function providerPayloadFromBody(payload: any) {
  if (!payload || typeof payload !== 'object') return {};
  // Strip any attempt to inject ownership / conversion fields
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.tenantId;
  delete clone.providerUserId;
  delete clone.internalNotes;
  return clone;
}

export async function saveProviderDraft(userId: string, intakeId: string, payload: any) {
  const intake = await assertProviderOwnsIntake(userId, intakeId);
  if (!isEditableByProvider(intake.status)) {
    deny('This intake can no longer be edited');
  }
  const nextPayload = providerPayloadFromBody(payload);
  const missing = missingIntakeFields(intake.kind, nextPayload);

  // Validate NPI when present — format/checksum only (no NPPES claim)
  const npi = String(nextPayload?.provider?.npi || nextPayload?.npi || '').trim();
  if (npi) {
    const npiCheck = validateNpi(npi);
    if (!npiCheck.ok) deny(`Invalid NPI: ${npiCheck.reason || 'failed validation'}`);
  }

  let nextStatus = intake.status;
  if (intake.status === IntakeStatus.INVITED) {
    assertTransition(intake.status, IntakeStatus.IN_PROGRESS, 'provider starts draft');
    nextStatus = IntakeStatus.IN_PROGRESS;
  } else if (intake.status === IntakeStatus.CHANGES_REQUESTED) {
    // Editing after change request stays CHANGES_REQUESTED until resubmit
    nextStatus = IntakeStatus.CHANGES_REQUESTED;
  }

  const row = await prisma.intakeRequest.update({
    where: { id: intakeId },
    data: {
      payload: nextPayload,
      missingFields: missing,
      lastSavedAt: new Date(),
      status: nextStatus
    }
  });
  await prisma.intakeEvent.create({
    data: { intakeId, action: 'PROVIDER_DRAFT_SAVED', actorId: userId, detail: { missingCount: missing.length } }
  });
  return sanitizeIntakeForProvider(row);
}

export async function submitProviderIntake(userId: string, intakeId: string) {
  const intake = await assertProviderOwnsIntake(userId, intakeId);
  if (!isSubmittableByProvider(intake.status)) {
    deny('This intake cannot be submitted in its current status');
  }
  const payload = intake.payload || {};
  const missing = missingIntakeFields(intake.kind, payload);
  if (missing.length) {
    const err: any = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.status = 400;
    err.missing = missing;
    throw err;
  }
  const npi = String((payload as any)?.provider?.npi || (payload as any)?.npi || '').trim();
  if (npi) {
    const npiCheck = validateNpi(npi);
    if (!npiCheck.ok) deny(`Invalid NPI: ${npiCheck.reason || 'failed validation'}`);
  }

  const identity = await resolveIdentityMatch(intake.tenantId, payload);
  const wasChanges = intake.status === IntakeStatus.CHANGES_REQUESTED;
  const status = wasChanges ? IntakeStatus.RESUBMITTED : IntakeStatus.SUBMITTED;
  assertTransition(intake.status, status, wasChanges ? 'provider resubmit' : 'provider submit');
  const snapshot = JSON.parse(JSON.stringify(payload));

  const row = await prisma.$transaction(async (tx) => {
    const version = (intake.currentSubmissionVersion || 0) + 1;
    await tx.intakeSubmission.create({
      data: {
        intakeRequestId: intakeId,
        version,
        payload: snapshot,
        submittedById: userId
      }
    });
    return tx.intakeRequest.update({
      where: { id: intakeId },
      data: {
        status,
        submittedPayload: snapshot,
        currentSubmissionVersion: version,
        submittedAt: new Date(),
        missingFields: [],
        identityMatch: identity.match,
        matchedProviderId: identity.matchedProviderId,
        lastSavedAt: new Date()
      }
    });
  });

  await prisma.intakeEvent.create({
    data: {
      intakeId,
      action: wasChanges ? 'PROVIDER_RESUBMITTED' : 'PROVIDER_SUBMITTED',
      actorId: userId,
      detail: {
        identityMatch: identity.match,
        matchedProviderId: identity.matchedProviderId,
        submissionVersion: row.currentSubmissionVersion
      }
    }
  });

  await notifyReviewers(row.tenantId, row.assignedToId, row.referenceNo, row.id, wasChanges ? 'resubmitted' : 'submitted');
  await sendProviderStatusEmail(userId, row.invitedEmail || '', row.referenceNo, wasChanges ? 'resubmitted' : 'submitted');

  return sanitizeIntakeForProvider(row);
}

async function resolveIdentityMatch(tenantId: string | null | undefined, payload: any) {
  const npi = String(payload?.provider?.npi || payload?.npi || '').trim();
  if (!npi) return { match: ProviderIdentityMatch.NONE as ProviderIdentityMatch, matchedProviderId: null as string | null };

  const byNpi = await prisma.provider.findUnique({
    where: { npi },
    include: { tenantLinks: { select: { tenantId: true } } }
  });
  if (!byNpi) return { match: ProviderIdentityMatch.NEW, matchedProviderId: null };

  const linkedToTenant = tenantId
    ? byNpi.tenantLinks.some((l) => l.tenantId === tenantId)
    : false;
  const linkedElsewhere = byNpi.tenantLinks.some((l) => l.tenantId !== tenantId);

  // Same NPI already owned by another tenant → ambiguous; do not auto-merge identities.
  if (linkedElsewhere && !linkedToTenant) {
    return { match: ProviderIdentityMatch.AMBIGUOUS, matchedProviderId: byNpi.id };
  }
  if (linkedToTenant) {
    return { match: ProviderIdentityMatch.MATCHED, matchedProviderId: byNpi.id };
  }
  // Global NPI exists but no TenantProvider yet — matched candidate requiring reviewer confirmation
  return { match: ProviderIdentityMatch.MATCHED, matchedProviderId: byNpi.id };
}

async function notifyReviewers(
  tenantId: string | null | undefined,
  assignedToId: string | null | undefined,
  referenceNo: string,
  intakeId: string,
  verb: string
) {
  if (assignedToId) {
    await notifyUser({
      userId: assignedToId,
      title: `Provider intake ${verb}`,
      body: `${referenceNo} was ${verb} by the provider`,
      type: 'intake',
      entityType: 'intake',
      entityId: intakeId,
      href: `/intake`
    });
  }
}

async function sendProviderStatusEmail(userId: string, email: string, referenceNo: string, event: string) {
  if (!email || !isEmailConfigured()) return;
  const subjects: Record<string, string> = {
    submitted: `Intake ${referenceNo} received`,
    resubmitted: `Intake ${referenceNo} resubmitted`,
    changes: `Changes requested on intake ${referenceNo}`,
    approved: `Intake ${referenceNo} approved`,
    rejected: `Intake ${referenceNo} rejected`
  };
  const bodies: Record<string, string> = {
    submitted: 'Your credentialing intake was submitted successfully and is awaiting review.',
    resubmitted: 'Your updated intake was resubmitted and is awaiting review.',
    changes: 'A reviewer requested changes. Sign in to the provider portal to update and resubmit.',
    approved: 'Your intake was approved. GPA will complete conversion into credentialing records.',
    rejected: 'Your intake was rejected. Contact the requesting organization for details.'
  };
  await sendEmail({
    to: email,
    subject: subjects[event] || `Intake ${referenceNo} update`,
    html: `<div style="font-family:Arial,sans-serif;color:#19324a"><p>${escapeHtml(bodies[event] || '')}</p><p><a href="${escapeHtml(appBaseUrl() + '/provider-portal')}">Open provider portal</a></p></div>`
  });
}

async function markSubmissionReview(
  intakeId: string,
  version: number,
  actorId: string,
  action: string,
  comments?: string | null
) {
  if (!version) return;
  await prisma.intakeSubmission.updateMany({
    where: { intakeRequestId: intakeId, version },
    data: {
      reviewAction: action,
      reviewComments: comments || null,
      reviewedAt: new Date(),
      reviewedById: actorId
    }
  });
}

export async function requestIntakeChanges(
  intakeId: string,
  actorId: string,
  comments: string,
  opts: { internalNotes?: string | null }
) {
  const before = await prisma.intakeRequest.findUnique({ where: { id: intakeId } });
  if (!before) deny('Intake request not found', 404);
  assertTransition(before.status, IntakeStatus.CHANGES_REQUESTED, 'request changes');
  const row = await prisma.intakeRequest.update({
    where: { id: intakeId },
    data: {
      status: IntakeStatus.CHANGES_REQUESTED,
      reviewerComments: comments,
      internalNotes: opts.internalNotes !== undefined ? opts.internalNotes : before.internalNotes,
      changesRequestedAt: new Date(),
      reviewedAt: new Date()
    }
  });
  await markSubmissionReview(
    intakeId,
    before.currentSubmissionVersion,
    actorId,
    'CHANGES_REQUESTED',
    comments
  );
  await prisma.intakeEvent.create({
    data: {
      intakeId,
      action: 'CHANGES_REQUESTED',
      actorId,
      detail: { comments, submissionVersion: before.currentSubmissionVersion }
    }
  });
  if (row.providerUserId) {
    await notifyUser({
      userId: row.providerUserId,
      title: 'Changes requested on your intake',
      body: `${row.referenceNo}: ${comments.slice(0, 200)}`,
      type: 'intake',
      entityType: 'intake',
      entityId: row.id,
      href: '/provider-portal/intakes/' + row.id
    });
    await sendProviderStatusEmail(row.providerUserId, row.invitedEmail || '', row.referenceNo, 'changes');
  }
  return row;
}

export async function approveIntake(intakeId: string, actorId: string, opts: { internalNotes?: string | null; reviewerComments?: string | null }) {
  const before = await prisma.intakeRequest.findUnique({ where: { id: intakeId } });
  if (!before) deny('Intake request not found', 404);
  assertTransition(before.status, IntakeStatus.APPROVED, 'approve');
  if (before.identityMatch === ProviderIdentityMatch.AMBIGUOUS) {
    deny('Resolve ambiguous provider identity before approval', 409, 'IDENTITY_AMBIGUOUS');
  }
  if (!before.currentSubmissionVersion || !before.submittedPayload) {
    deny('No submitted version available to approve');
  }
  const row = await prisma.intakeRequest.update({
    where: { id: intakeId },
    data: {
      status: IntakeStatus.APPROVED,
      approvedAt: new Date(),
      reviewedAt: new Date(),
      reviewerComments: opts.reviewerComments !== undefined ? opts.reviewerComments : before.reviewerComments,
      internalNotes: opts.internalNotes !== undefined ? opts.internalNotes : before.internalNotes
    }
  });
  await markSubmissionReview(
    intakeId,
    before.currentSubmissionVersion,
    actorId,
    'APPROVED',
    opts.reviewerComments
  );
  await prisma.intakeEvent.create({
    data: {
      intakeId,
      action: 'APPROVED',
      actorId,
      detail: { submissionVersion: before.currentSubmissionVersion }
    }
  });
  if (row.providerUserId) {
    await sendProviderStatusEmail(row.providerUserId, row.invitedEmail || '', row.referenceNo, 'approved');
  }
  return row;
}

export async function rejectIntake(
  intakeId: string,
  actorId: string,
  reason: string,
  opts: { internalNotes?: string | null }
) {
  if (!String(reason || '').trim()) deny('Rejection reason is required');
  const before = await prisma.intakeRequest.findUnique({ where: { id: intakeId } });
  if (!before) deny('Intake request not found', 404);
  assertTransition(before.status, IntakeStatus.REJECTED, 'reject');
  const row = await prisma.intakeRequest.update({
    where: { id: intakeId },
    data: {
      status: IntakeStatus.REJECTED,
      rejectedAt: new Date(),
      reviewedAt: new Date(),
      rejectionReason: reason,
      internalNotes: opts.internalNotes !== undefined ? opts.internalNotes : before.internalNotes
    }
  });
  await markSubmissionReview(intakeId, before.currentSubmissionVersion, actorId, 'REJECTED', reason);
  await prisma.intakeEvent.create({
    data: {
      intakeId,
      action: 'REJECTED',
      actorId,
      detail: { reason, submissionVersion: before.currentSubmissionVersion }
    }
  });
  if (row.providerUserId) {
    await sendProviderStatusEmail(row.providerUserId, row.invitedEmail || '', row.referenceNo, 'rejected');
  }
  return row;
}

export async function resolveAmbiguousIdentity(
  intakeId: string,
  actorId: string,
  decision: 'USE_EXISTING' | 'CREATE_NEW',
  matchedProviderId?: string | null
) {
  const before = await prisma.intakeRequest.findUnique({ where: { id: intakeId } });
  if (!before) deny('Intake request not found', 404);
  if (before.identityMatch !== ProviderIdentityMatch.AMBIGUOUS && before.identityMatch !== ProviderIdentityMatch.MATCHED) {
    deny('No identity resolution required');
  }
  if (decision === 'USE_EXISTING') {
    if (!matchedProviderId && !before.matchedProviderId) deny('matchedProviderId is required');
    const row = await prisma.intakeRequest.update({
      where: { id: intakeId },
      data: {
        identityMatch: ProviderIdentityMatch.MATCHED,
        matchedProviderId: matchedProviderId || before.matchedProviderId
      }
    });
    await prisma.intakeEvent.create({
      data: {
        intakeId,
        action: 'IDENTITY_RESOLVED',
        actorId,
        detail: { decision, matchedProviderId: row.matchedProviderId }
      }
    });
    return row;
  }
  const row = await prisma.intakeRequest.update({
    where: { id: intakeId },
    data: { identityMatch: ProviderIdentityMatch.NEW, matchedProviderId: null }
  });
  await prisma.intakeEvent.create({
    data: { intakeId, action: 'IDENTITY_RESOLVED', actorId, detail: { decision: 'CREATE_NEW' } }
  });
  return row;
}

export function canReviewIntake(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canApproveIntake(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

/** Create a document metadata row for provider intake upload (file attached separately). */
export async function createIntakeDocumentMeta(input: {
  tenantId: string;
  intakeRequestId: string;
  createdById: string;
  title: string;
  type: string;
  category?: string | null;
}) {
  return prisma.document.create({
    data: {
      title: input.title,
      type: input.type,
      category: input.category || 'intake',
      tenantId: input.tenantId,
      intakeRequestId: input.intakeRequestId,
      createdById: input.createdById,
      status: 'RECEIVED',
      securityStatus: DocumentSecurityStatus.QUARANTINED
    }
  });
}

/** @deprecated Prefer documentSecurity.releaseDocumentFromQuarantine with role + reason. */
export async function releaseDocumentFromQuarantine(
  documentId: string,
  actorId: string,
  options?: { role?: Role | string; reason?: string }
) {
  const { releaseDocumentFromQuarantine: release } = await import('./documentSecurity');
  return release({
    documentId,
    actorId,
    role: options?.role || Role.ADMIN,
    reason: options?.reason || 'Authorized manual review release — not malware-scanned'
  });
}
