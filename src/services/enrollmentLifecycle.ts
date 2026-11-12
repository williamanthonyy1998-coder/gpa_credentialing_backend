import {
  DocumentSecurityStatus,
  EnrollmentStatus,
  Priority,
  Role,
  TaskStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { assertPayerPlanAssignable } from './directoryIntegration';
import { assertEnrollmentTransition, allowedEnrollmentTransitions } from './workflow';
import { isTrustedForConversion } from './documentSecurity';

/**
 * Phase 4A — Enrollment lifecycle foundation.
 * Reuses EnrollmentApplication + StatusHistory + Task.
 * Recording submission is not the same as actually submitting to a payer portal/API.
 * Credentialing readiness is NOT payer enrollment.
 */

export const ENROLLMENT_FOLLOWUP_SOURCE = 'ENROLLMENT_FOLLOWUP';

export type EnrollmentAttention =
  | 'INCOMPLETE'
  | 'PREPARATION_REQUIRED'
  | 'READY_TO_SUBMIT'
  | 'AWAITING_PAYER'
  | 'ADDITIONAL_INFORMATION_REQUIRED'
  | 'APPROVED_NOT_EFFECTIVE'
  | 'EFFECTIVE'
  | 'REJECTED'
  | 'TERMINATED'
  | 'WITHDRAWN'
  | 'CLOSED'
  | 'OVERDUE_FOLLOW_UP'
  | 'REVALIDATION_ATTENTION';

export type EnrollmentAudience = 'gpa' | 'client' | 'provider';

const TERMINAL: EnrollmentStatus[] = [
  EnrollmentStatus.DENIED,
  EnrollmentStatus.WITHDRAWN,
  EnrollmentStatus.TERMINATED,
  EnrollmentStatus.CLOSED
];

const ACTIVE_DUP_STATUSES: EnrollmentStatus[] = [
  EnrollmentStatus.NOT_STARTED,
  EnrollmentStatus.PREPARING,
  EnrollmentStatus.READY_TO_SUBMIT,
  EnrollmentStatus.SUBMITTED,
  EnrollmentStatus.ACKNOWLEDGED,
  EnrollmentStatus.PAYER_REVIEW,
  EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED,
  EnrollmentStatus.APPROVED,
  EnrollmentStatus.EFFECTIVE
];

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canWriteEnrollment(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canFinalizeEnrollment(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

export function canRecordSubmission(role: Role) {
  return canWriteEnrollment(role);
}

function startOfDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Computed attention — separate from stored workflow status.
 * Future effectiveAt is NOT currently effective.
 */
export function computeEnrollmentAttention(
  row: {
    status: EnrollmentStatus;
    effectiveAt?: Date | string | null;
    nextFollowUpAt?: Date | string | null;
    revalidationAt?: Date | string | null;
    facilityId?: string | null;
    payerPlanId?: string | null;
  },
  now = new Date()
): EnrollmentAttention {
  if (row.status === EnrollmentStatus.TERMINATED) return 'TERMINATED';
  if (row.status === EnrollmentStatus.CLOSED) return 'CLOSED';
  if (row.status === EnrollmentStatus.DENIED) return 'REJECTED';
  if (row.status === EnrollmentStatus.WITHDRAWN) return 'WITHDRAWN';

  if (row.status === EnrollmentStatus.EFFECTIVE) {
    if (row.effectiveAt && startOfDay(new Date(row.effectiveAt)) > startOfDay(now)) {
      return 'APPROVED_NOT_EFFECTIVE';
    }
    if (row.revalidationAt && startOfDay(new Date(row.revalidationAt)) <= startOfDay(now)) {
      return 'REVALIDATION_ATTENTION';
    }
    return 'EFFECTIVE';
  }

  if (row.status === EnrollmentStatus.APPROVED) {
    if (row.effectiveAt && startOfDay(new Date(row.effectiveAt)) <= startOfDay(now)) {
      return 'EFFECTIVE';
    }
    return 'APPROVED_NOT_EFFECTIVE';
  }

  if (
    row.nextFollowUpAt
    && new Date(row.nextFollowUpAt) < now
    && !TERMINAL.includes(row.status)
  ) {
    return 'OVERDUE_FOLLOW_UP';
  }

  if (row.status === EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED) {
    return 'ADDITIONAL_INFORMATION_REQUIRED';
  }
  if (
    row.status === EnrollmentStatus.SUBMITTED
    || row.status === EnrollmentStatus.ACKNOWLEDGED
    || row.status === EnrollmentStatus.PAYER_REVIEW
  ) {
    return 'AWAITING_PAYER';
  }
  if (row.status === EnrollmentStatus.READY_TO_SUBMIT) return 'READY_TO_SUBMIT';
  if (row.status === EnrollmentStatus.PREPARING) return 'PREPARATION_REQUIRED';
  if (!row.facilityId || !row.payerPlanId) return 'INCOMPLETE';
  return 'INCOMPLETE';
}

export function sanitizeEnrollmentForAudience(row: any, audience: EnrollmentAudience) {
  if (!row) return row;
  const out = { ...row };
  out.attention = computeEnrollmentAttention(row);
  if (audience !== 'gpa') {
    delete out.internalNotes;
    delete out.notes; // keep clientVisible only via activities if needed — notes may contain GPA content
  }
  return out;
}

async function assertTrustedEvidence(tenantId: string, documentId: string | null | undefined, label: string) {
  if (!documentId) return null;
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.tenantId !== tenantId) deny(`${label} document not found`, 404);
  if (doc.securityStatus === DocumentSecurityStatus.DELETED) deny(`${label} document was deleted`, 400);
  if (!isTrustedForConversion(doc.securityStatus)) {
    deny(
      `${label} document is not AVAILABLE. Quarantined/rejected files cannot be trusted evidence.`,
      409,
      'DOCUMENT_NOT_TRUSTED'
    );
  }
  return doc;
}

async function assertBillingEntityInTenant(
  tenantId: string,
  billingEntityId: string | null | undefined,
  organizationId?: string | null
) {
  if (!billingEntityId) return null;
  const be = await prisma.billingEntity.findFirst({
    where: { id: billingEntityId, tenantId },
    select: { id: true, organizationId: true, status: true }
  });
  if (!be) deny('Billing entity not found in tenant', 404);
  if (be.status !== 'ACTIVE') deny('Billing entity is not active', 400);
  if (organizationId && be.organizationId && be.organizationId !== organizationId) {
    deny('Billing entity does not belong to the enrollment organization', 400);
  }
  return be;
}

export async function assertNoDuplicateActiveEnrollment(input: {
  tenantId: string;
  providerId?: string | null;
  payerPlanId: string;
  facilityId?: string | null;
  excludeId?: string;
}) {
  if (!input.providerId || !input.facilityId) return;
  const existing = await prisma.enrollmentApplication.findFirst({
    where: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      payerPlanId: input.payerPlanId,
      facilityId: input.facilityId,
      status: { in: ACTIVE_DUP_STATUSES },
      ...(input.excludeId ? { id: { not: input.excludeId } } : {})
    },
    select: { id: true, applicationNo: true }
  });
  if (existing) {
    deny(
      `An active enrollment already exists for this provider/plan/facility (${existing.applicationNo})`,
      409,
      'DUPLICATE_ENROLLMENT'
    );
  }
}

async function writeHistory(input: {
  enrollmentId: string;
  fromStatus?: EnrollmentStatus | null;
  toStatus: EnrollmentStatus;
  actorId: string;
  actorRole: Role;
  eventType: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.statusHistory.create({
    data: {
      enrollmentId: input.enrollmentId,
      fromStatus: input.fromStatus || null,
      toStatus: input.toStatus,
      changedBy: input.actorId,
      actorRole: input.actorRole,
      eventType: input.eventType,
      reason: input.reason || null,
      metadata: (input.metadata || undefined) as any
    }
  });
  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: input.enrollmentId,
      authorId: input.actorId,
      body: input.reason || `${input.eventType}: ${input.fromStatus || '—'} → ${input.toStatus}`,
      activityType: 'STATUS_CHANGE',
      metadata: {
        eventType: input.eventType,
        fromStatus: input.fromStatus || null,
        toStatus: input.toStatus,
        actorRole: input.actorRole,
        ...(input.metadata || {})
      } as any
    }
  });
}

async function loadEnrollment(tenantId: string, enrollmentId: string) {
  const row = await prisma.enrollmentApplication.findFirst({
    where: { id: enrollmentId, tenantId },
    include: {
      provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
      organization: { select: { id: true, legalName: true, dba: true } },
      facility: { select: { id: true, name: true } },
      practice: { select: { id: true, name: true } },
      billingEntity: { select: { id: true, legalName: true, dba: true } },
      payerPlan: { include: { payer: true } },
      statusHistory: { orderBy: { createdAt: 'desc' }, take: 50 },
      approvalDetails: true
    }
  });
  if (!row) deny('Enrollment not found', 404);
  return row;
}

export async function transitionEnrollment(input: {
  tenantId: string;
  enrollmentId: string;
  toStatus: EnrollmentStatus;
  actorId: string;
  role: Role;
  eventType: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  patch?: Record<string, unknown>;
}) {
  if (!canWriteEnrollment(input.role)) {
    deny('Insufficient permissions', 403);
  }

  const before = await loadEnrollment(input.tenantId, input.enrollmentId);
  assertEnrollmentTransition(before.status, input.toStatus, input.role);

  const updated = await prisma.enrollmentApplication.update({
    where: { id: before.id },
    data: {
      status: input.toStatus,
      ...(input.patch || {})
    },
    include: {
      provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
      organization: { select: { id: true, legalName: true, dba: true } },
      facility: { select: { id: true, name: true } },
      practice: { select: { id: true, name: true } },
      billingEntity: { select: { id: true, legalName: true, dba: true } },
      payerPlan: { include: { payer: true } },
      statusHistory: { orderBy: { createdAt: 'desc' }, take: 50 },
      approvalDetails: true
    }
  });

  await writeHistory({
    enrollmentId: before.id,
    fromStatus: before.status,
    toStatus: input.toStatus,
    actorId: input.actorId,
    actorRole: input.role,
    eventType: input.eventType,
    reason: input.reason,
    metadata: input.metadata
  });

  return {
    ...updated,
    attention: computeEnrollmentAttention(updated),
    allowedTransitions: allowedEnrollmentTransitions(updated.status, input.role),
    disclaimer:
      'Internal enrollment status is not automatic payer submission or payer approval. No CAQH/PECOS/Availity integration is active in Phase 4A.'
  };
}

export async function startPreparation(tenantId: string, enrollmentId: string, actorId: string, role: Role) {
  return transitionEnrollment({
    tenantId,
    enrollmentId,
    toStatus: EnrollmentStatus.PREPARING,
    actorId,
    role,
    eventType: 'PREPARATION_STARTED',
    reason: 'Preparation started',
    patch: { preparedAt: new Date() }
  });
}

export async function markReadyForSubmission(
  tenantId: string,
  enrollmentId: string,
  actorId: string,
  role: Role
) {
  return transitionEnrollment({
    tenantId,
    enrollmentId,
    toStatus: EnrollmentStatus.READY_TO_SUBMIT,
    actorId,
    role,
    eventType: 'READY_FOR_SUBMISSION',
    reason: 'Internally prepared — not yet submitted to payer'
  });
}

export async function recordSubmission(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  submittedAt?: Date | string | null;
  referenceNo?: string | null;
  evidenceDocumentId?: string | null;
  notes?: string | null;
}) {
  if (!canRecordSubmission(input.role)) deny('Insufficient permissions', 403);
  const submittedAt = input.submittedAt ? new Date(input.submittedAt) : new Date();
  if (Number.isNaN(submittedAt.getTime())) deny('Invalid submittedAt');
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Submission evidence');

  return transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.SUBMITTED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'APPLICATION_SUBMITTED',
    reason: input.notes || 'Application submission recorded (manual record — not automated payer portal submit)',
    metadata: {
      referenceNo: input.referenceNo || null,
      evidenceDocumentId: input.evidenceDocumentId || null,
      note: 'Recording submission is not the same as transmitting to a payer API'
    },
    patch: {
      submittedAt,
      referenceNo: input.referenceNo ?? undefined,
      submissionEvidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
}

export async function recordAcknowledgment(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  acknowledgedAt?: Date | string | null;
  referenceNo?: string | null;
  evidenceDocumentId?: string | null;
  notes?: string | null;
}) {
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Acknowledgment evidence');
  const acknowledgedAt = input.acknowledgedAt ? new Date(input.acknowledgedAt) : new Date();
  return transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.ACKNOWLEDGED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'PAYER_ACKNOWLEDGED',
    reason: input.notes || 'Payer acknowledgment recorded',
    metadata: {
      referenceNo: input.referenceNo || null,
      evidenceDocumentId: input.evidenceDocumentId || null
    },
    patch: {
      acknowledgedAt,
      referenceNo: input.referenceNo ?? undefined,
      acknowledgmentEvidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
}

export async function startPayerReview(
  tenantId: string,
  enrollmentId: string,
  actorId: string,
  role: Role,
  notes?: string | null
) {
  return transitionEnrollment({
    tenantId,
    enrollmentId,
    toStatus: EnrollmentStatus.PAYER_REVIEW,
    actorId,
    role,
    eventType: 'REVIEW_STARTED',
    reason: notes || 'Payer review recorded'
  });
}

export async function requestAdditionalInformation(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  reason: string;
  nextFollowUpAt?: Date | string | null;
}) {
  if (!String(input.reason || '').trim()) deny('Additional information request requires a documented reason');
  return transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'ADDITIONAL_INFORMATION_REQUESTED',
    reason: input.reason,
    patch: {
      nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : undefined,
      lastFollowUpAt: new Date()
    }
  });
}

export async function recordApproval(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  decisionAt?: Date | string | null;
  referenceNo?: string | null;
  evidenceDocumentId?: string | null;
  notes?: string | null;
  payerEnrollmentId?: string | null;
}) {
  if (!canFinalizeEnrollment(input.role)) deny('Only authorized approvers can record payer approval', 403);
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Approval evidence');
  const decisionAt = input.decisionAt ? new Date(input.decisionAt) : new Date();

  const result = await transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.APPROVED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'APPLICATION_APPROVED',
    reason: input.notes || 'Payer approval decision recorded',
    metadata: {
      evidenceDocumentId: input.evidenceDocumentId || null,
      payerEnrollmentId: input.payerEnrollmentId || null,
      note: 'Manual recorded decision — not automated payer API confirmation'
    },
    patch: {
      decisionAt,
      referenceNo: input.referenceNo ?? undefined,
      decisionEvidenceDocumentId: input.evidenceDocumentId || undefined,
      decisionReason: input.notes || 'Approved'
    }
  });

  await prisma.enrollmentApprovalDetails.upsert({
    where: { enrollmentId: input.enrollmentId },
    create: {
      enrollmentId: input.enrollmentId,
      payerEnrollmentId: input.payerEnrollmentId || null,
      notes: input.notes || null,
      createdById: input.actorId,
      updatedById: input.actorId
    },
    update: {
      payerEnrollmentId: input.payerEnrollmentId || undefined,
      notes: input.notes || undefined,
      updatedById: input.actorId
    }
  });

  return result;
}

export async function recordEffective(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  effectiveAt: Date | string;
  evidenceDocumentId?: string | null;
  notes?: string | null;
  revalidationAt?: Date | string | null;
}) {
  if (!canFinalizeEnrollment(input.role)) deny('Only authorized approvers can record effective participation', 403);
  const effectiveAt = new Date(input.effectiveAt);
  if (Number.isNaN(effectiveAt.getTime())) deny('Valid effectiveAt is required');
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Effective-date evidence');

  const before = await loadEnrollment(input.tenantId, input.enrollmentId);
  if (
    before.status !== EnrollmentStatus.APPROVED
    && before.status !== EnrollmentStatus.EFFECTIVE
  ) {
    deny('Enrollment must be APPROVED before marking EFFECTIVE', 409, 'NOT_APPROVED');
  }

  const result = await transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.EFFECTIVE,
    actorId: input.actorId,
    role: input.role,
    eventType: 'ENROLLMENT_EFFECTIVE',
    reason: input.notes || 'Effective participation recorded',
    metadata: { evidenceDocumentId: input.evidenceDocumentId || null },
    patch: {
      effectiveAt,
      revalidationAt: input.revalidationAt ? new Date(input.revalidationAt) : undefined,
      decisionEvidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });

  await prisma.enrollmentApprovalDetails.upsert({
    where: { enrollmentId: input.enrollmentId },
    create: {
      enrollmentId: input.enrollmentId,
      effectiveAt,
      revalidationAt: input.revalidationAt ? new Date(input.revalidationAt) : null,
      notes: input.notes || null,
      createdById: input.actorId,
      updatedById: input.actorId
    },
    update: {
      effectiveAt,
      revalidationAt: input.revalidationAt ? new Date(input.revalidationAt) : undefined,
      notes: input.notes || undefined,
      updatedById: input.actorId
    }
  });

  return result;
}

export async function recordRejection(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  reason: string;
  evidenceDocumentId?: string | null;
  decisionAt?: Date | string | null;
}) {
  if (!canFinalizeEnrollment(input.role)) deny('Only authorized approvers can record rejection', 403);
  if (!String(input.reason || '').trim()) deny('Rejection reason is required');
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Rejection evidence');
  const result = await transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.DENIED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'APPLICATION_REJECTED',
    reason: input.reason,
    metadata: { evidenceDocumentId: input.evidenceDocumentId || null },
    patch: {
      decisionAt: input.decisionAt ? new Date(input.decisionAt) : new Date(),
      decisionReason: input.reason,
      decisionEvidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
  // Phase 4C: cancel open follow-ups on terminal denial (preserve history; no delete)
  await prisma.task.updateMany({
    where: {
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      source: ENROLLMENT_FOLLOWUP_SOURCE,
      status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] }
    },
    data: {
      status: TaskStatus.CANCELLED,
      completedAt: new Date(),
      completionNotes: `Cancelled because enrollment denied: ${input.reason}`
    }
  });
  return result;
}

export async function recordTermination(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  reason: string;
  terminatedAt?: Date | string | null;
  evidenceDocumentId?: string | null;
}) {
  if (!canFinalizeEnrollment(input.role)) deny('Only authorized roles can terminate enrollment', 403);
  if (!String(input.reason || '').trim()) deny('Termination reason is required');
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Termination evidence');
  const terminatedAt = input.terminatedAt ? new Date(input.terminatedAt) : new Date();
  const result = await transitionEnrollment({
    tenantId: input.tenantId,
    enrollmentId: input.enrollmentId,
    toStatus: EnrollmentStatus.TERMINATED,
    actorId: input.actorId,
    role: input.role,
    eventType: 'ENROLLMENT_TERMINATED',
    reason: input.reason,
    metadata: { evidenceDocumentId: input.evidenceDocumentId || null },
    patch: {
      terminatedAt,
      terminationReason: input.reason
    }
  });
  await prisma.task.updateMany({
    where: {
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      source: ENROLLMENT_FOLLOWUP_SOURCE,
      status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] }
    },
    data: {
      status: TaskStatus.CANCELLED,
      completedAt: new Date(),
      completionNotes: `Cancelled because enrollment terminated: ${input.reason}`
    }
  });
  return result;
}

export async function createEnrollmentFollowUp(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  dueAt: Date | string;
  reason: string;
  priority?: Priority;
  assignedToId?: string | null;
}) {
  if (
    input.role === Role.CLIENT_USER
    || input.role === Role.EXTERNAL_PROVIDER
    || input.role === Role.READ_ONLY
  ) {
    deny('Insufficient permissions', 403);
  }
  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) deny('Valid dueAt is required');
  if (!String(input.reason || '').trim()) deny('Follow-up reason is required');

  const fingerprint = `enr-followup:${enrollment.id}:${dueAt.toISOString().slice(0, 10)}:${String(input.reason).trim().slice(0, 80)}`;

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

  const task = existing
    ? await prisma.task.update({
        where: { id: existing.id },
        data: {
          status: TaskStatus.OPEN,
          title: `Enrollment follow-up: ${enrollment.applicationNo}`,
          description: input.reason,
          dueAt,
          priority: input.priority || Priority.NORMAL,
          assignedToId: input.assignedToId || null,
          providerId: enrollment.providerId,
          enrollmentId: enrollment.id,
          organizationId: enrollment.organizationId,
          practiceId: enrollment.practiceId,
          facilityId: enrollment.facilityId
        }
      })
    : await prisma.task.create({
        data: {
          title: `Enrollment follow-up: ${enrollment.applicationNo}`,
          description: input.reason,
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
          relatedId: enrollment.id
        }
      });

  await prisma.enrollmentApplication.update({
    where: { id: enrollment.id },
    data: { nextFollowUpAt: dueAt, lastFollowUpAt: new Date() }
  });

  await writeHistory({
    enrollmentId: enrollment.id,
    fromStatus: enrollment.status,
    toStatus: enrollment.status,
    actorId: input.actorId,
    actorRole: input.role,
    eventType: 'FOLLOW_UP_RECORDED',
    reason: input.reason,
    metadata: { taskId: task.id, dueAt: dueAt.toISOString() }
  });

  return task;
}

export async function getEnrollmentDashboardCounts(tenantId: string, baseWhere: any = {}) {
  const now = new Date();
  const andBase = baseWhere?.AND ? baseWhere.AND : baseWhere && Object.keys(baseWhere).length ? [baseWhere] : [];

  const count = (extra: any) =>
    prisma.enrollmentApplication.count({ where: { AND: [...andBase, { tenantId }, extra] } });

  const [
    total,
    draft,
    preparing,
    ready,
    submitted,
    acknowledged,
    payerReview,
    addlInfo,
    approved,
    effective,
    denied,
    terminated,
    withdrawn,
    overdue,
    upcoming
  ] = await Promise.all([
    count({}),
    count({ status: EnrollmentStatus.NOT_STARTED }),
    count({ status: EnrollmentStatus.PREPARING }),
    count({ status: EnrollmentStatus.READY_TO_SUBMIT }),
    count({ status: EnrollmentStatus.SUBMITTED }),
    count({ status: EnrollmentStatus.ACKNOWLEDGED }),
    count({ status: EnrollmentStatus.PAYER_REVIEW }),
    count({ status: EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED }),
    count({ status: EnrollmentStatus.APPROVED }),
    count({ status: EnrollmentStatus.EFFECTIVE }),
    count({ status: EnrollmentStatus.DENIED }),
    count({ status: EnrollmentStatus.TERMINATED }),
    count({ status: EnrollmentStatus.WITHDRAWN }),
    count({
      nextFollowUpAt: { lt: now },
      status: { notIn: TERMINAL }
    }),
    count({
      nextFollowUpAt: { gte: now, lte: new Date(now.getTime() + 14 * 86400000) },
      status: { notIn: TERMINAL }
    })
  ]);

  // Approved but not yet effective (attention)
  const approvedNotEffective = await prisma.enrollmentApplication.count({
    where: {
      AND: [
        ...andBase,
        { tenantId },
        {
          OR: [
            { status: EnrollmentStatus.APPROVED },
            {
              status: EnrollmentStatus.EFFECTIVE,
              effectiveAt: { gt: now }
            }
          ]
        }
      ]
    }
  });

  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endToday = new Date(startToday.getTime() + 86400000);
  const in7 = new Date(now.getTime() + 7 * 86400000);
  const followBase = {
    tenantId,
    source: ENROLLMENT_FOLLOWUP_SOURCE,
    status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] as TaskStatus[] }
  };
  const [taskOverdue, followUpsDueToday, followUpsDue7Days] = await Promise.all([
    prisma.task.count({ where: { ...followBase, dueAt: { lt: now } } }),
    prisma.task.count({ where: { ...followBase, dueAt: { gte: startToday, lt: endToday } } }),
    prisma.task.count({ where: { ...followBase, dueAt: { gte: now, lte: in7 } } })
  ]);

  return {
    tenantId,
    generatedAt: now.toISOString(),
    counts: {
      total,
      draft,
      preparing,
      readyForSubmission: ready,
      awaitingSubmission: preparing + ready,
      submitted,
      awaitingAcknowledgment: submitted,
      acknowledged,
      underPayerReview: payerReview,
      additionalInformationRequested: addlInfo,
      approvedNotEffective,
      effective,
      rejected: denied,
      terminated,
      withdrawn,
      overdueFollowUps: Math.max(overdue, taskOverdue),
      upcomingFollowUps: upcoming,
      followUpsDueToday,
      followUpsDue7Days
    },
    disclaimer:
      'Enrollment KPIs are operational. Credentialing readiness is separate. Manual submission tracking is not automated payer integration. No CAQH/PECOS/Availity automation is active.'
  };
}

export async function validateEnrollmentRelationships(input: {
  tenantId: string;
  providerId?: string | null;
  organizationId?: string | null;
  practiceId?: string | null;
  facilityId?: string | null;
  billingEntityId?: string | null;
  payerPlanId: string;
  payerId?: string | null;
}) {
  await assertPayerPlanAssignable(input.payerPlanId, { requireActive: true });
  if (input.payerId) {
    const plan = await prisma.payerPlan.findUnique({
      where: { id: input.payerPlanId },
      select: { payerId: true }
    });
    if (!plan || plan.payerId !== input.payerId) {
      deny('Selected payer plan does not belong to the selected payer');
    }
  }
  if (input.providerId) await assertProviderInTenant(input.tenantId, input.providerId);
  if (input.organizationId) {
    const org = await prisma.organization.findFirst({
      where: { id: input.organizationId, tenantId: input.tenantId },
      select: { id: true }
    });
    if (!org) deny('Organization not found in tenant', 404);
  }
  if (input.practiceId) {
    const practice = await prisma.practice.findFirst({
      where: { id: input.practiceId, organization: { tenantId: input.tenantId } },
      select: { id: true, organizationId: true }
    });
    if (!practice) deny('Practice not found in tenant', 404);
  }
  if (input.facilityId) {
    const facility = await prisma.facility.findFirst({
      where: {
        id: input.facilityId,
        OR: [
          { organization: { tenantId: input.tenantId } },
          { practice: { organization: { tenantId: input.tenantId } } }
        ]
      },
      select: { id: true }
    });
    if (!facility) deny('Facility not found in tenant', 404);
  }
  await assertBillingEntityInTenant(input.tenantId, input.billingEntityId, input.organizationId);
}

// re-export helpers used by routes
export { assertBillingEntityInTenant, assertTrustedEvidence, TERMINAL, ACTIVE_DUP_STATUSES };
