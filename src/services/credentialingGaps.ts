import { Priority, TaskStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import {
  assessProviderReadiness,
  type ReadinessAudience,
  type ReadinessIssue
} from './credentialingReadiness';

export const GAP_SOURCE = 'CREDENTIALING_GAP';

export type GapDraft = {
  fingerprint: string;
  title: string;
  description: string;
  priority: Priority;
  relatedType?: string | null;
  relatedId?: string | null;
  category: string;
  recommendedAction: string;
  responsibleRole: string;
};

function fingerprintFor(providerId: string, issue: ReadinessIssue & { dimension?: string }) {
  const dim = issue.dimension || issue.section || 'profile';
  const rec = issue.recordId || 'none';
  return `gap:${providerId}:${issue.code}:${dim}:${rec}`;
}

function draftsFromAssessment(
  providerId: string,
  issues: Array<ReadinessIssue & { dimension?: string }>
): GapDraft[] {
  const seen = new Set<string>();
  const drafts: GapDraft[] = [];
  for (const issue of issues) {
    // Only actionable gaps — not pure informational pending that staff already track via review.
    const actionable =
      /incomplete|rejected|expired|quarantined|missing|none|untrusted|evidence/i.test(issue.code)
      || issue.priority === 'URGENT'
      || issue.priority === 'HIGH';
    if (!actionable) continue;
    const fp = fingerprintFor(providerId, issue);
    if (seen.has(fp)) continue;
    seen.add(fp);
    drafts.push({
      fingerprint: fp,
      title: issue.message.slice(0, 180),
      description: [
        issue.message,
        `Why: ${issue.whyItMatters}`,
        `Next: ${issue.recommendedAction}`,
        `Role: ${issue.responsibleRole}`
      ].join('\n'),
      priority: issue.priority as Priority,
      relatedType: issue.section || issue.dimension || null,
      relatedId: issue.recordId || null,
      category: issue.dimension || issue.section || 'credentialing',
      recommendedAction: issue.recommendedAction,
      responsibleRole: issue.responsibleRole
    });
  }
  return drafts;
}

/**
 * Sync credentialing gaps into Task rows.
 * - Upserts by (tenantId, fingerprint) — no duplicates on recalculation.
 * - Completes open gaps whose fingerprint is no longer present (underlying issue resolved).
 * - Never marks resolved solely from a UI click without reassessing data.
 */
export async function syncCredentialingGaps(
  tenantId: string,
  providerId: string,
  actorId?: string | null,
  audience: ReadinessAudience = 'gpa'
) {
  await assertProviderInTenant(tenantId, providerId);
  const assessment = await assessProviderReadiness(tenantId, providerId, audience);
  const drafts = draftsFromAssessment(providerId, assessment.issues);
  const draftMap = new Map(drafts.map((d) => [d.fingerprint, d]));

  const existing = await prisma.task.findMany({
    where: { tenantId, providerId, source: GAP_SOURCE }
  });

  const openStatuses: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];
  let created = 0;
  let updated = 0;
  let resolved = 0;

  await prisma.$transaction(async (tx) => {
    for (const draft of drafts) {
      const row = existing.find((e) => e.fingerprint === draft.fingerprint);
      if (!row) {
        await tx.task.create({
          data: {
            title: draft.title,
            description: draft.description,
            status: TaskStatus.OPEN,
            priority: draft.priority,
            tenantId,
            providerId,
            source: GAP_SOURCE,
            fingerprint: draft.fingerprint,
            relatedType: draft.relatedType,
            relatedId: draft.relatedId,
            createdById: actorId || null
          }
        });
        created += 1;
      } else if (openStatuses.includes(row.status)) {
        await tx.task.update({
          where: { id: row.id },
          data: {
            title: draft.title,
            description: draft.description,
            priority: draft.priority,
            relatedType: draft.relatedType,
            relatedId: draft.relatedId
          }
        });
        updated += 1;
      } else if (row.status === TaskStatus.COMPLETED || row.status === TaskStatus.CANCELLED) {
        // Issue returned — reopen rather than create a second fingerprint (unique constraint).
        await tx.task.update({
          where: { id: row.id },
          data: {
            status: TaskStatus.OPEN,
            title: draft.title,
            description: draft.description,
            priority: draft.priority,
            relatedType: draft.relatedType,
            relatedId: draft.relatedId
          }
        });
        updated += 1;
      }
    }

    for (const row of existing) {
      if (!row.fingerprint) continue;
      if (!openStatuses.includes(row.status)) continue;
      if (!draftMap.has(row.fingerprint)) {
        await tx.task.update({
          where: { id: row.id },
          data: { status: TaskStatus.COMPLETED }
        });
        resolved += 1;
      }
    }
  });

  return {
    assessment,
    sync: { created, updated, resolved, openCount: drafts.length },
    gaps: await listCredentialingGaps(tenantId, providerId, { includeResolved: false })
  };
}

export async function listCredentialingGaps(
  tenantId: string,
  providerId: string,
  opts: { includeResolved?: boolean } = {}
) {
  await assertProviderInTenant(tenantId, providerId);
  const statusFilter = opts.includeResolved
    ? undefined
    : { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] as TaskStatus[] };

  const rows = await prisma.task.findMany({
    where: {
      tenantId,
      providerId,
      source: GAP_SOURCE,
      ...(statusFilter ? { status: statusFilter } : {})
    },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    include: {
      assignedTo: { select: { id: true, name: true, email: true } }
    }
  });

  return rows.map((t) => ({
    id: t.id,
    providerId: t.providerId,
    tenantId: t.tenantId,
    category: t.relatedType,
    relatedType: t.relatedType,
    relatedId: t.relatedId,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    fingerprint: t.fingerprint,
    source: t.source,
    assignedTo: t.assignedTo,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    recommendedNextAction: (t.description || '').split('\n').find((l) => l.startsWith('Next:'))?.replace(/^Next:\s*/, '') || null
  }));
}

/**
 * Attempt to resolve a gap: reassess readiness; only complete the task if the fingerprint
 * is no longer produced. Cannot bypass underlying requirements.
 */
export async function attemptResolveGap(
  tenantId: string,
  providerId: string,
  taskId: string,
  actorId?: string | null
) {
  await assertProviderInTenant(tenantId, providerId);
  const task = await prisma.task.findFirst({
    where: { id: taskId, tenantId, providerId, source: GAP_SOURCE }
  });
  if (!task) {
    const err: any = new Error('Gap not found');
    err.status = 404;
    throw err;
  }

  const synced = await syncCredentialingGaps(tenantId, providerId, actorId);
  const stillOpen = synced.gaps.find((g) => g.id === taskId)
    || (await prisma.task.findUnique({ where: { id: taskId } }));

  if (stillOpen && (stillOpen as any).status !== TaskStatus.COMPLETED) {
    const err: any = new Error(
      'Gap cannot be marked resolved while the underlying readiness issue remains'
    );
    err.status = 409;
    err.code = 'GAP_STILL_OPEN';
    throw err;
  }

  return { resolved: true, taskId, sync: synced.sync };
}
