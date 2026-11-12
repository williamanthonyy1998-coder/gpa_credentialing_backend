import {
  EnrollmentPacketStatus,
  EnrollmentStatus,
  EnrollmentSubmissionStatus,
  Priority,
  Role,
  TaskStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { assertTrustedEvidence, recordSubmission, TERMINAL, ENROLLMENT_FOLLOWUP_SOURCE } from './enrollmentLifecycle';
import { getLatestPacket } from './enrollmentPacket';

/**
 * Phase 4C — Submission preparation/confirmation, payer communications, typed follow-ups.
 * Manual portal submission = staff recorded an external send. Not platform→payer automation.
 */

export const SUBMISSION_CHANNELS = [
  'PAYER_PORTAL_MANUAL',
  'FAX',
  'MAIL',
  'EMAIL',
  'PHONE',
  'OTHER'
] as const;

export const COMMUNICATION_TYPES = [
  'SUBMISSION_CONFIRMATION',
  'RECEIPT_ACKNOWLEDGEMENT',
  'STATUS_INQUIRY',
  'ADDITIONAL_INFORMATION_REQUEST',
  'DOCUMENT_SENT',
  'APPROVAL_NOTIFICATION',
  'DENIAL_NOTIFICATION',
  'EFFECTIVE_DATE_CONFIRMATION',
  'TERMINATION_NOTICE',
  'OTHER'
] as const;

export const COMMUNICATION_CHANNELS = [
  'PHONE',
  'EMAIL',
  'FAX',
  'PAYER_PORTAL_MANUAL',
  'MAIL',
  'OTHER'
] as const;

export const FOLLOW_UP_TYPES = [
  'INITIAL_PAYER_CHECK',
  'RECEIPT_CONFIRMATION',
  'STATUS_CHECK',
  'ADDITIONAL_INFORMATION',
  'DOCUMENT_RESUBMISSION',
  'APPROVAL_CONFIRMATION',
  'EFFECTIVE_DATE_CONFIRMATION',
  'OTHER'
] as const;

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canPrepareSubmission(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canConfirmSubmission(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.APPROVER
  );
}

/** Exceptional packet-readiness override (INCOMPLETE / NOT_EVALUATED / BLOCKED). Not an ordinary confirm. */
export function canExceptionalPacketOverride(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER;
}

/** Minimum meaningful override documentation length. */
export const MIN_PACKET_OVERRIDE_REASON_LENGTH = 20;

export function canManageCommunications(role: Role) {
  return canPrepareSubmission(role);
}

function requireChannelExplanation(channel: string, explanation?: string | null) {
  if ((channel === 'PHONE' || channel === 'OTHER') && !String(explanation || '').trim()) {
    deny(`channelExplanation is required for channel ${channel}`);
  }
}

async function loadEnrollment(tenantId: string, enrollmentId: string) {
  const enrollment = await prisma.enrollmentApplication.findFirst({
    where: { id: enrollmentId, tenantId },
    include: { payerPlan: { include: { payer: true } } }
  });
  if (!enrollment) deny('Enrollment not found', 404);
  if (enrollment.providerId) await assertProviderInTenant(tenantId, enrollment.providerId);
  return enrollment;
}

function assertNotTerminal(status: EnrollmentStatus) {
  if (TERMINAL.includes(status)) {
    deny(`Cannot submit a terminal enrollment (${status})`, 409, 'TERMINAL_ENROLLMENT');
  }
}

function packetBlocksSubmission(status: EnrollmentPacketStatus) {
  return (
    status === EnrollmentPacketStatus.BLOCKED
    || status === EnrollmentPacketStatus.INCOMPLETE
    || status === EnrollmentPacketStatus.NOT_EVALUATED
  );
}

/**
 * Ordinary confirmation requires a ready packet.
 * Non-ready packets need an exceptional override (ADMIN / CREDENTIALING_MANAGER only)
 * with a meaningful reason — never a general bypass flag, never specialist ordinary override.
 * BLOCKED (conflicting requirements) is never an ordinary override.
 */
function resolvePacketOverrideGate(input: {
  packetStatus: EnrollmentPacketStatus;
  role: Role;
  overrideReason?: string | null;
}): { exceptionalOverride: boolean; overrideReason: string | null } {
  if (!packetBlocksSubmission(input.packetStatus)) {
    return { exceptionalOverride: false, overrideReason: null };
  }

  const reason = String(input.overrideReason || '').trim();
  if (!reason || reason.length < MIN_PACKET_OVERRIDE_REASON_LENGTH) {
    deny(
      `Latest packet status is ${input.packetStatus}; ordinary confirmation is blocked. `
        + `An exceptional override requires ADMIN or CREDENTIALING_MANAGER and a documented reason `
        + `(at least ${MIN_PACKET_OVERRIDE_REASON_LENGTH} characters).`,
      409,
      'PACKET_NOT_READY'
    );
  }

  if (!canExceptionalPacketOverride(input.role)) {
    deny(
      `Packet status ${input.packetStatus} cannot be bypassed by ordinary submission confirmation. `
        + 'Exceptional override is limited to ADMIN or CREDENTIALING_MANAGER.',
      403,
      'OVERRIDE_FORBIDDEN'
    );
  }

  return { exceptionalOverride: true, overrideReason: reason };
}

async function invalidateStalePreparedAttempt(draft: {
  id: string;
  attemptNumber: number;
  packetVersion: number | null;
  confirmationStatus: EnrollmentSubmissionStatus;
  notes?: string | null;
}, enrollmentId: string, actorId: string, latestVersion: number) {
  if (draft.confirmationStatus !== EnrollmentSubmissionStatus.PREPARED) return;
  const invalidationNote =
    `[INVALIDATED] Prepared against packet v${draft.packetVersion}; latest is v${latestVersion}. Re-prepare required.`;
  await prisma.enrollmentSubmission.update({
    where: { id: draft.id },
    data: {
      confirmationStatus: EnrollmentSubmissionStatus.CANCELLED,
      notes: [draft.notes || '', invalidationNote].filter(Boolean).join('\n')
    }
  });
  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId,
      authorId: actorId,
      body: `Submission attempt #${draft.attemptNumber} invalidated — packet version changed (prepared v${draft.packetVersion}, latest v${latestVersion}).`,
      activityType: 'SUBMISSION_PREPARATION_INVALIDATED',
      metadata: {
        submissionId: draft.id,
        preparedPacketVersion: draft.packetVersion,
        latestPacketVersion: latestVersion
      } as any
    }
  });
}

export async function listSubmissions(tenantId: string, enrollmentId: string) {
  await loadEnrollment(tenantId, enrollmentId);
  return prisma.enrollmentSubmission.findMany({
    where: { tenantId, enrollmentId },
    orderBy: { attemptNumber: 'desc' },
    include: {
      packet: { select: { id: true, version: true, status: true } },
      submittedBy: { select: { id: true, name: true, email: true } },
      confirmedBy: { select: { id: true, name: true, email: true } }
    }
  });
}

export async function prepareSubmission(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  channel: string;
  channelExplanation?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  evidenceDocumentId?: string | null;
  submittedAt?: Date | string | null;
}) {
  if (!canPrepareSubmission(input.role)) deny('Insufficient permissions to prepare submission', 403);
  if (!SUBMISSION_CHANNELS.includes(input.channel as any)) deny('Invalid submission channel');
  requireChannelExplanation(input.channel, input.channelExplanation);

  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  assertNotTerminal(enrollment.status);

  const packet = await getLatestPacket(input.tenantId, input.enrollmentId);
  if (!packet) deny('Evaluate an enrollment packet before preparing submission', 409, 'NO_PACKET');

  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Submission evidence');

  const last = await prisma.enrollmentSubmission.findFirst({
    where: { enrollmentId: enrollment.id },
    orderBy: { attemptNumber: 'desc' }
  });
  if (last?.confirmationStatus === EnrollmentSubmissionStatus.PREPARED) {
    // Update existing prepared attempt rather than duplicating
    const updated = await prisma.enrollmentSubmission.update({
      where: { id: last.id },
      data: {
        packetId: packet.id,
        packetVersion: packet.version,
        channel: input.channel,
        channelExplanation: input.channelExplanation || null,
        referenceNo: input.referenceNo || null,
        notes: input.notes || null,
        evidenceDocumentId: input.evidenceDocumentId || null,
        submittedAt: input.submittedAt ? new Date(input.submittedAt) : null,
        submittedById: input.actorId
      }
    });
    await prisma.enrollmentActivity.create({
      data: {
        enrollmentId: enrollment.id,
        authorId: input.actorId,
        body: `Submission attempt #${updated.attemptNumber} prepared (not confirmed). Channel: ${input.channel}`,
        activityType: 'SUBMISSION_PREPARED',
        metadata: { submissionId: updated.id, packetVersion: packet.version } as any
      }
    });
    return {
      submission: updated,
      enrollmentStatus: enrollment.status,
      note: 'Preparation does not mark the enrollment as SUBMITTED.'
    };
  }

  const attemptNumber = (last?.attemptNumber || 0) + 1;
  const created = await prisma.enrollmentSubmission.create({
    data: {
      enrollmentId: enrollment.id,
      tenantId: input.tenantId,
      attemptNumber,
      packetId: packet.id,
      packetVersion: packet.version,
      channel: input.channel,
      channelExplanation: input.channelExplanation || null,
      referenceNo: input.referenceNo || null,
      notes: input.notes || null,
      evidenceDocumentId: input.evidenceDocumentId || null,
      submittedAt: input.submittedAt ? new Date(input.submittedAt) : null,
      submittedById: input.actorId,
      confirmationStatus: EnrollmentSubmissionStatus.PREPARED,
      confirmedSent: false
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: `Submission attempt #${attemptNumber} prepared (not confirmed). Channel: ${input.channel}`,
      activityType: 'SUBMISSION_PREPARED',
      metadata: { submissionId: created.id, packetVersion: packet.version } as any
    }
  });

  return {
    submission: created,
    enrollmentStatus: enrollment.status,
    note: 'Preparation does not mark the enrollment as SUBMITTED and does not send to a payer.'
  };
}

export async function confirmSubmission(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  submissionId?: string | null;
  channel?: string | null;
  channelExplanation?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  evidenceDocumentId?: string | null;
  submittedAt?: Date | string | null;
  confirmedSent: boolean;
  overrideReason?: string | null;
  createInitialFollowUp?: boolean;
}) {
  if (!canConfirmSubmission(input.role)) deny('Insufficient permissions to confirm submission', 403);
  if (!input.confirmedSent) {
    deny('confirmedSent must be true — confirm the application was actually sent', 400, 'CONFIRMATION_REQUIRED');
  }

  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  assertNotTerminal(enrollment.status);

  const packet = await getLatestPacket(input.tenantId, input.enrollmentId);
  if (!packet) deny('Evaluate an enrollment packet before confirming submission', 409, 'NO_PACKET');

  const overrideGate = resolvePacketOverrideGate({
    packetStatus: packet.status,
    role: input.role,
    overrideReason: input.overrideReason
  });

  let draft = input.submissionId
    ? await prisma.enrollmentSubmission.findFirst({
        where: { id: input.submissionId, tenantId: input.tenantId, enrollmentId: enrollment.id }
      })
    : await prisma.enrollmentSubmission.findFirst({
        where: {
          tenantId: input.tenantId,
          enrollmentId: enrollment.id,
          confirmationStatus: EnrollmentSubmissionStatus.PREPARED
        },
        orderBy: { attemptNumber: 'desc' }
      });

  if (draft?.confirmationStatus === EnrollmentSubmissionStatus.CONFIRMED) {
    deny('Submission attempt already confirmed', 409, 'ALREADY_CONFIRMED');
  }
  if (draft?.confirmationStatus === EnrollmentSubmissionStatus.CANCELLED) {
    deny('Submission attempt was cancelled/invalidated; prepare a new attempt', 409, 'ATTEMPT_CANCELLED');
  }

  if (draft?.packetVersion != null && draft.packetVersion !== packet.version) {
    await invalidateStalePreparedAttempt(draft, enrollment.id, input.actorId, packet.version);
    deny(
      `Packet version changed (prepared against v${draft.packetVersion}, latest is v${packet.version}). Preparation invalidated — re-prepare against the newer packet before confirming.`,
      409,
      'PACKET_VERSION_CHANGED'
    );
  }

  // Guard accidental duplicate confirms: already have a CONFIRMED attempt for same packet version + channel window
  const alreadyConfirmedSamePacket = await prisma.enrollmentSubmission.findFirst({
    where: {
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      confirmationStatus: EnrollmentSubmissionStatus.CONFIRMED,
      packetId: packet.id,
      packetVersion: packet.version
    },
    orderBy: { attemptNumber: 'desc' }
  });
  if (alreadyConfirmedSamePacket && !draft) {
    deny(
      'A confirmed submission already exists for this packet version. Prepare a new attempt only when intentionally resubmitting.',
      409,
      'DUPLICATE_CONFIRM'
    );
  }

  const channel = input.channel || draft?.channel;
  if (!channel || !SUBMISSION_CHANNELS.includes(channel as any)) deny('Valid submission channel is required');
  const channelExplanation = input.channelExplanation ?? draft?.channelExplanation;
  requireChannelExplanation(channel, channelExplanation);

  const evidenceDocumentId = input.evidenceDocumentId ?? draft?.evidenceDocumentId ?? null;
  await assertTrustedEvidence(input.tenantId, evidenceDocumentId, 'Submission evidence');

  const submittedAt = input.submittedAt
    ? new Date(input.submittedAt)
    : (draft?.submittedAt || new Date());
  if (Number.isNaN(submittedAt.getTime())) deny('Invalid submittedAt');

  const referenceNo = input.referenceNo ?? draft?.referenceNo ?? null;
  const notes = input.notes ?? draft?.notes ?? null;
  const packetIdUsed = packet.id;
  const packetVersionUsed = packet.version;

  // Lifecycle transition to SUBMITTED (Phase 4A service — no PATCH bypass)
  await recordSubmission({
    tenantId: input.tenantId,
    enrollmentId: enrollment.id,
    actorId: input.actorId,
    role: input.role,
    submittedAt,
    referenceNo,
    evidenceDocumentId,
    notes: notes || `Confirmed manual submission via ${channel}`
  });

  let submission;
  if (draft) {
    submission = await prisma.enrollmentSubmission.update({
      where: { id: draft.id },
      data: {
        channel,
        channelExplanation: channelExplanation || null,
        packetId: packetIdUsed,
        packetVersion: packetVersionUsed,
        submittedAt,
        submittedById: draft.submittedById || input.actorId,
        confirmedById: input.actorId,
        confirmedAt: new Date(),
        referenceNo,
        evidenceDocumentId,
        notes,
        overrideReason: overrideGate.overrideReason,
        confirmationStatus: EnrollmentSubmissionStatus.CONFIRMED,
        confirmedSent: true
      }
    });
  } else {
    const last = await prisma.enrollmentSubmission.findFirst({
      where: { enrollmentId: enrollment.id },
      orderBy: { attemptNumber: 'desc' }
    });
    submission = await prisma.enrollmentSubmission.create({
      data: {
        enrollmentId: enrollment.id,
        tenantId: input.tenantId,
        attemptNumber: (last?.attemptNumber || 0) + 1,
        packetId: packetIdUsed,
        packetVersion: packetVersionUsed,
        channel,
        channelExplanation: channelExplanation || null,
        submittedAt,
        submittedById: input.actorId,
        confirmedById: input.actorId,
        confirmedAt: new Date(),
        referenceNo,
        evidenceDocumentId,
        notes,
        overrideReason: overrideGate.overrideReason,
        confirmationStatus: EnrollmentSubmissionStatus.CONFIRMED,
        confirmedSent: true
      }
    });
  }

  await prisma.enrollmentCommunication.create({
    data: {
      enrollmentId: enrollment.id,
      tenantId: input.tenantId,
      submissionId: submission.id,
      communicationType: 'SUBMISSION_CONFIRMATION',
      channel,
      channelExplanation: channelExplanation || null,
      occurredAt: submittedAt,
      referenceNo,
      summary: overrideGate.exceptionalOverride
        ? `Application submission confirmed via ${channel} (exceptional packet override)`
        : `Application submission confirmed via ${channel}`,
      notes,
      internalNotes: overrideGate.exceptionalOverride
        ? `Exceptional override by actor ${input.actorId}: ${overrideGate.overrideReason}`
        : null,
      createdById: input.actorId
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: overrideGate.exceptionalOverride
        ? `Submission attempt #${submission.attemptNumber} confirmed with exceptional packet override (${packet.status}). Channel: ${channel}. Manual record — not automated payer API.`
        : `Submission attempt #${submission.attemptNumber} confirmed. Channel: ${channel}. Manual record — not automated payer API.`,
      activityType: overrideGate.exceptionalOverride
        ? 'APPLICATION_SUBMITTED_WITH_OVERRIDE'
        : 'APPLICATION_SUBMITTED',
      metadata: {
        submissionId: submission.id,
        packetId: packetIdUsed,
        packetVersion: packetVersionUsed,
        packetStatus: packet.status,
        channel,
        referenceNo,
        exceptionalOverride: overrideGate.exceptionalOverride,
        overrideReason: overrideGate.overrideReason,
        overrideActorId: overrideGate.exceptionalOverride ? input.actorId : null
      } as any
    }
  });

  let followUp = null;
  if (input.createInitialFollowUp !== false) {
    followUp = await createTypedFollowUp({
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      actorId: input.actorId,
      role: input.role,
      followUpType: 'INITIAL_PAYER_CHECK',
      dueAt: new Date(Date.now() + 7 * 86400000),
      description: 'Initial payer check after submission',
      submissionId: submission.id,
      priority: Priority.NORMAL
    });
  }

  return {
    submission,
    followUp,
    note: 'Submission confirmed as a manual recorded event. No automated payer portal/API transmission occurred.'
  };
}

export async function listCommunications(tenantId: string, enrollmentId: string) {
  await loadEnrollment(tenantId, enrollmentId);
  return prisma.enrollmentCommunication.findMany({
    where: { tenantId, enrollmentId },
    orderBy: { occurredAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      submission: { select: { id: true, attemptNumber: true, channel: true } }
    }
  });
}

export async function createCommunication(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  communicationType: string;
  channel: string;
  channelExplanation?: string | null;
  occurredAt?: Date | string | null;
  contactName?: string | null;
  contactDepartment?: string | null;
  referenceNo?: string | null;
  summary: string;
  notes?: string | null;
  internalNotes?: string | null;
  submissionId?: string | null;
  evidenceDocumentId?: string | null;
}) {
  if (!canManageCommunications(input.role)) deny('Insufficient permissions', 403);
  if (!COMMUNICATION_TYPES.includes(input.communicationType as any)) deny('Invalid communicationType');
  if (!COMMUNICATION_CHANNELS.includes(input.channel as any)) deny('Invalid communication channel');
  requireChannelExplanation(input.channel, input.channelExplanation);
  if (!String(input.summary || '').trim()) deny('summary is required');

  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  if (input.submissionId) {
    const sub = await prisma.enrollmentSubmission.findFirst({
      where: { id: input.submissionId, tenantId: input.tenantId, enrollmentId: enrollment.id }
    });
    if (!sub) deny('Related submission not found for this enrollment', 404);
  }
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Communication evidence');

  const row = await prisma.enrollmentCommunication.create({
    data: {
      enrollmentId: enrollment.id,
      tenantId: input.tenantId,
      submissionId: input.submissionId || null,
      communicationType: input.communicationType,
      channel: input.channel,
      channelExplanation: input.channelExplanation || null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      contactName: input.contactName || null,
      contactDepartment: input.contactDepartment || null,
      referenceNo: input.referenceNo || null,
      summary: input.summary,
      notes: input.notes || null,
      internalNotes: input.internalNotes || null,
      evidenceDocumentId: input.evidenceDocumentId || null,
      createdById: input.actorId
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: `${input.communicationType}: ${input.summary}`,
      activityType: 'PAYER_COMMUNICATION',
      metadata: { communicationId: row.id, channel: input.channel } as any
    }
  });

  return row;
}

export async function createTypedFollowUp(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  followUpType: string;
  dueAt: Date | string;
  description: string;
  priority?: Priority;
  assignedToId?: string | null;
  submissionId?: string | null;
  communicationId?: string | null;
}) {
  if (
    input.role === Role.CLIENT_USER
    || input.role === Role.EXTERNAL_PROVIDER
    || input.role === Role.READ_ONLY
  ) {
    deny('Insufficient permissions', 403);
  }
  if (!FOLLOW_UP_TYPES.includes(input.followUpType as any)) deny('Invalid followUpType');
  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) deny('Valid dueAt is required');
  if (!String(input.description || '').trim()) deny('description is required');

  if (input.submissionId) {
    const sub = await prisma.enrollmentSubmission.findFirst({
      where: { id: input.submissionId, tenantId: input.tenantId, enrollmentId: enrollment.id }
    });
    if (!sub) deny('Related submission not found', 404);
  }

  const fingerprint = `enr-followup:${enrollment.id}:${input.followUpType}:${dueAt.toISOString().slice(0, 10)}`;
  const existing = await prisma.task.findFirst({
    where: { tenantId: input.tenantId, fingerprint, source: ENROLLMENT_FOLLOWUP_SOURCE }
  });
  const openish: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];
  if (existing && openish.includes(existing.status)) {
    await prisma.enrollmentApplication.update({
      where: { id: enrollment.id },
      data: { nextFollowUpAt: dueAt, lastFollowUpAt: new Date() }
    });
    return existing;
  }

  const data = {
    title: `${input.followUpType}: ${enrollment.applicationNo}`,
    description: input.description,
    status: TaskStatus.OPEN,
    priority: input.priority || Priority.NORMAL,
    dueAt,
    assignedToId: input.assignedToId || null,
    createdById: input.actorId,
    tenantId: input.tenantId,
    providerId: enrollment.providerId,
    enrollmentId: enrollment.id,
    organizationId: enrollment.organizationId,
    practiceId: enrollment.practiceId,
    facilityId: enrollment.facilityId,
    source: ENROLLMENT_FOLLOWUP_SOURCE,
    fingerprint,
    relatedType: 'enrollment',
    relatedId: enrollment.id,
    followUpType: input.followUpType,
    submissionId: input.submissionId || null,
    communicationId: input.communicationId || null,
    completedAt: null as Date | null,
    completionNotes: null as string | null
  };

  const task = existing
    ? await prisma.task.update({ where: { id: existing.id }, data })
    : await prisma.task.create({ data });

  await prisma.enrollmentApplication.update({
    where: { id: enrollment.id },
    data: { nextFollowUpAt: dueAt, lastFollowUpAt: new Date() }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: `Follow-up created: ${input.followUpType} due ${dueAt.toISOString()}`,
      activityType: 'FOLLOW_UP_CREATED',
      metadata: { taskId: task.id, followUpType: input.followUpType } as any
    }
  });

  return task;
}

export async function listFollowUps(tenantId: string, enrollmentId: string) {
  await loadEnrollment(tenantId, enrollmentId);
  return prisma.task.findMany({
    where: { tenantId, enrollmentId, source: ENROLLMENT_FOLLOWUP_SOURCE },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } }
    }
  });
}

export function isFollowUpOverdue(task: { status: TaskStatus; dueAt?: Date | null }, now = new Date()) {
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) return false;
  if (!task.dueAt) return false;
  return task.dueAt < now && (task.status === TaskStatus.OPEN || task.status === TaskStatus.IN_PROGRESS);
}

export async function completeFollowUp(input: {
  tenantId: string;
  enrollmentId: string;
  followUpId: string;
  actorId: string;
  role: Role;
  completionNotes?: string | null;
}) {
  if (!canPrepareSubmission(input.role)) deny('Insufficient permissions', 403);
  await loadEnrollment(input.tenantId, input.enrollmentId);
  const task = await prisma.task.findFirst({
    where: {
      id: input.followUpId,
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      source: ENROLLMENT_FOLLOWUP_SOURCE
    }
  });
  if (!task) deny('Follow-up not found', 404);
  if (task.status === TaskStatus.COMPLETED) return task;

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.COMPLETED,
      completedAt: new Date(),
      completionNotes: input.completionNotes || null
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: input.enrollmentId,
      authorId: input.actorId,
      body: `Follow-up completed: ${task.followUpType || task.title}`,
      activityType: 'FOLLOW_UP_COMPLETED',
      metadata: { taskId: task.id } as any
    }
  });

  return updated;
}

export async function cancelFollowUp(input: {
  tenantId: string;
  enrollmentId: string;
  followUpId: string;
  actorId: string;
  role: Role;
  reason?: string | null;
}) {
  if (!canPrepareSubmission(input.role)) deny('Insufficient permissions', 403);
  await loadEnrollment(input.tenantId, input.enrollmentId);
  const task = await prisma.task.findFirst({
    where: {
      id: input.followUpId,
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      source: ENROLLMENT_FOLLOWUP_SOURCE
    }
  });
  if (!task) deny('Follow-up not found', 404);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.CANCELLED,
      completedAt: new Date(),
      completionNotes: input.reason || 'Cancelled'
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: input.enrollmentId,
      authorId: input.actorId,
      body: `Follow-up cancelled: ${task.followUpType || task.title}`,
      activityType: 'FOLLOW_UP_CANCELLED',
      metadata: { taskId: task.id, reason: input.reason || null } as any
    }
  });

  return updated;
}

/** When enrollment becomes terminal, cancel open follow-ups with audit (no delete). */
export async function cancelOpenFollowUpsForTerminal(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  reason: string;
}) {
  const open = await prisma.task.findMany({
    where: {
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      source: ENROLLMENT_FOLLOWUP_SOURCE,
      status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] }
    }
  });
  for (const task of open) {
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.CANCELLED,
        completedAt: new Date(),
        completionNotes: input.reason
      }
    });
  }
  return { cancelled: open.length };
}

export async function getSubmissionDashboardExtras(tenantId: string) {
  const now = new Date();
  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endToday = new Date(startToday.getTime() + 86400000);
  const in7 = new Date(now.getTime() + 7 * 86400000);

  const followUpBase = {
    tenantId,
    source: ENROLLMENT_FOLLOWUP_SOURCE,
    status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] as TaskStatus[] }
  };

  const [overdueFollowUps, followUpsDueToday, followUpsDue7Days, awaitingSubmission] = await Promise.all([
    prisma.task.count({
      where: { ...followUpBase, dueAt: { lt: now } }
    }),
    prisma.task.count({
      where: { ...followUpBase, dueAt: { gte: startToday, lt: endToday } }
    }),
    prisma.task.count({
      where: { ...followUpBase, dueAt: { gte: now, lte: in7 } }
    }),
    prisma.enrollmentApplication.count({
      where: {
        tenantId,
        status: { in: [EnrollmentStatus.READY_TO_SUBMIT, EnrollmentStatus.PREPARING] }
      }
    })
  ]);

  return {
    overdueFollowUps,
    followUpsDueToday,
    followUpsDue7Days,
    awaitingSubmission
  };
}

export function sanitizeSubmissionForAudience(row: any, audience: 'gpa' | 'client' | 'provider') {
  if (!row) return row;
  const out = { ...row };
  if (audience !== 'gpa') {
    delete out.internalNotes;
    delete out.overrideReason;
  }
  return out;
}

export function sanitizeCommunicationForAudience(row: any, audience: 'gpa' | 'client' | 'provider') {
  if (!row) return row;
  const out = { ...row };
  if (audience !== 'gpa') delete out.internalNotes;
  return out;
}

export async function getEnrollmentTimeline(tenantId: string, enrollmentId: string) {
  await loadEnrollment(tenantId, enrollmentId);
  const [history, activities, submissions, communications, followUps] = await Promise.all([
    prisma.statusHistory.findMany({
      where: { enrollmentId },
      orderBy: { createdAt: 'asc' },
      take: 100
    }),
    prisma.enrollmentActivity.findMany({
      where: { enrollmentId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 100
    }),
    prisma.enrollmentSubmission.findMany({
      where: { tenantId, enrollmentId },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.enrollmentCommunication.findMany({
      where: { tenantId, enrollmentId },
      orderBy: { occurredAt: 'asc' }
    }),
    prisma.task.findMany({
      where: { tenantId, enrollmentId, source: ENROLLMENT_FOLLOWUP_SOURCE },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  const events: Array<{ at: string; type: string; summary: string; source: string; id: string }> = [];
  for (const h of history) {
    events.push({
      at: h.createdAt.toISOString(),
      type: h.eventType || 'STATUS_CHANGE',
      summary: `${h.fromStatus || '—'} → ${h.toStatus}${h.reason ? `: ${h.reason}` : ''}`,
      source: 'statusHistory',
      id: h.id
    });
  }
  for (const a of activities) {
    events.push({
      at: a.createdAt.toISOString(),
      type: a.activityType,
      summary: a.body,
      source: 'activity',
      id: a.id
    });
  }
  for (const s of submissions) {
    events.push({
      at: (s.confirmedAt || s.createdAt).toISOString(),
      type: s.confirmationStatus === 'CONFIRMED' ? 'SUBMISSION_CONFIRMED' : 'SUBMISSION_PREPARED',
      summary: `Attempt #${s.attemptNumber} ${s.confirmationStatus} via ${s.channel}`,
      source: 'submission',
      id: s.id
    });
  }
  for (const c of communications) {
    events.push({
      at: c.occurredAt.toISOString(),
      type: c.communicationType,
      summary: c.summary,
      source: 'communication',
      id: c.id
    });
  }
  for (const f of followUps) {
    events.push({
      at: f.createdAt.toISOString(),
      type: 'FOLLOW_UP',
      summary: `${f.followUpType || 'FOLLOW_UP'} ${f.status}${f.dueAt ? ` due ${f.dueAt.toISOString()}` : ''}`,
      source: 'followUp',
      id: f.id
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events };
}
