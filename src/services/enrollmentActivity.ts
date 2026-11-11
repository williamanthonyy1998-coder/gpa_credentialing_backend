import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { notifyUser, notifyUsers } from './notifications';
import { getAuthorizedOrganizationIds } from './orgAccess';

export const ENROLLMENT_ACTIVITY_TYPES = [
  'MESSAGE',
  'FOLLOW_UP_COMPLETED',
  'FOLLOW_UP_SCHEDULED',
  'STATUS_CHANGE',
  'APPROVAL_UPDATE',
  'ASSIGNMENT',
  'SYSTEM'
] as const;

export type EnrollmentActivityType = (typeof ENROLLMENT_ACTIVITY_TYPES)[number];

type Db = typeof prisma;

const WRITE_BLOCKED: Role[] = [Role.READ_ONLY, Role.AUDITOR];
const MANAGER_ROLES: Role[] = [Role.ADMIN, Role.CREDENTIALING_MANAGER];

export function canWriteEnrollmentActivity(role: Role) {
  return !WRITE_BLOCKED.includes(role);
}

export function canEditEnrollmentActivity(role: Role, authorId: string | null | undefined, userId: string) {
  if (WRITE_BLOCKED.includes(role)) return false;
  if (MANAGER_ROLES.includes(role)) return true;
  return !!authorId && authorId === userId;
}

export function canDeleteEnrollmentActivity(role: Role, authorId: string | null | undefined, userId: string) {
  return canEditEnrollmentActivity(role, authorId, userId);
}

export const activityInclude = {
  author: { select: { id: true, name: true, email: true } },
  attachments: {
    include: {
      document: {
        select: {
          id: true,
          title: true,
          type: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          storageKey: true,
          createdAt: true
        }
      }
    }
  }
} as const;

export async function loadEnrollmentForAccess(enrollmentId: string, userId: string, role: Role) {
  const row = await prisma.enrollmentApplication.findUnique({
    where: { id: enrollmentId },
    include: {
      practice: { select: { organizationId: true } },
      facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } },
      approvalDetails: {
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          updatedBy: { select: { id: true, name: true, email: true } }
        }
      }
    }
  });
  if (!row) {
    const err: any = new Error('Enrollment not found');
    err.status = 404;
    throw err;
  }
  const orgIds = await getAuthorizedOrganizationIds(userId, role);
  if (orgIds) {
    const orgId = row.organizationId
      || row.practice?.organizationId
      || row.facility?.organizationId
      || row.facility?.practice?.organizationId
      || null;
    if (orgId && !orgIds.includes(orgId)) {
      const err: any = new Error('You do not have access to this enrollment');
      err.status = 403;
      throw err;
    }
  }
  return row;
}

export async function resolveEnrollmentStakeholderIds(
  enrollment: { assignedTo?: string | null; organizationId?: string | null },
  actorId?: string | null,
  db: Db = prisma
): Promise<string[]> {
  const ids = new Set<string>();
  if (enrollment.assignedTo) {
    const assignee = await db.user.findFirst({
      where: { email: { equals: enrollment.assignedTo, mode: 'insensitive' }, active: true },
      select: { id: true }
    });
    if (assignee?.id) ids.add(assignee.id);
  }

  if (enrollment.organizationId) {
    const managers = await db.user.findMany({
      where: {
        active: true,
        role: { in: MANAGER_ROLES },
        organizations: { some: { organizationId: enrollment.organizationId } }
      },
      select: { id: true }
    });
    for (const m of managers) ids.add(m.id);
  }

  if (actorId) ids.delete(actorId);
  return [...ids];
}

export async function notifyEnrollmentStakeholders(
  enrollment: { id: string; applicationNo: string; assignedTo?: string | null; organizationId?: string | null },
  actorId: string | null | undefined,
  payload: { title: string; body?: string; type?: string }
) {
  const userIds = await resolveEnrollmentStakeholderIds(enrollment, actorId);
  if (!userIds.length) return;
  await notifyUsers(userIds, {
    title: payload.title,
    body: payload.body,
    type: payload.type || 'enrollment',
    entityType: 'enrollments',
    entityId: enrollment.id,
    href: `/enrollments?activity=${enrollment.id}`
  });
}

/** Create overdue follow-up notifications for the current user without duplicates. */
export async function ensureOverdueFollowUpNotifications(userEmail: string, userId: string) {
  const overdue = await prisma.enrollmentApplication.findMany({
    where: {
      assignedTo: { equals: userEmail, mode: 'insensitive' },
      nextFollowUpAt: { lt: new Date() },
      status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] }
    },
    select: { id: true, applicationNo: true, nextFollowUpAt: true },
    take: 50
  });
  if (!overdue.length) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.notification.findMany({
    where: {
      userId,
      type: 'enrollment_followup_overdue',
      entityType: 'enrollments',
      entityId: { in: overdue.map(e => e.id) },
      createdAt: { gte: since }
    },
    select: { entityId: true }
  });
  const already = new Set(existing.map(n => n.entityId).filter(Boolean));
  await Promise.all(
    overdue
      .filter(e => !already.has(e.id))
      .map(e => notifyUser({
        userId,
        title: 'Enrollment follow-up overdue',
        body: `${e.applicationNo} follow-up was due ${e.nextFollowUpAt ? new Date(e.nextFollowUpAt).toLocaleDateString() : ''}`.trim(),
        type: 'enrollment_followup_overdue',
        entityType: 'enrollments',
        entityId: e.id,
        href: `/enrollments?activity=${e.id}`
      }))
  );
}

export async function unreadActivityCountForUser(enrollmentId: string, userId: string) {
  const activities = await prisma.enrollmentActivity.findMany({
    where: {
      enrollmentId,
      deletedAt: null,
      OR: [{ authorId: null }, { authorId: { not: userId } }]
    },
    select: { id: true }
  });
  if (!activities.length) return 0;
  const read = await prisma.enrollmentActivityRead.count({
    where: {
      userId,
      activityId: { in: activities.map(a => a.id) }
    }
  });
  return Math.max(0, activities.length - read);
}

export async function markEnrollmentActivitiesRead(enrollmentId: string, userId: string) {
  const activities = await prisma.enrollmentActivity.findMany({
    where: { enrollmentId, deletedAt: null },
    select: { id: true }
  });
  if (!activities.length) return { marked: 0 };
  const ops = activities.map(a =>
    prisma.enrollmentActivityRead.upsert({
      where: { activityId_userId: { activityId: a.id, userId } },
      create: { activityId: a.id, userId },
      update: { readAt: new Date() }
    })
  );
  await prisma.$transaction(ops);
  return { marked: activities.length };
}
