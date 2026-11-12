import {
  EnrollmentRevalidationStatus,
  EnrollmentStatus,
  RevalidationDueDateSource,
  Role,
  TaskStatus,
  Priority
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { assertTrustedEvidence, TERMINAL } from './enrollmentLifecycle';

/**
 * Phase 4E — Payer enrollment revalidation lifecycle.
 * Separate from credential/license expiration (Phase 3B).
 * Creating/completing a revalidation does NOT auto-change enrollment EFFECTIVE/APPROVED status.
 */

export const REVALIDATION_TYPES = [
  'MEDICARE_REVALIDATION',
  'MEDICAID_REVALIDATION',
  'COMMERCIAL_REVALIDATION',
  'GROUP_REVALIDATION',
  'FACILITY_REVALIDATION',
  'OTHER'
] as const;

export const ACTIVE_REVALIDATION: EnrollmentRevalidationStatus[] = [
  EnrollmentRevalidationStatus.NOT_STARTED,
  EnrollmentRevalidationStatus.UPCOMING,
  EnrollmentRevalidationStatus.PREPARING,
  EnrollmentRevalidationStatus.READY_FOR_INTERNAL_REVIEW,
  EnrollmentRevalidationStatus.SUBMITTED,
  EnrollmentRevalidationStatus.ACKNOWLEDGED,
  EnrollmentRevalidationStatus.ADDITIONAL_INFORMATION_REQUIRED,
  EnrollmentRevalidationStatus.APPROVED,
  EnrollmentRevalidationStatus.OVERDUE
];

export const TERMINAL_REVALIDATION: EnrollmentRevalidationStatus[] = [
  EnrollmentRevalidationStatus.COMPLETED,
  EnrollmentRevalidationStatus.DENIED,
  EnrollmentRevalidationStatus.CANCELLED
];

const TRANSITIONS: Record<EnrollmentRevalidationStatus, EnrollmentRevalidationStatus[]> = {
  NOT_STARTED: ['UPCOMING', 'PREPARING', 'OVERDUE', 'CANCELLED'],
  UPCOMING: ['PREPARING', 'OVERDUE', 'CANCELLED'],
  PREPARING: ['READY_FOR_INTERNAL_REVIEW', 'OVERDUE', 'CANCELLED'],
  READY_FOR_INTERNAL_REVIEW: ['SUBMITTED', 'PREPARING', 'OVERDUE', 'CANCELLED'],
  SUBMITTED: ['ACKNOWLEDGED', 'ADDITIONAL_INFORMATION_REQUIRED', 'DENIED', 'CANCELLED'],
  ACKNOWLEDGED: ['ADDITIONAL_INFORMATION_REQUIRED', 'APPROVED', 'DENIED', 'CANCELLED'],
  ADDITIONAL_INFORMATION_REQUIRED: ['SUBMITTED', 'PREPARING', 'DENIED', 'CANCELLED'],
  APPROVED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  DENIED: [],
  OVERDUE: ['PREPARING', 'READY_FOR_INTERNAL_REVIEW', 'CANCELLED'],
  CANCELLED: []
};

const REVALIDATION_FOLLOWUP_SOURCE = 'ENROLLMENT_REVALIDATION_FOLLOWUP';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canManageRevalidation(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canFinalizeRevalidation(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function daysRemaining(dueDate: Date | string | null | undefined, now = new Date()) {
  if (!dueDate) return null;
  const due = startOfUtcDay(new Date(dueDate));
  const today = startOfUtcDay(now);
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

export function sanitizeRevalidationForAudience(row: any, audience: 'gpa' | 'client' | 'provider') {
  if (!row) return row;
  const out = { ...row, daysRemaining: daysRemaining(row.dueDate) };
  if (audience !== 'gpa') {
    delete out.internalNotes;
    delete out.denialReason;
    delete out.cancellationReason;
  }
  return out;
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

async function loadRevalidation(tenantId: string, id: string) {
  const row = await prisma.enrollmentRevalidation.findFirst({
    where: { id, tenantId },
    include: {
      enrollment: { select: { id: true, applicationNo: true, status: true, subject: true } },
      provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
      payer: { select: { id: true, name: true } },
      payerPlan: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } }
    }
  });
  if (!row) deny('Revalidation not found', 404);
  return row;
}

async function transition(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  toStatus: EnrollmentRevalidationStatus;
  reason?: string | null;
  eventType?: string;
  patch?: Record<string, unknown>;
  requireFinalizeRole?: boolean;
}) {
  if (!canManageRevalidation(input.role)) {
    deny('Insufficient permissions — clients and external providers cannot drive revalidation lifecycle', 403);
  }
  if (input.requireFinalizeRole && !canFinalizeRevalidation(input.role)) {
    deny('Only authorized GPA roles may finalize revalidation', 403);
  }

  const before = await loadRevalidation(input.tenantId, input.revalidationId);
  const allowed = TRANSITIONS[before.status] || [];
  if (!allowed.includes(input.toStatus)) {
    deny(
      `Invalid revalidation transition ${before.status} → ${input.toStatus}`,
      409,
      'INVALID_REVALIDATION_TRANSITION'
    );
  }

  const updated = await prisma.enrollmentRevalidation.update({
    where: { id: before.id },
    data: {
      status: input.toStatus,
      ...(input.patch || {})
    }
  });

  await prisma.enrollmentRevalidationEvent.create({
    data: {
      revalidationId: before.id,
      fromStatus: before.status,
      toStatus: input.toStatus,
      actorId: input.actorId,
      reason: input.reason || null,
      eventType: input.eventType || 'STATUS_CHANGE',
      metadata: { patchKeys: Object.keys(input.patch || {}) } as any
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: before.enrollmentId,
      authorId: input.actorId,
      body: `Revalidation ${before.revalidationType}: ${before.status} → ${input.toStatus}`,
      activityType: 'REVALIDATION_STATUS',
      metadata: { revalidationId: before.id, toStatus: input.toStatus } as any
    }
  });

  // Do NOT mutate enrollment application status here.
  return updated;
}

export async function listEnrollmentRevalidations(tenantId: string, enrollmentId: string) {
  await loadEnrollment(tenantId, enrollmentId);
  return prisma.enrollmentRevalidation.findMany({
    where: { tenantId, enrollmentId },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } }
    }
  });
}

export async function createRevalidation(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  revalidationType: string;
  dueDate?: Date | string | null;
  dueDateSource?: RevalidationDueDateSource;
  referenceNumber?: string | null;
  source?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  assignedToId?: string | null;
  notificationDate?: Date | string | null;
}) {
  if (!canManageRevalidation(input.role)) deny('Insufficient permissions', 403);
  if (!REVALIDATION_TYPES.includes(input.revalidationType as any)) deny('Invalid revalidationType');

  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);

  const dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) deny('Invalid dueDate');
  if (dueDate && !input.dueDateSource && !input.source) {
    // Require an explicit source when inventing is forbidden — MANUAL is allowed if documented
  }
  const dueDateSource = input.dueDateSource || RevalidationDueDateSource.MANUAL;
  if (dueDate && dueDateSource === RevalidationDueDateSource.CONFIRMED && !String(input.sourceReference || input.source || '').trim()) {
    deny('Confirmed due dates require source or sourceReference', 400, 'DUE_DATE_SOURCE_REQUIRED');
  }

  const dup = await prisma.enrollmentRevalidation.findFirst({
    where: {
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      revalidationType: input.revalidationType,
      status: { in: ACTIVE_REVALIDATION }
    }
  });
  if (dup) {
    deny(
      `An active ${input.revalidationType} revalidation already exists for this enrollment`,
      409,
      'DUPLICATE_ACTIVE_REVALIDATION'
    );
  }

  const initialStatus =
    dueDate && daysRemaining(dueDate)! < 0
      ? EnrollmentRevalidationStatus.OVERDUE
      : dueDate && (daysRemaining(dueDate) ?? 999) <= 120
        ? EnrollmentRevalidationStatus.UPCOMING
        : EnrollmentRevalidationStatus.NOT_STARTED;

  const row = await prisma.enrollmentRevalidation.create({
    data: {
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      providerId: enrollment.providerId,
      payerId: enrollment.payerPlan?.payerId || null,
      payerPlanId: enrollment.payerPlanId,
      revalidationType: input.revalidationType,
      referenceNumber: input.referenceNumber || null,
      dueDate,
      dueDateSource,
      notificationDate: input.notificationDate ? new Date(input.notificationDate) : null,
      status: initialStatus,
      assignedToId: input.assignedToId || null,
      source: input.source || null,
      sourceReference: input.sourceReference || null,
      notes: input.notes || null,
      createdById: input.actorId,
      initiatedAt: null
    }
  });

  await prisma.enrollmentRevalidationEvent.create({
    data: {
      revalidationId: row.id,
      fromStatus: null,
      toStatus: row.status,
      actorId: input.actorId,
      eventType: 'CREATED',
      reason: 'Revalidation record created (does not change enrollment lifecycle status)'
    }
  });

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: `Revalidation created: ${input.revalidationType}${dueDate ? ` due ${dueDate.toISOString().slice(0, 10)}` : ''}`,
      activityType: 'REVALIDATION_CREATED',
      metadata: {
        revalidationId: row.id,
        enrollmentStatusUnchanged: enrollment.status,
        dueDateSource
      } as any
    }
  });

  // Optionally mirror due date onto enrollment.revalidationAt for legacy attention — without inventing
  if (dueDate && dueDateSource === RevalidationDueDateSource.CONFIRMED) {
    await prisma.enrollmentApplication.update({
      where: { id: enrollment.id },
      data: { revalidationAt: dueDate }
    });
  }

  return row;
}

export async function getRevalidation(tenantId: string, id: string) {
  return loadRevalidation(tenantId, id);
}

export async function getRevalidationHistory(tenantId: string, id: string) {
  await loadRevalidation(tenantId, id);
  return prisma.enrollmentRevalidationEvent.findMany({
    where: { revalidationId: id },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, name: true, email: true } } }
  });
}

export async function prepareRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  notes?: string | null;
}) {
  const before = await loadRevalidation(input.tenantId, input.revalidationId);
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.PREPARING,
    reason: input.notes || 'Preparation started',
    eventType: 'PREPARE',
    patch: { initiatedAt: before.initiatedAt || new Date(), notes: input.notes ?? before.notes }
  });
}

export async function markReadyForInternalReview(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  notes?: string | null;
}) {
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.READY_FOR_INTERNAL_REVIEW,
    reason: input.notes || 'Ready for internal review',
    eventType: 'READY_FOR_REVIEW'
  });
}

export async function submitRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  submittedAt?: Date | string | null;
  referenceNumber?: string | null;
  evidenceDocumentId?: string | null;
  confirmedSent: boolean;
  notes?: string | null;
}) {
  if (!input.confirmedSent) {
    deny('confirmedSent must be true — confirm the revalidation was actually submitted', 400, 'CONFIRMATION_REQUIRED');
  }
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Revalidation submission evidence');
  const submittedAt = input.submittedAt ? new Date(input.submittedAt) : new Date();
  if (Number.isNaN(submittedAt.getTime())) deny('Invalid submittedAt');

  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.SUBMITTED,
    reason: input.notes || 'Revalidation submission recorded (manual — not automated payer API)',
    eventType: 'SUBMITTED',
    patch: {
      submittedAt,
      submissionConfirmed: true,
      referenceNumber: input.referenceNumber || undefined,
      evidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
}

export async function acknowledgeRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  acknowledgedAt?: Date | string | null;
  notes?: string | null;
}) {
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.ACKNOWLEDGED,
    reason: input.notes || 'Payer acknowledgment recorded',
    eventType: 'ACKNOWLEDGED',
    patch: { acknowledgedAt: input.acknowledgedAt ? new Date(input.acknowledgedAt) : new Date() }
  });
}

export async function requestRevalidationInformation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  reason: string;
}) {
  if (!String(input.reason || '').trim()) deny('Reason is required for additional information request');
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.ADDITIONAL_INFORMATION_REQUIRED,
    reason: input.reason,
    eventType: 'AI_REQUESTED'
  });
}

export async function approveRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  effectiveDate?: Date | string | null;
  notes?: string | null;
  evidenceDocumentId?: string | null;
}) {
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Revalidation approval evidence');
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.APPROVED,
    reason: input.notes || 'Revalidation approved (does not auto-mark enrollment EFFECTIVE)',
    eventType: 'APPROVED',
    requireFinalizeRole: true,
    patch: {
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : undefined,
      evidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
}

export async function completeRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  evidenceDocumentId?: string | null;
  effectiveDate?: Date | string | null;
  notes?: string | null;
}) {
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Revalidation completion evidence');
  const before = await loadRevalidation(input.tenantId, input.revalidationId);
  if (!input.evidenceDocumentId && !before.evidenceDocumentId) {
    deny('Completion requires trusted evidence document', 400, 'EVIDENCE_REQUIRED');
  }
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.COMPLETED,
    reason: input.notes || 'Revalidation completed after authorized review',
    eventType: 'COMPLETED',
    requireFinalizeRole: true,
    patch: {
      completedAt: new Date(),
      effectiveDate: input.effectiveDate
        ? new Date(input.effectiveDate)
        : before.effectiveDate || undefined,
      evidenceDocumentId: input.evidenceDocumentId || before.evidenceDocumentId || undefined
    }
  });
}

export async function denyRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  reason: string;
  evidenceDocumentId?: string | null;
}) {
  if (!String(input.reason || '').trim()) deny('Denial reason is required');
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Revalidation denial evidence');
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.DENIED,
    reason: input.reason,
    eventType: 'DENIED',
    requireFinalizeRole: true,
    patch: {
      denialReason: input.reason,
      completedAt: new Date(),
      evidenceDocumentId: input.evidenceDocumentId || undefined
    }
  });
}

export async function cancelRevalidation(input: {
  tenantId: string;
  revalidationId: string;
  actorId: string;
  role: Role;
  reason: string;
}) {
  if (!String(input.reason || '').trim()) deny('Cancellation reason is required');
  return transition({
    ...input,
    toStatus: EnrollmentRevalidationStatus.CANCELLED,
    reason: input.reason,
    eventType: 'CANCELLED',
    patch: { cancellationReason: input.reason, completedAt: new Date() }
  });
}

export async function getRevalidationDashboardCounts(tenantId: string) {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400000);
  const base = { tenantId, status: { notIn: TERMINAL_REVALIDATION } };

  const [
    upcomingTotal,
    due30,
    overdue,
    preparing,
    awaitingSubmission,
    awaitingPayer,
    aiRequested,
    completed,
    denied
  ] = await Promise.all([
    prisma.enrollmentRevalidation.count({ where: { ...base } }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: { in: ACTIVE_REVALIDATION }, dueDate: { gte: now, lte: in30 } }
    }),
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        OR: [
          { status: EnrollmentRevalidationStatus.OVERDUE },
          { status: { in: ACTIVE_REVALIDATION }, dueDate: { lt: startOfUtcDay(now) } }
        ]
      }
    }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: { in: [EnrollmentRevalidationStatus.PREPARING, EnrollmentRevalidationStatus.READY_FOR_INTERNAL_REVIEW] } }
    }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: EnrollmentRevalidationStatus.READY_FOR_INTERNAL_REVIEW }
    }),
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        status: {
          in: [
            EnrollmentRevalidationStatus.SUBMITTED,
            EnrollmentRevalidationStatus.ACKNOWLEDGED,
            EnrollmentRevalidationStatus.APPROVED
          ]
        }
      }
    }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: EnrollmentRevalidationStatus.ADDITIONAL_INFORMATION_REQUIRED }
    }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: EnrollmentRevalidationStatus.COMPLETED }
    }),
    prisma.enrollmentRevalidation.count({
      where: { tenantId, status: EnrollmentRevalidationStatus.DENIED }
    })
  ]);

  return {
    upcomingTotal,
    dueWithin30Days: due30,
    overdue,
    preparing,
    awaitingSubmission,
    awaitingPayerResponse: awaitingPayer,
    additionalInformationRequested: aiRequested,
    completed,
    denied
  };
}

export async function getRevalidationWorklist(input: {
  tenantId: string;
  page?: number;
  pageSize?: number;
  status?: string;
  payerId?: string;
  providerId?: string;
  assignedToId?: string;
  revalidationType?: string;
  dueFrom?: string;
  dueTo?: string;
  sort?: string;
}) {
  const page = Math.max(1, input.page || 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize || 25));
  const where: any = { tenantId: input.tenantId };
  if (input.status) where.status = input.status;
  if (input.payerId) where.payerId = input.payerId;
  if (input.providerId) where.providerId = input.providerId;
  if (input.assignedToId) where.assignedToId = input.assignedToId;
  if (input.revalidationType) where.revalidationType = input.revalidationType;
  if (input.dueFrom || input.dueTo) {
    where.dueDate = {};
    if (input.dueFrom) where.dueDate.gte = new Date(input.dueFrom);
    if (input.dueTo) where.dueDate.lte = new Date(input.dueTo);
  }

  let orderBy: any = [{ dueDate: 'asc' }, { updatedAt: 'desc' }];
  if (input.sort === 'provider') orderBy = [{ providerId: 'asc' }];
  if (input.sort === 'status') orderBy = [{ status: 'asc' }, { dueDate: 'asc' }];
  if (input.sort === 'assigned') orderBy = [{ assignedToId: 'asc' }, { dueDate: 'asc' }];

  const [total, items] = await Promise.all([
    prisma.enrollmentRevalidation.count({ where }),
    prisma.enrollmentRevalidation.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
        payer: { select: { id: true, name: true } },
        payerPlan: { select: { id: true, name: true } },
        enrollment: {
          select: {
            id: true,
            applicationNo: true,
            organizationId: true,
            practiceId: true,
            facilityId: true,
            nextFollowUpAt: true,
            status: true
          }
        },
        assignedTo: { select: { id: true, name: true, email: true } }
      }
    })
  ]);

  return {
    page,
    pageSize,
    total,
    items: items.map((r) => ({
      ...r,
      daysRemaining: daysRemaining(r.dueDate),
      overdue: (daysRemaining(r.dueDate) ?? 1) < 0 && !TERMINAL_REVALIDATION.includes(r.status)
    }))
  };
}

/** Mark past-due active revalidations as OVERDUE (idempotent status move where allowed). */
export async function evaluateOverdueRevalidations(tenantId: string, actorId?: string) {
  const now = startOfUtcDay(new Date());
  const rows = await prisma.enrollmentRevalidation.findMany({
    where: {
      tenantId,
      status: { in: ACTIVE_REVALIDATION.filter((s) => s !== EnrollmentRevalidationStatus.OVERDUE) },
      dueDate: { lt: now }
    }
  });
  let updated = 0;
  for (const row of rows) {
    if (!(TRANSITIONS[row.status] || []).includes(EnrollmentRevalidationStatus.OVERDUE)) continue;
    await prisma.enrollmentRevalidation.update({
      where: { id: row.id },
      data: { status: EnrollmentRevalidationStatus.OVERDUE }
    });
    await prisma.enrollmentRevalidationEvent.create({
      data: {
        revalidationId: row.id,
        fromStatus: row.status,
        toStatus: EnrollmentRevalidationStatus.OVERDUE,
        actorId: actorId || null,
        eventType: 'OVERDUE_EVAL',
        reason: 'Due date passed'
      }
    });
    updated += 1;
  }
  return { inspected: rows.length, updated };
}

export { REVALIDATION_FOLLOWUP_SOURCE, TERMINAL };
