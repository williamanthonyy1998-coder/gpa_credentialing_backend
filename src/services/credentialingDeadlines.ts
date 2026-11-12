import {
  Priority,
  Role,
  TaskStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { computeLicenseAttention } from './licenseLifecycle';
import { daysRemaining, ACTIVE_REVALIDATION } from './enrollmentRevalidation';
import { ENROLLMENT_FOLLOWUP_SOURCE, TERMINAL } from './enrollmentLifecycle';

/**
 * Phase 4E — unified deadline evaluation (DB-backed, idempotent task fingerprints).
 * Not a claim of automated email/SMS scheduling unless a separate delivery config exists.
 */

export const DEADLINE_SOURCE = 'CREDENTIALING_DEADLINE';
export const DEFAULT_WINDOWS_DAYS = [120, 90, 60, 30, 15, 7] as const;

export type DeadlineItem = {
  category: 'LICENSE' | 'MALPRACTICE' | 'BOARD_CERT' | 'PROFESSIONAL_CERT' | 'REVALIDATION' | 'ENROLLMENT_FOLLOWUP' | 'OTHER_CREDENTIAL';
  recordId: string;
  providerId?: string | null;
  enrollmentId?: string | null;
  title: string;
  dueDate: string;
  daysRemaining: number;
  statusHint: string;
  overdue: boolean;
};

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function canEvaluateDeadlines(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
  );
}

export async function listCredentialingDeadlines(input: {
  tenantId: string;
  withinDays?: number;
  includeOverdue?: boolean;
}): Promise<{ items: DeadlineItem[]; generatedAt: string }> {
  const now = new Date();
  const within = input.withinDays ?? 120;
  const horizon = new Date(now.getTime() + within * 86400000);
  const items: DeadlineItem[] = [];

  const licenses = await prisma.license.findMany({
    where: {
      tenantId: input.tenantId,
      archived: false,
      expiresAt: { not: null, lte: horizon }
    },
    select: {
      id: true,
      providerId: true,
      type: true,
      number: true,
      expiresAt: true,
      verificationStatus: true,
      status: true
    },
    take: 500
  });
  for (const lic of licenses) {
    const days = daysRemaining(lic.expiresAt, now);
    if (days == null) continue;
    if (!input.includeOverdue && days < 0) continue;
    if (days > within) continue;
    const attention = computeLicenseAttention(lic as any, now);
    items.push({
      category: 'LICENSE',
      recordId: lic.id,
      providerId: lic.providerId,
      title: `License ${lic.type}${lic.number ? ` #${lic.number}` : ''} expires`,
      dueDate: lic.expiresAt!.toISOString(),
      daysRemaining: days,
      statusHint: attention,
      overdue: days < 0
    });
  }

  const malpractice = await prisma.providerMalpracticePolicy.findMany({
    where: {
      tenantId: input.tenantId,
      expirationDate: { not: null, lte: horizon }
    },
    select: { id: true, providerId: true, insuranceCarrier: true, expirationDate: true, verificationStatus: true },
    take: 300
  });
  for (const m of malpractice) {
    const days = daysRemaining(m.expirationDate, now);
    if (days == null || days > within) continue;
    if (!input.includeOverdue && days < 0) continue;
    items.push({
      category: 'MALPRACTICE',
      recordId: m.id,
      providerId: m.providerId,
      title: `Malpractice ${m.insuranceCarrier || 'policy'} expires`,
      dueDate: m.expirationDate!.toISOString(),
      daysRemaining: days,
      statusHint: m.verificationStatus,
      overdue: days < 0
    });
  }

  const boards = await prisma.providerBoardCertification.findMany({
    where: {
      tenantId: input.tenantId,
      expirationDate: { not: null, lte: horizon }
    },
    select: { id: true, providerId: true, certifyingBoard: true, expirationDate: true, verificationStatus: true },
    take: 300
  });
  for (const b of boards) {
    const days = daysRemaining(b.expirationDate, now);
    if (days == null || days > within) continue;
    if (!input.includeOverdue && days < 0) continue;
    items.push({
      category: 'BOARD_CERT',
      recordId: b.id,
      providerId: b.providerId,
      title: `Board cert ${b.certifyingBoard || ''} expires`,
      dueDate: b.expirationDate!.toISOString(),
      daysRemaining: days,
      statusHint: b.verificationStatus,
      overdue: days < 0
    });
  }

  const revals = await prisma.enrollmentRevalidation.findMany({
    where: {
      tenantId: input.tenantId,
      status: { in: ACTIVE_REVALIDATION },
      dueDate: { not: null, lte: horizon }
    },
    select: {
      id: true,
      providerId: true,
      enrollmentId: true,
      revalidationType: true,
      dueDate: true,
      status: true
    },
    take: 500
  });
  for (const r of revals) {
    const days = daysRemaining(r.dueDate, now);
    if (days == null || days > within) continue;
    if (!input.includeOverdue && days < 0) continue;
    items.push({
      category: 'REVALIDATION',
      recordId: r.id,
      providerId: r.providerId,
      enrollmentId: r.enrollmentId,
      title: `${r.revalidationType} due`,
      dueDate: r.dueDate!.toISOString(),
      daysRemaining: days,
      statusHint: r.status,
      overdue: days < 0
    });
  }

  const followUps = await prisma.task.findMany({
    where: {
      tenantId: input.tenantId,
      source: ENROLLMENT_FOLLOWUP_SOURCE,
      status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
      dueAt: { not: null, lte: horizon }
    },
    select: {
      id: true,
      providerId: true,
      enrollmentId: true,
      title: true,
      dueAt: true,
      status: true,
      followUpType: true
    },
    take: 500
  });
  for (const t of followUps) {
    const days = daysRemaining(t.dueAt, now);
    if (days == null || days > within) continue;
    if (!input.includeOverdue && days < 0) continue;
    items.push({
      category: 'ENROLLMENT_FOLLOWUP',
      recordId: t.id,
      providerId: t.providerId,
      enrollmentId: t.enrollmentId,
      title: t.title || t.followUpType || 'Enrollment follow-up',
      dueDate: t.dueAt!.toISOString(),
      daysRemaining: days,
      statusHint: t.status,
      overdue: days < 0
    });
  }

  items.sort((a, b) => a.daysRemaining - b.daysRemaining || a.dueDate.localeCompare(b.dueDate));
  return { items, generatedAt: now.toISOString() };
}

/**
 * Idempotent reminder task creation for approaching/overdue deadlines.
 * Uses fingerprint pattern — repeated evaluation does not duplicate open tasks.
 * Does not send email/SMS.
 */
export async function evaluateCredentialingDeadlines(input: {
  tenantId: string;
  actorId: string;
  role: Role;
  windows?: number[];
}) {
  if (!canEvaluateDeadlines(input.role)) {
    const err: any = new Error('Insufficient permissions');
    err.status = 403;
    throw err;
  }

  const windows = (input.windows?.length ? input.windows : [...DEFAULT_WINDOWS_DAYS]).sort((a, b) => b - a);
  const { items } = await listCredentialingDeadlines({
    tenantId: input.tenantId,
    withinDays: Math.max(...windows, 0),
    includeOverdue: true
  });

  let created = 0;
  let reused = 0;

  for (const item of items) {
    // Skip follow-ups that already are tasks
    if (item.category === 'ENROLLMENT_FOLLOWUP') continue;

    // Skip terminal enrollments for revalidation reminders
    if (item.enrollmentId) {
      const enr = await prisma.enrollmentApplication.findFirst({
        where: { id: item.enrollmentId, tenantId: input.tenantId },
        select: { status: true }
      });
      if (enr && TERMINAL.includes(enr.status)) continue;
    }

    const windowHit =
      item.daysRemaining < 0
        ? 'OVERDUE'
        : windows.find((w) => item.daysRemaining <= w) ?? null;
    if (windowHit == null) continue;

    const dueDay = startOfUtcDay(new Date(item.dueDate)).toISOString().slice(0, 10);
    const fingerprint = `deadline:${item.category}:${item.recordId}:${windowHit}:${dueDay}`;
    const existing = await prisma.task.findFirst({
      where: { tenantId: input.tenantId, fingerprint, source: DEADLINE_SOURCE }
    });
    const openish: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];
    if (existing && openish.includes(existing.status)) {
      reused += 1;
      continue;
    }
    if (existing && (existing.status === TaskStatus.COMPLETED || existing.status === TaskStatus.CANCELLED)) {
      // Preserve history; create a new open task only for a new window fingerprint (already unique by window)
    }

    const priority =
      item.daysRemaining < 0
        ? Priority.URGENT
        : item.daysRemaining <= 15
          ? Priority.HIGH
          : Priority.NORMAL;

    await prisma.task.create({
      data: {
        title: `${item.category}: ${item.title}`,
        description: `Operational reminder (${windowHit}). Not a legal/payer deadline claim. Days remaining: ${item.daysRemaining}.`,
        status: TaskStatus.OPEN,
        priority,
        dueAt: new Date(item.dueDate),
        createdById: input.actorId,
        tenantId: input.tenantId,
        providerId: item.providerId || null,
        enrollmentId: item.enrollmentId || null,
        source: DEADLINE_SOURCE,
        fingerprint,
        relatedType: item.category.toLowerCase(),
        relatedId: item.recordId
      }
    });
    created += 1;
  }

  return {
    inspected: items.length,
    tasksCreated: created,
    tasksReused: reused,
    note: 'Deadline evaluation creates Task reminders only. Email/SMS is not sent unless a separate delivery service is configured and tested.'
  };
}

export async function getCredentialRenewalWorklist(input: {
  tenantId: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, input.page || 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize || 25));
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 86400000);

  const where = {
    tenantId: input.tenantId,
    archived: false,
    OR: [
      { expiresAt: { lte: in90 } },
      { renewedFromId: { not: null } }
    ]
  };

  const [total, rows] = await Promise.all([
    prisma.license.count({ where }),
    prisma.license.findMany({
      where,
      orderBy: [{ expiresAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
        renewedFrom: { select: { id: true, number: true, expiresAt: true, verificationStatus: true } },
        renewals: { select: { id: true, number: true, expiresAt: true, verificationStatus: true, issuedAt: true } }
      }
    })
  ]);

  return {
    page,
    pageSize,
    total,
    items: rows.map((r) => {
      const attention = computeLicenseAttention(r as any, now);
      return {
        id: r.id,
        provider: r.provider,
        type: r.type,
        number: r.number,
        expiresAt: r.expiresAt,
        daysRemaining: daysRemaining(r.expiresAt, now),
        verificationStatus: r.verificationStatus,
        attention,
        renewedFromId: r.renewedFromId,
        renewedFrom: r.renewedFrom,
        renewals: r.renewals,
        note: 'Credential renewal is separate from payer enrollment revalidation.'
      };
    })
  };
}

export async function getDeadlineDashboardExtras(tenantId: string) {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400000);

  const [licensesExpiring30, licensesExpired, licensesPendingVerify, renewalTasksOpen] = await Promise.all([
    prisma.license.count({
      where: {
        tenantId,
        archived: false,
        expiresAt: { gte: startOfUtcDay(now), lte: in30 }
      }
    }),
    prisma.license.count({
      where: { tenantId, archived: false, expiresAt: { lt: startOfUtcDay(now) } }
    }),
    prisma.license.count({
      where: {
        tenantId,
        archived: false,
        verificationStatus: { in: ['PENDING_REVIEW', 'NOT_SUBMITTED'] as any }
      }
    }),
    prisma.task.count({
      where: {
        tenantId,
        source: { in: [DEADLINE_SOURCE, ENROLLMENT_FOLLOWUP_SOURCE] },
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }
      }
    })
  ]);

  return {
    credentialsExpiringWithin30Days: licensesExpiring30,
    expiredCredentials: licensesExpired,
    credentialsPendingVerification: licensesPendingVerify,
    openRenewalRelatedTasks: renewalTasksOpen
  };
}
