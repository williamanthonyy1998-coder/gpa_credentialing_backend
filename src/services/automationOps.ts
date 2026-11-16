/**
 * Phase 5C — GPA automation operations visibility (no secrets).
 */
import { prisma } from '../lib/prisma';
import {
  automationSchedulerIntervalMs,
  isAutomationSchedulerEnabled
} from './automationScheduler';

function redactError(msg?: string | null) {
  if (!msg) return null;
  return String(msg)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]')
    .slice(0, 500);
}

export async function getAutomationOpsVisibility(input: {
  tenantId: string;
  organizationId?: string;
  jobType?: string;
  status?: string;
  from?: Date;
  to?: Date;
}) {
  const enabled = isAutomationSchedulerEnabled();
  const intervalMs = automationSchedulerIntervalMs();

  const runWhere: any = {
    OR: [{ tenantId: input.tenantId }, { jobType: 'GLOBAL_AUTOMATION_TICK' }]
  };
  if (input.jobType) runWhere.jobType = input.jobType;
  if (input.status) runWhere.status = input.status;
  if (input.from || input.to) {
    runWhere.startedAt = {};
    if (input.from) runWhere.startedAt.gte = input.from;
    if (input.to) runWhere.startedAt.lte = input.to;
  }

  const [
    lastRun,
    successful,
    failed,
    locks,
    failedDeliveries,
    pendingRetries,
    recentRuns,
    followUpTasks,
    escalations,
    expiryAlerts,
    slaCount
  ] = await Promise.all([
    prisma.automationJobRun.findFirst({
      where: { OR: [{ tenantId: input.tenantId }, { jobType: 'GLOBAL_AUTOMATION_TICK' }] },
      orderBy: { startedAt: 'desc' }
    }),
    prisma.automationJobRun.count({
      where: { ...runWhere, status: 'SUCCEEDED' }
    }),
    prisma.automationJobRun.count({
      where: { ...runWhere, status: 'FAILED' }
    }),
    prisma.automationJobLock.findMany({
      where: { lockedUntil: { gt: new Date() } },
      select: { lockKey: true, lockedUntil: true, updatedAt: true }
    }),
    prisma.notificationDelivery.count({
      where: { channel: 'EMAIL', status: 'FAILED' }
    }),
    prisma.notificationDelivery.count({
      where: {
        channel: 'EMAIL',
        status: { in: ['FAILED', 'RETRYING'] },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }]
      }
    }),
    prisma.automationJobRun.findMany({
      where: runWhere,
      orderBy: { startedAt: 'desc' },
      take: 40,
      select: {
        id: true,
        jobType: true,
        tenantId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        triggeredBy: true,
        errorMessage: true,
        result: true
      }
    }),
    prisma.task.count({
      where: {
        tenantId: input.tenantId,
        source: 'ENROLLMENT_FOLLOWUP',
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        createdAt: { gte: new Date(Date.now() - 7 * 86400000) }
      }
    }),
    prisma.escalationRecord.count({
      where: {
        tenantId: input.tenantId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        createdAt: { gte: new Date(Date.now() - 7 * 86400000) }
      }
    }),
    prisma.automationAlert.count({
      where: {
        tenantId: input.tenantId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        createdAt: { gte: new Date(Date.now() - 7 * 86400000) }
      }
    }),
    prisma.workflowSlaRecord.count({
      where: {
        tenantId: input.tenantId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        updatedAt: { gte: new Date(Date.now() - 7 * 86400000) }
      }
    })
  ]);

  const nextExpected = lastRun?.startedAt
    ? new Date(new Date(lastRun.startedAt).getTime() + intervalMs)
    : (enabled ? new Date(Date.now() + intervalMs) : null);

  const failedDeliveryRows = await prisma.notificationDelivery.findMany({
    where: { channel: 'EMAIL', status: { in: ['FAILED', 'RETRYING'] } },
    orderBy: { updatedAt: 'desc' },
    take: 25,
    select: {
      id: true,
      userId: true,
      status: true,
      attemptCount: true,
      lastError: true,
      nextRetryAt: true,
      payloadSummary: true,
      updatedAt: true
    }
  });

  return {
    scheduler: {
      enabled,
      intervalMs,
      lastExecutionAt: lastRun?.startedAt || null,
      lastExecutionStatus: lastRun?.status || null,
      nextExpectedAt: nextExpected,
      note: enabled
        ? 'Scheduler is enabled for this process. Multi-instance safety uses AutomationJobLock.'
        : 'Scheduler disabled. Set AUTOMATION_SCHEDULER_ENABLED=1 in production after runbook review.'
    },
    counts: {
      successfulJobRuns: successful,
      failedJobRuns: failed,
      activeLocks: locks.length,
      failedNotificationDeliveries: failedDeliveries,
      pendingEmailRetries: pendingRetries,
      followUpsGenerated7d: followUpTasks,
      escalationsGenerated7d: escalations,
      expiryAlertsGenerated7d: expiryAlerts,
      slaRecordsRefreshed7d: slaCount
    },
    activeLocks: locks.map((l) => ({
      lockKey: l.lockKey,
      lockedUntil: l.lockedUntil,
      updatedAt: l.updatedAt
    })),
    recentRuns: recentRuns.map((r) => ({
      ...r,
      errorMessage: redactError(r.errorMessage),
      // Strip potentially large/sensitive nested payloads; keep counts only when object
      result: summarizeResult(r.result)
    })),
    failedDeliveries: failedDeliveryRows.map((d) => ({
      ...d,
      lastError: redactError(d.lastError)
    }))
  };
}

function summarizeResult(result: unknown) {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(v as object)) {
        if (typeof nv === 'number' || typeof nv === 'boolean' || typeof nv === 'string') {
          nested[nk] = typeof nv === 'string' ? String(nv).slice(0, 80) : nv;
        }
      }
      out[k] = nested;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = { length: v.length };
    }
  }
  return out;
}
