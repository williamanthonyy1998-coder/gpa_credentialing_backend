/**
 * Phase 5C — credential expiration calendar view over existing deadline records.
 * Does not create duplicate deadline rows.
 */
import { prisma } from '../lib/prisma';
import { listCredentialingDeadlines, type DeadlineItem } from './credentialingDeadlines';

export type CalendarEvent = DeadlineItem & {
  organizationId?: string | null;
  organizationName?: string | null;
  providerName?: string | null;
  payerId?: string | null;
  payerName?: string | null;
  assignedToId?: string | null;
  assignedToName?: string | null;
  alertStatus?: string | null;
  relatedTaskId?: string | null;
  href: string;
};

function startOfMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function startOfWeek(d: Date) {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday-start
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  s.setUTCDate(s.getUTCDate() - diff);
  return s;
}

function endOfWeek(d: Date) {
  const s = startOfWeek(d);
  return new Date(s.getTime() + 7 * 86400000 - 1);
}

export async function getCredentialExpirationCalendar(input: {
  tenantId: string;
  view?: 'month' | 'week' | 'upcoming';
  anchor?: Date;
  organizationId?: string;
  providerId?: string;
  category?: string;
  payerId?: string;
  status?: string;
  assignedToId?: string;
  from?: Date;
  to?: Date;
  organizationIds?: string[] | null;
}) {
  const view = input.view || 'month';
  const anchor = input.anchor || new Date();
  let from = input.from;
  let to = input.to;
  if (!from || !to) {
    if (view === 'week') {
      from = startOfWeek(anchor);
      to = endOfWeek(anchor);
    } else if (view === 'upcoming') {
      from = new Date();
      to = new Date(Date.now() + 120 * 86400000);
    } else {
      from = startOfMonth(anchor);
      to = endOfMonth(anchor);
    }
  }

  const withinDays = Math.max(
    1,
    Math.ceil((to.getTime() - Date.now()) / 86400000) + 1,
    Math.ceil((to.getTime() - from.getTime()) / 86400000) + 30
  );

  const { items, generatedAt } = await listCredentialingDeadlines({
    tenantId: input.tenantId,
    withinDays: Math.min(Math.max(withinDays, 120), 400),
    includeOverdue: true
  });

  const providerIds = [...new Set(items.map((i) => i.providerId).filter(Boolean))] as string[];
  const enrollmentIds = [...new Set(items.map((i) => i.enrollmentId).filter(Boolean))] as string[];
  const recordIds = items.map((i) => i.recordId);

  const [providers, enrollments, alerts, tasks] = await Promise.all([
    providerIds.length
      ? prisma.provider.findMany({
          where: { id: { in: providerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            organizations: {
              select: { organizationId: true, organization: { select: { id: true, legalName: true, dba: true } } },
              take: 3
            }
          }
        })
      : Promise.resolve([]),
    enrollmentIds.length
      ? prisma.enrollmentApplication.findMany({
          where: { id: { in: enrollmentIds }, tenantId: input.tenantId },
          select: {
            id: true,
            organizationId: true,
            organization: { select: { id: true, legalName: true, dba: true } },
            payerPlan: { select: { payerId: true, payer: { select: { id: true, name: true } } } }
          }
        })
      : Promise.resolve([]),
    prisma.automationAlert.findMany({
      where: {
        tenantId: input.tenantId,
        entityId: { in: recordIds },
        status: { in: ['PENDING', 'SENT', 'ACKNOWLEDGED'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 500
    }),
    prisma.task.findMany({
      where: {
        tenantId: input.tenantId,
        relatedId: { in: recordIds },
        source: 'CREDENTIALING_DEADLINE',
        status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }
      },
      select: { id: true, relatedId: true, assignedToId: true, assignedTo: { select: { id: true, name: true } } },
      take: 500
    })
  ]);

  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const enrollmentMap = new Map(enrollments.map((e) => [e.id, e]));
  const alertByEntity = new Map<string, (typeof alerts)[0]>();
  for (const a of alerts) {
    if (!alertByEntity.has(a.entityId)) alertByEntity.set(a.entityId, a);
  }
  const taskByRelated = new Map(tasks.map((t) => [t.relatedId!, t]));

  let events: CalendarEvent[] = [];
  for (const item of items) {
    const due = new Date(item.dueDate);
    if (due < from || due > to) continue;
    if (input.category && item.category !== input.category) continue;
    if (input.providerId && item.providerId !== input.providerId) continue;

    const provider = item.providerId ? providerMap.get(item.providerId) : null;
    const enrollment = item.enrollmentId ? enrollmentMap.get(item.enrollmentId) : null;
    const orgFromProvider = provider?.organizations?.[0]?.organization;
    const organizationId = enrollment?.organizationId || orgFromProvider?.id || null;
    const organizationName =
      enrollment?.organization?.dba
      || enrollment?.organization?.legalName
      || orgFromProvider?.dba
      || orgFromProvider?.legalName
      || null;

    if (input.organizationId && organizationId !== input.organizationId) continue;
    if (input.organizationIds && organizationId && !input.organizationIds.includes(organizationId)) continue;
    if (input.organizationIds && !organizationId) continue;

    const payerId = enrollment?.payerPlan?.payerId || null;
    const payerName = enrollment?.payerPlan?.payer?.name || null;
    if (input.payerId && payerId !== input.payerId) continue;

    const task = taskByRelated.get(item.recordId);
    if (input.assignedToId && task?.assignedToId !== input.assignedToId) continue;

    const alert = alertByEntity.get(item.recordId);
    if (input.status === 'overdue' && !item.overdue) continue;
    if (input.status === 'upcoming' && item.overdue) continue;
    if (input.status === 'alerted' && !alert) continue;

    let href = '/revalidation-ops';
    if (item.category === 'REVALIDATION' || item.enrollmentId) {
      href = item.enrollmentId ? `/enrollments?id=${item.enrollmentId}` : '/revalidation-ops';
    } else if (item.providerId) {
      href = `/providers/${item.providerId}/profile`;
    } else if (task?.id) {
      href = '/tasks';
    }

    events.push({
      ...item,
      organizationId,
      organizationName,
      providerName: provider ? `${provider.firstName || ''} ${provider.lastName || ''}`.trim() : null,
      payerId,
      payerName,
      assignedToId: task?.assignedToId || null,
      assignedToName: task?.assignedTo?.name || null,
      alertStatus: alert?.status || null,
      relatedTaskId: task?.id || null,
      href
    });
  }

  events.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.daysRemaining - b.daysRemaining);

  return {
    view,
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt,
    events,
    counts: {
      total: events.length,
      overdue: events.filter((e) => e.overdue).length,
      upcoming: events.filter((e) => !e.overdue).length
    }
  };
}
