/**
 * Phase 5B — workflow automation engine.
 * Reuses Task fingerprints, EnrollmentApplication follow-up fields, credentialingDeadlines,
 * and notifications. Does NOT change official enrollment/credential statuses.
 */
import {
  AutomationPolicyKind,
  EnrollmentStatus,
  Prisma,
  Priority,
  Role,
  TaskStatus,
  WorkflowSlaStatus
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { TERMINAL, ENROLLMENT_FOLLOWUP_SOURCE } from './enrollmentLifecycle';
import { resolvePolicy } from './automationPolicies';
import { deliverAutomationNotification } from './automationNotifications';
import { listCredentialingDeadlines, DEADLINE_SOURCE } from './credentialingDeadlines';
import { daysRemaining } from './enrollmentRevalidation';

const PENDING_STATUSES: EnrollmentStatus[] = [
  EnrollmentStatus.SUBMITTED,
  EnrollmentStatus.ACKNOWLEDGED,
  EnrollmentStatus.PAYER_REVIEW,
  EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED
];

const OPEN_TASK: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];

function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 86400000);
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function calendarDaysBetween(from: Date, to: Date) {
  const a = startOfUtcDay(from).getTime();
  const b = startOfUtcDay(to).getTime();
  return Math.round((b - a) / 86400000);
}

function businessDaysBetween(from: Date, to: Date) {
  let count = 0;
  const cur = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  const step = end >= cur ? 1 : -1;
  while ((step > 0 && cur < end) || (step < 0 && cur > end)) {
    cur.setUTCDate(cur.getUTCDate() + step);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count += step;
  }
  return Math.abs(count);
}

/** DB-backed lock so multiple API instances do not double-run jobs. */
export async function acquireJobLock(lockKey: string, ttlMs: number): Promise<{ ownerId: string } | null> {
  const ownerId = randomUUID();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMs);
  const existing = await prisma.automationJobLock.findUnique({ where: { lockKey } });
  if (existing && existing.lockedUntil > now) {
    return null;
  }
  try {
    if (!existing) {
      await prisma.automationJobLock.create({ data: { lockKey, ownerId, lockedUntil } });
      return { ownerId };
    }
    const updated = await prisma.automationJobLock.updateMany({
      where: { lockKey, lockedUntil: { lte: now } },
      data: { ownerId, lockedUntil }
    });
    if (updated.count === 0) return null;
    return { ownerId };
  } catch {
    return null;
  }
}

export async function releaseJobLock(lockKey: string, ownerId: string) {
  await prisma.automationJobLock.deleteMany({ where: { lockKey, ownerId } });
}

export async function runAutomationJob(input: {
  jobType: string;
  tenantId?: string | null;
  triggeredBy: string;
  lockKey: string;
  ttlMs?: number;
  work: () => Promise<Record<string, unknown>>;
}) {
  const lock = await acquireJobLock(input.lockKey, input.ttlMs ?? 120_000);
  if (!lock) {
    const skipped = await prisma.automationJobRun.create({
      data: {
        jobType: input.jobType,
        tenantId: input.tenantId || null,
        status: 'SKIPPED',
        triggeredBy: input.triggeredBy,
        lockKey: input.lockKey,
        finishedAt: new Date(),
        result: { reason: 'lock_held' } as Prisma.InputJsonValue
      }
    });
    return skipped;
  }

  const run = await prisma.automationJobRun.create({
    data: {
      jobType: input.jobType,
      tenantId: input.tenantId || null,
      status: 'RUNNING',
      triggeredBy: input.triggeredBy,
      lockKey: input.lockKey
    }
  });

  try {
    const result = await input.work();
    return await prisma.automationJobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: result as Prisma.InputJsonValue
      }
    });
  } catch (e: any) {
    return await prisma.automationJobRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: String(e?.message || e).slice(0, 1000)
      }
    });
  } finally {
    await releaseJobLock(input.lockKey, lock.ownerId);
  }
}

async function findStaffRecipients(input: {
  tenantId: string;
  organizationId?: string | null;
  roles: string[];
  preferredUserId?: string | null;
}) {
  const ids = new Set<string>();
  if (input.preferredUserId) ids.add(input.preferredUserId);

  if (input.organizationId) {
    const hr = await prisma.organizationEmployee.findMany({
      where: {
        organizationId: input.organizationId,
        employmentStatus: 'ACTIVE',
        user: { active: true, role: { in: input.roles as Role[] } }
      },
      select: { userId: true },
      take: 20
    });
    for (const h of hr) ids.add(h.userId);
  }

  const memberships = await prisma.tenantMembership.findMany({
    where: {
      tenantId: input.tenantId,
      status: 'ACTIVE',
      user: { active: true, role: { in: input.roles as Role[] } }
    },
    select: { userId: true },
    take: 30
  });
  for (const m of memberships) ids.add(m.userId);

  return [...ids];
}

/** Automatic follow-up scheduling for pending applications. */
export async function sweepFollowUps(tenantId: string) {
  const now = new Date();
  const enrollments = await prisma.enrollmentApplication.findMany({
    where: {
      tenantId,
      status: { in: PENDING_STATUSES },
      OR: [
        { nextFollowUpAt: null },
        { nextFollowUpAt: { lte: now } }
      ],
      AND: [
        {
          OR: [
            { followUpStatus: null },
            { followUpStatus: { notIn: ['COMPLETED', 'CANCELLED', 'PAUSED'] } }
          ]
        }
      ]
    },
    include: { payerPlan: { select: { payerId: true } } },
    take: 200
  });

  let scheduled = 0;
  let skippedClosed = 0;
  for (const enr of enrollments) {
    if (TERMINAL.includes(enr.status) || enr.status === EnrollmentStatus.APPROVED || enr.status === EnrollmentStatus.EFFECTIVE) {
      skippedClosed += 1;
      await prisma.enrollmentApplication.update({
        where: { id: enr.id },
        data: { followUpStatus: 'COMPLETED' }
      });
      continue;
    }

    const policy = await resolvePolicy({
      kind: AutomationPolicyKind.FOLLOW_UP_INTERVAL,
      tenantId,
      organizationId: enr.organizationId,
      payerId: enr.payerPlan?.payerId
    });
    const interval = policy.config.defaultIntervalDays || policy.config.intervalsDays?.[0] || 7;
    const dueAt = enr.nextFollowUpAt && enr.nextFollowUpAt > now
      ? enr.nextFollowUpAt
      : addDays(now, interval);

    const dueDay = dueAt.toISOString().slice(0, 10);
    const fingerprint = `enr-followup-auto:${enr.id}:${dueDay}`;
    const existing = await prisma.task.findFirst({
      where: { tenantId, fingerprint, source: ENROLLMENT_FOLLOWUP_SOURCE }
    });
    if (existing && OPEN_TASK.includes(existing.status)) {
      continue;
    }

    const recipients = await findStaffRecipients({
      tenantId,
      organizationId: enr.organizationId,
      roles: ['CREDENTIALING_SPECIALIST', 'ENROLLMENT_SPECIALIST', 'CREDENTIALING_MANAGER'],
      preferredUserId: existing?.assignedToId
    });
    const assignee = recipients[0] || null;

    const task = existing
      ? await prisma.task.update({
          where: { id: existing.id },
          data: {
            status: TaskStatus.OPEN,
            dueAt,
            title: `Follow-up due: ${enr.applicationNo}`,
            description: `Automated follow-up scheduled (${interval} day interval).`,
            assignedToId: assignee,
            followUpType: 'STATUS_CHECK',
            priority: Priority.NORMAL,
            organizationId: enr.organizationId,
            providerId: enr.providerId,
            enrollmentId: enr.id
          }
        })
      : await prisma.task.create({
          data: {
            title: `Follow-up due: ${enr.applicationNo}`,
            description: `Automated follow-up scheduled (${interval} day interval).`,
            status: TaskStatus.OPEN,
            priority: Priority.NORMAL,
            dueAt,
            assignedToId: assignee,
            tenantId,
            organizationId: enr.organizationId,
            providerId: enr.providerId,
            enrollmentId: enr.id,
            source: ENROLLMENT_FOLLOWUP_SOURCE,
            fingerprint,
            followUpType: 'STATUS_CHECK',
            relatedType: 'enrollment',
            relatedId: enr.id
          }
        });

    if (assignee && existing?.assignedToId !== assignee) {
      await prisma.taskAssignmentEvent.create({
        data: {
          taskId: task.id,
          fromUserId: existing?.assignedToId || null,
          toUserId: assignee,
          changedById: null,
          reason: 'AUTOMATION_FOLLOW_UP'
        }
      });
    }

    await prisma.enrollmentApplication.update({
      where: { id: enr.id },
      data: {
        nextFollowUpAt: dueAt,
        lastFollowUpAt: enr.lastFollowUpAt || now,
        followUpCount: { increment: 1 },
        followUpStatus: 'ACTIVE'
      }
    });

    for (const userId of recipients.slice(0, 5)) {
      await deliverAutomationNotification({
        tenantId,
        userId,
        title: `Follow-up due: ${enr.applicationNo}`,
        body: `A payer follow-up is due for enrollment ${enr.applicationNo}.`,
        type: 'FOLLOW_UP_DUE',
        entityType: 'enrollment',
        entityId: enr.id,
        href: `/enrollments?id=${enr.id}`,
        dedupeKey: `followup-notify:${enr.id}:${dueDay}:${userId}`,
        organizationId: enr.organizationId
      });
    }
    scheduled += 1;
  }

  return { scanned: enrollments.length, scheduled, skippedClosed };
}

/** Escalation for pending applications — never changes enrollment status. */
export async function sweepEscalations(tenantId: string) {
  const now = new Date();
  const enrollments = await prisma.enrollmentApplication.findMany({
    where: {
      tenantId,
      status: { in: PENDING_STATUSES }
    },
    include: { payerPlan: { select: { payerId: true } } },
    take: 200
  });

  let created = 0;
  let skipped = 0;
  for (const enr of enrollments) {
    const anchor = enr.submittedAt || enr.preparedAt || enr.createdAt;
    const pendingDays = calendarDaysBetween(anchor, now);
    const policy = await resolvePolicy({
      kind: AutomationPolicyKind.ESCALATION,
      tenantId,
      organizationId: enr.organizationId,
      payerId: enr.payerPlan?.payerId
    });
    const thresholds = [...(policy.config.thresholdsDays || [7, 14, 30])].sort((a, b) => a - b);
    const roles = policy.config.targetRoles || [
      'CREDENTIALING_SPECIALIST',
      'CREDENTIALING_MANAGER',
      'ADMIN'
    ];

    for (let i = 0; i < thresholds.length; i += 1) {
      const threshold = thresholds[i];
      if (pendingDays < threshold) continue;
      const level = i + 1;
      const dedupeKey = `esc:enrollment:${enr.id}:L${level}:T${threshold}`;
      const existing = await prisma.escalationRecord.findUnique({ where: { dedupeKey } });
      if (existing) {
        skipped += 1;
        continue;
      }

      const role = roles[Math.min(i, roles.length - 1)];
      const recipients = await findStaffRecipients({
        tenantId,
        organizationId: enr.organizationId,
        roles: [role, 'CREDENTIALING_MANAGER', 'ADMIN']
      });
      const assignedEmployeeId = recipients[0] || null;
      const managerId = recipients.find((id) => id !== assignedEmployeeId) || assignedEmployeeId;

      await prisma.escalationRecord.create({
        data: {
          tenantId,
          organizationId: enr.organizationId,
          entityType: 'enrollment',
          entityId: enr.id,
          level,
          reason: `Pending ${pendingDays} days (threshold ${threshold}). Status unchanged.`,
          status: 'OPEN',
          assignedEmployeeId,
          responsibleManagerId: managerId,
          dedupeKey
        }
      });

      for (const userId of recipients.slice(0, 5)) {
        await deliverAutomationNotification({
          tenantId,
          userId,
          title: `Escalation L${level}: ${enr.applicationNo}`,
          body: `Enrollment ${enr.applicationNo} has been pending ${pendingDays} days.`,
          type: 'ESCALATION',
          entityType: 'enrollment',
          entityId: enr.id,
          href: `/enrollments?id=${enr.id}`,
          dedupeKey: `esc-notify:${dedupeKey}:${userId}`,
          organizationId: enr.organizationId
        });
      }
      created += 1;
    }
  }
  return { scanned: enrollments.length, created, skipped };
}

export async function refreshEnrollmentSla(tenantId: string) {
  const enrollments = await prisma.enrollmentApplication.findMany({
    where: { tenantId },
    include: { payerPlan: { select: { payerId: true } } },
    take: 300,
    orderBy: { updatedAt: 'desc' }
  });
  const now = new Date();
  let upserted = 0;

  for (const enr of enrollments) {
    const policy = await resolvePolicy({
      kind: AutomationPolicyKind.SLA,
      tenantId,
      organizationId: enr.organizationId,
      payerId: enr.payerPlan?.payerId
    });
    const targetDays = policy.config.slaTargetDays || 30;
    const dueSoonDays = policy.config.dueSoonDays ?? 7;
    const atRiskDays = policy.config.atRiskDays ?? 3;
    const start = enr.submittedAt || enr.createdAt;
    const expected = addDays(start, targetDays);
    const completed = TERMINAL.includes(enr.status)
      || enr.status === EnrollmentStatus.APPROVED
      || enr.status === EnrollmentStatus.EFFECTIVE;
    const actual = completed
      ? (enr.decisionAt || enr.effectiveAt || enr.updatedAt)
      : null;

    const elapsed = calendarDaysBetween(start, actual || now);
    const biz = businessDaysBetween(start, actual || now);
    const remaining = calendarDaysBetween(now, expected);
    const overdue = Math.max(0, -remaining);

    let slaStatus: WorkflowSlaStatus = WorkflowSlaStatus.NOT_STARTED;
    if (completed) slaStatus = WorkflowSlaStatus.COMPLETED;
    else if (!enr.submittedAt && enr.status === EnrollmentStatus.NOT_STARTED) slaStatus = WorkflowSlaStatus.NOT_STARTED;
    else if (overdue > 0) slaStatus = WorkflowSlaStatus.OVERDUE;
    else if (remaining <= atRiskDays) slaStatus = WorkflowSlaStatus.AT_RISK;
    else if (remaining <= dueSoonDays) slaStatus = WorkflowSlaStatus.DUE_SOON;
    else slaStatus = WorkflowSlaStatus.WITHIN_SLA;

    const existing = await prisma.workflowSlaRecord.findUnique({
      where: { entityType_entityId: { entityType: 'enrollment', entityId: enr.id } }
    });

    const history = Array.isArray(existing?.statusHistory) ? [...(existing!.statusHistory as any[])] : [];
    if (!existing || existing.slaStatus !== slaStatus) {
      history.push({
        at: now.toISOString(),
        from: existing?.slaStatus || null,
        to: slaStatus
      });
    }

    await prisma.workflowSlaRecord.upsert({
      where: { entityType_entityId: { entityType: 'enrollment', entityId: enr.id } },
      create: {
        tenantId,
        organizationId: enr.organizationId,
        entityType: 'enrollment',
        entityId: enr.id,
        policyId: policy.id,
        applicationCreatedAt: enr.createdAt,
        submissionDate: enr.submittedAt,
        acknowledgementDate: enr.acknowledgedAt,
        lastActivityAt: enr.updatedAt,
        expectedCompletionAt: expected,
        actualCompletionAt: actual,
        elapsedDays: elapsed,
        businessDaysElapsed: biz,
        daysRemaining: remaining,
        overdueDays: overdue,
        slaStatus,
        statusHistory: history as Prisma.InputJsonValue
      },
      update: {
        organizationId: enr.organizationId,
        policyId: policy.id,
        applicationCreatedAt: enr.createdAt,
        submissionDate: enr.submittedAt,
        acknowledgementDate: enr.acknowledgedAt,
        lastActivityAt: enr.updatedAt,
        expectedCompletionAt: expected,
        actualCompletionAt: actual,
        elapsedDays: elapsed,
        businessDaysElapsed: biz,
        daysRemaining: remaining,
        overdueDays: overdue,
        slaStatus,
        statusHistory: history as Prisma.InputJsonValue
      }
    });
    upserted += 1;
  }
  return { scanned: enrollments.length, upserted };
}

export async function sweepExpiryAlerts(tenantId: string) {
  const policy = await resolvePolicy({
    kind: AutomationPolicyKind.EXPIRY_ALERT,
    tenantId
  });
  const windows = [...(policy.config.windowsDays || [90, 60, 30, 15, 7, 0])].sort((a, b) => b - a);
  const maxWindow = Math.max(...windows, 0);
  const { items } = await listCredentialingDeadlines({
    tenantId,
    withinDays: Math.max(maxWindow, 1),
    includeOverdue: true
  });

  const roles = policy.config.targetRoles || ['CREDENTIALING_SPECIALIST', 'CREDENTIALING_MANAGER'];
  let created = 0;
  let skipped = 0;

  for (const item of items) {
    const days = item.daysRemaining;
    // Map to the tightest matching threshold window (including 0 = expiry day, negative = after expiry key "EXPIRED")
    let thresholdKey: string | null = null;
    if (days < 0) thresholdKey = 'EXPIRED';
    else {
      const entered = windows.filter((w) => days <= w).sort((a, b) => a - b);
      thresholdKey = entered.length ? String(entered[0]) : null;
    }
    if (!thresholdKey) {
      skipped += 1;
      continue;
    }

    const dedupeKey = `expiry:${item.category}:${item.recordId}:${thresholdKey}`;
    const existing = await prisma.automationAlert.findUnique({ where: { dedupeKey } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const recipients = await findStaffRecipients({
      tenantId,
      organizationId: null,
      roles
    });

    let taskId: string | null = null;
    const taskFp = `deadline:${item.category}:${item.recordId}:${thresholdKey}:${item.dueDate.slice(0, 10)}`;
    const openTask = await prisma.task.findFirst({
      where: { tenantId, fingerprint: taskFp, source: DEADLINE_SOURCE }
    });
    if (!openTask) {
      const task = await prisma.task.create({
        data: {
          title: item.title,
          description: `Expiry alert (${thresholdKey}). Days remaining: ${days}.`,
          status: TaskStatus.OPEN,
          priority: days <= 7 ? Priority.HIGH : Priority.NORMAL,
          dueAt: new Date(item.dueDate),
          assignedToId: recipients[0] || null,
          tenantId,
          providerId: item.providerId || null,
          enrollmentId: item.enrollmentId || null,
          source: DEADLINE_SOURCE,
          fingerprint: taskFp,
          relatedType: item.category,
          relatedId: item.recordId
        }
      });
      taskId = task.id;
      if (recipients[0]) {
        await prisma.taskAssignmentEvent.create({
          data: {
            taskId: task.id,
            toUserId: recipients[0],
            changedById: null,
            reason: 'AUTOMATION_EXPIRY_ALERT'
          }
        });
      }
    } else {
      taskId = openTask.id;
    }

    await prisma.automationAlert.create({
      data: {
        tenantId,
        alertType: item.category,
        entityType: item.category,
        entityId: item.recordId,
        thresholdKey,
        status: 'SENT',
        notifiedUserIds: recipients.slice(0, 10),
        taskId,
        dedupeKey
      }
    });

    for (const userId of recipients.slice(0, 5)) {
      await deliverAutomationNotification({
        tenantId,
        userId,
        title: item.title,
        body: `Credential/revalidation alert (${thresholdKey}).`,
        type: 'EXPIRY_ALERT',
        entityType: item.category,
        entityId: item.recordId,
        href: item.enrollmentId ? `/enrollments?id=${item.enrollmentId}` : '/revalidation-ops',
        dedupeKey: `expiry-notify:${dedupeKey}:${userId}`
      });
    }
    created += 1;
  }

  return { scanned: items.length, created, skipped };
}

export async function sweepOverdueTaskEscalation(tenantId: string) {
  const policy = await resolvePolicy({
    kind: AutomationPolicyKind.TASK_ASSIGNMENT,
    tenantId
  });
  const days = policy.config.escalateOverdueTaskDays ?? 3;
  const cutoff = addDays(new Date(), -days);
  const tasks = await prisma.task.findMany({
    where: {
      tenantId,
      status: { in: OPEN_TASK },
      dueAt: { lt: cutoff }
    },
    take: 100
  });
  let escalated = 0;
  for (const task of tasks) {
    const dedupeKey = `task-esc:${task.id}:overdue`;
    const existing = await prisma.escalationRecord.findUnique({ where: { dedupeKey } });
    if (existing) continue;
    const managers = await findStaffRecipients({
      tenantId,
      organizationId: task.organizationId,
      roles: ['CREDENTIALING_MANAGER', 'ADMIN']
    });
    await prisma.escalationRecord.create({
      data: {
        tenantId,
        organizationId: task.organizationId,
        entityType: 'task',
        entityId: task.id,
        level: 1,
        reason: `Task overdue beyond ${days} days`,
        status: 'OPEN',
        assignedEmployeeId: task.assignedToId,
        responsibleManagerId: managers[0] || null,
        dedupeKey
      }
    });
    for (const userId of managers.slice(0, 3)) {
      await deliverAutomationNotification({
        tenantId,
        userId,
        title: `Overdue task: ${task.title}`.slice(0, 120),
        body: 'An open task is overdue and was escalated to managers.',
        type: 'TASK_ESCALATION',
        entityType: 'task',
        entityId: task.id,
        href: '/tasks',
        dedupeKey: `task-esc-notify:${task.id}:${userId}`,
        organizationId: task.organizationId
      });
    }
    escalated += 1;
  }
  return { scanned: tasks.length, escalated };
}

export async function runTenantAutomationSweep(tenantId: string, triggeredBy: string) {
  return runAutomationJob({
    jobType: 'TENANT_AUTOMATION_SWEEP',
    tenantId,
    triggeredBy,
    lockKey: `tenant-sweep:${tenantId}`,
    ttlMs: 180_000,
    work: async () => {
      const followUps = await sweepFollowUps(tenantId);
      const escalations = await sweepEscalations(tenantId);
      const sla = await refreshEnrollmentSla(tenantId);
      const expiry = await sweepExpiryAlerts(tenantId);
      const tasks = await sweepOverdueTaskEscalation(tenantId);
      return { followUps, escalations, sla, expiry, tasks };
    }
  });
}

export async function runGlobalAutomationTick(triggeredBy = 'SYSTEM') {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    take: 200
  });
  return runAutomationJob({
    jobType: 'GLOBAL_AUTOMATION_TICK',
    triggeredBy,
    lockKey: 'global-automation-tick',
    ttlMs: 300_000,
    work: async () => {
      const results: any[] = [];
      for (const t of tenants) {
        const r = await runTenantAutomationSweep(t.id, triggeredBy);
        results.push({ tenantId: t.id, runId: r.id, status: r.status });
      }
      const { retryFailedEmailDeliveries } = await import('./automationNotifications');
      const retries = await retryFailedEmailDeliveries(30);
      return { tenants: results, retries };
    }
  });
}

export async function getAutomationDashboard(tenantId: string, opts?: { userId?: string; organizationId?: string }) {
  const now = new Date();
  const startToday = startOfUtcDay(now);
  const endToday = addDays(startToday, 1);
  const orgFilter = opts?.organizationId ? { organizationId: opts.organizationId } : {};

  const [
    pendingFollowUps,
    followUpsDueToday,
    overdueFollowUps,
    atRisk,
    overdueSla,
    upcomingExpiry,
    expiredAlerts,
    pendingReval,
    openEscalations,
    overdueTasks,
    slaRows,
    completedSla
  ] = await Promise.all([
    prisma.task.count({
      where: {
        tenantId,
        ...orgFilter,
        source: ENROLLMENT_FOLLOWUP_SOURCE,
        status: { in: OPEN_TASK },
        dueAt: { gte: now }
      }
    }),
    prisma.task.count({
      where: {
        tenantId,
        ...orgFilter,
        source: ENROLLMENT_FOLLOWUP_SOURCE,
        status: { in: OPEN_TASK },
        dueAt: { gte: startToday, lt: endToday }
      }
    }),
    prisma.task.count({
      where: {
        tenantId,
        ...orgFilter,
        source: ENROLLMENT_FOLLOWUP_SOURCE,
        status: { in: OPEN_TASK },
        dueAt: { lt: now }
      }
    }),
    prisma.workflowSlaRecord.count({
      where: { tenantId, ...orgFilter, slaStatus: WorkflowSlaStatus.AT_RISK }
    }),
    prisma.workflowSlaRecord.count({
      where: { tenantId, ...orgFilter, slaStatus: WorkflowSlaStatus.OVERDUE }
    }),
    prisma.automationAlert.count({
      where: {
        tenantId,
        ...orgFilter,
        status: { in: ['PENDING', 'SENT'] },
        thresholdKey: { not: 'EXPIRED' },
        createdAt: { gte: addDays(now, -30) }
      }
    }),
    prisma.automationAlert.count({
      where: { tenantId, ...orgFilter, thresholdKey: 'EXPIRED', status: { in: ['PENDING', 'SENT'] } }
    }),
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        status: { in: ['NOT_STARTED', 'UPCOMING', 'PREPARING', 'READY_FOR_INTERNAL_REVIEW', 'SUBMITTED', 'ACKNOWLEDGED', 'ADDITIONAL_INFORMATION_REQUIRED', 'OVERDUE'] },
        dueDate: { lte: addDays(now, 90) }
      }
    }),
    prisma.escalationRecord.count({
      where: { tenantId, ...orgFilter, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }
    }),
    prisma.task.count({
      where: {
        tenantId,
        ...orgFilter,
        status: { in: OPEN_TASK },
        dueAt: { lt: now },
        ...(opts?.userId ? { assignedToId: opts.userId } : {})
      }
    }),
    prisma.workflowSlaRecord.count({ where: { tenantId, ...orgFilter } }),
    prisma.workflowSlaRecord.count({
      where: { tenantId, ...orgFilter, slaStatus: WorkflowSlaStatus.COMPLETED }
    })
  ]);

  const withinOrCompleted = await prisma.workflowSlaRecord.count({
    where: {
      tenantId,
      ...orgFilter,
      slaStatus: { in: [WorkflowSlaStatus.WITHIN_SLA, WorkflowSlaStatus.COMPLETED, WorkflowSlaStatus.DUE_SOON] }
    }
  });
  const slaCompliancePct = slaRows === 0 ? null : Math.round((withinOrCompleted / slaRows) * 1000) / 10;

  const turnaround = await prisma.workflowSlaRecord.aggregate({
    where: {
      tenantId,
      ...orgFilter,
      slaStatus: WorkflowSlaStatus.COMPLETED,
      elapsedDays: { not: null }
    },
    _avg: { elapsedDays: true }
  });

  return {
    pendingFollowUps,
    followUpsDueToday,
    overdueFollowUps,
    applicationsAtRisk: atRisk,
    overdueApplications: overdueSla,
    upcomingCredentialExpirations: upcomingExpiry,
    expiredCredentials: expiredAlerts,
    pendingRevalidations: pendingReval,
    openEscalations,
    overdueTasks,
    slaCompliancePct,
    averageTurnaroundDays: turnaround._avg.elapsedDays != null
      ? Math.round(turnaround._avg.elapsedDays * 10) / 10
      : null,
    generatedAt: now.toISOString()
  };
}

export async function reassignTask(input: {
  tenantId: string;
  taskId: string;
  toUserId: string;
  actorId: string;
  actorRole: Role;
  reason?: string;
}) {
  if (input.actorRole === Role.CLIENT_USER || input.actorRole === Role.EXTERNAL_PROVIDER || input.actorRole === Role.READ_ONLY) {
    const err: any = new Error('Insufficient permissions');
    err.status = 403;
    throw err;
  }
  const task = await prisma.task.findFirst({ where: { id: input.taskId, tenantId: input.tenantId } });
  if (!task) {
    const err: any = new Error('Task not found');
    err.status = 404;
    throw err;
  }
  const user = await prisma.user.findFirst({ where: { id: input.toUserId, active: true } });
  if (!user) {
    const err: any = new Error('Assignee not found or inactive');
    err.status = 400;
    throw err;
  }
  // HR assignment alone is not ACL — require tenant membership for staff roles (or same org ACL for clients is N/A here).
  const membership = await prisma.tenantMembership.findFirst({
    where: { tenantId: input.tenantId, userId: user.id, status: 'ACTIVE' }
  });
  if (!membership && user.role === Role.CLIENT_USER) {
    const err: any = new Error('Cannot assign task to unauthorized user');
    err.status = 403;
    throw err;
  }
  const staffRoles: Role[] = [
    Role.ADMIN,
    Role.CREDENTIALING_MANAGER,
    Role.CREDENTIALING_SPECIALIST,
    Role.ENROLLMENT_SPECIALIST,
    Role.APPROVER
  ];
  if (!membership && !staffRoles.includes(user.role)) {
    const err: any = new Error('Cannot assign task to unauthorized user');
    err.status = 403;
    throw err;
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { assignedToId: user.id }
  });
  await prisma.taskAssignmentEvent.create({
    data: {
      taskId: task.id,
      fromUserId: task.assignedToId,
      toUserId: user.id,
      changedById: input.actorId,
      reason: input.reason || 'MANUAL_REASSIGN'
    }
  });
  await deliverAutomationNotification({
    tenantId: input.tenantId,
    userId: user.id,
    title: `Task assigned: ${task.title}`.slice(0, 120),
    body: 'A task was assigned to you.',
    type: 'TASK_ASSIGNED',
    entityType: 'task',
    entityId: task.id,
    href: '/tasks',
    dedupeKey: `task-assign:${task.id}:${user.id}:${Date.now()}`,
    organizationId: task.organizationId
  });
  return updated;
}

export { daysRemaining };
