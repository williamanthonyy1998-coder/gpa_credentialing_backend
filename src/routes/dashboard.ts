import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { getAuthorizedOrganizationIds } from '../services/orgAccess';
import {
  andWhere,
  listWhereForResource,
  providerInTenantWhere,
  requireTenantContext
} from '../services/tenantAccess';

const router = Router();

function intakeTenantWhere(tenantId: string) {
  return { OR: [{ tenantId }, { organization: { is: { tenantId } } }] };
}

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    const now = new Date();
    const soon = new Date(); soon.setDate(soon.getDate() + 30);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const orgWhere = orgIds.length ? { id: { in: orgIds }, tenantId } : { tenantId };
    const practiceOrg = orgIds.length ? { organizationId: { in: orgIds } } : { organization: { is: { tenantId } } };
    const facilityOrg = andWhere(
      listWhereForResource('facilities', tenantId)!,
      orgIds.length ? { OR: [{ organizationId: { in: orgIds } }, { practice: { is: { organizationId: { in: orgIds } } } }] } : {}
    );
    const enrollmentOrg = andWhere(
      listWhereForResource('enrollments', tenantId)!,
      orgIds.length ? { OR: [{ organizationId: { in: orgIds } }, { practice: { is: { organizationId: { in: orgIds } } } }] } : {}
    );
    const caseWhere = listWhereForResource('cases', tenantId)!;
    const taskWhere = andWhere(
      listWhereForResource('tasks', tenantId)!,
      orgIds.length ? { organizationId: { in: orgIds } } : {}
    );
    const documentWhere = andWhere(
      listWhereForResource('documents', tenantId)!,
      orgIds.length ? {
        OR: [
          { organizationId: { in: orgIds } },
          { practice: { is: { organizationId: { in: orgIds } } } }
        ]
      } : {}
    );
    const intakeWhere = intakeTenantWhere(tenantId);
    const providerWhere = providerInTenantWhere(tenantId);

    const [
      providers, activeProviders, organizations, practices, facilities, payers, employees,
      activeCases, pendingEnrollments, approvedEnrollments, rejectedEnrollments, overdueFollowUps,
      overdueTasks, myTasks, expiringDocuments, missingCredentials, pendingIntake,
      onLeaveToday, checkedInToday, cases, enrollments, tasks, recentAudit, upcomingFollowUps, expiringList
    ] = await Promise.all([
      prisma.provider.count({ where: providerWhere }),
      prisma.provider.count({ where: { AND: [providerWhere, { status: 'ACTIVE' }] } }),
      prisma.organization.count({ where: orgWhere }),
      prisma.practice.count({ where: practiceOrg }),
      prisma.facility.count({ where: facilityOrg! }),
      prisma.payer.count(),
      prisma.user.count({ where: { active: true } }),
      prisma.credentialingCase.count({ where: { AND: [caseWhere, { status: { notIn: ['APPROVED', 'REJECTED'] } }] } }),
      prisma.enrollmentApplication.count({ where: { AND: [enrollmentOrg!, { status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }] } }),
      prisma.enrollmentApplication.count({ where: { AND: [enrollmentOrg!, { status: 'APPROVED' }] } }),
      prisma.enrollmentApplication.count({ where: { AND: [enrollmentOrg!, { status: 'DENIED' }] } }),
      prisma.enrollmentApplication.count({
        where: { AND: [enrollmentOrg!, { nextFollowUpAt: { lt: now }, status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }] }
      }),
      prisma.task.count({ where: { AND: [taskWhere!, { status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }, dueAt: { lt: now } }] } }),
      prisma.task.count({
        where: {
          AND: [
            taskWhere!,
            { assignedToId: req.user!.id, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } }
          ]
        }
      }),
      prisma.document.count({ where: { AND: [documentWhere!, { expiresAt: { gte: now, lte: soon }, ignored: false }] } }),
      prisma.document.count({
        where: {
          AND: [
            documentWhere!,
            { OR: [{ status: 'MISSING' }, { required: true, storageKey: null }], ignored: false }
          ]
        }
      }),
      prisma.intakeRequest.count({ where: { AND: [intakeWhere, { status: { in: ['SENT', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW'] } }] } }),
      prisma.leaveRequest.count({
        where: { status: 'APPROVED', startDate: { lte: todayEnd }, endDate: { gte: todayStart } }
      }),
      prisma.attendanceRecord.count({ where: { workDate: todayStart, checkInAt: { not: null }, checkOutAt: null } }),
      prisma.credentialingCase.findMany({
        where: { AND: [caseWhere, { status: { notIn: ['APPROVED', 'REJECTED'] } }] },
        include: {
          provider: { select: { id: true, firstName: true, lastName: true, npi: true, primarySpecialty: true, status: true } },
          practice: { select: { id: true, name: true } }
        },
        orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
        take: 8
      }),
      prisma.enrollmentApplication.findMany({
        where: { AND: [enrollmentOrg!, { status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }] },
        include: {
          provider: { select: { id: true, firstName: true, lastName: true, npi: true, primarySpecialty: true, status: true } },
          organization: { select: { id: true, legalName: true } },
          facility: { select: { id: true, name: true } },
          payerPlan: { include: { payer: true } }
        },
        orderBy: [{ nextFollowUpAt: 'asc' }, { updatedAt: 'desc' }],
        take: 8
      }),
      prisma.task.findMany({
        where: { AND: [taskWhere!, { status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } }] },
        include: { assignedTo: { select: { id: true, name: true } } },
        orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
        take: 8
      }),
      prisma.auditEvent.findMany({
        where: { tenantId },
        select: {
          id: true, action: true, entityType: true, entityId: true, createdAt: true,
          actor: { select: { name: true, email: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),
      prisma.enrollmentApplication.findMany({
        where: {
          AND: [
            enrollmentOrg!,
            { nextFollowUpAt: { gte: now, lte: soon }, status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }
          ]
        },
        select: { id: true, applicationNo: true, nextFollowUpAt: true, status: true, assignedTo: true },
        orderBy: { nextFollowUpAt: 'asc' },
        take: 8
      }),
      prisma.document.findMany({
        where: { AND: [documentWhere!, { expiresAt: { gte: now, lte: soon }, ignored: false }] },
        select: { id: true, title: true, type: true, expiresAt: true, facilityId: true, providerId: true },
        orderBy: { expiresAt: 'asc' },
        take: 8
      })
    ]);

    const birthdayProviders = await prisma.provider.findMany({
      where: { AND: [providerWhere, { dateOfBirth: { not: null } }] },
      select: { id: true, firstName: true, lastName: true, dateOfBirth: true },
      take: 200
    });
    const month = now.getMonth();
    const day = now.getDate();
    const birthdays = birthdayProviders
      .filter(p => p.dateOfBirth && p.dateOfBirth.getMonth() === month && p.dateOfBirth.getDate() === day)
      .slice(0, 8)
      .map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, dateOfBirth: p.dateOfBirth }));

    const anniversaryOrgs = await prisma.organization.findMany({
      where: { establishedAt: { not: null }, ...orgWhere },
      select: { id: true, legalName: true, establishedAt: true },
      take: 200
    });
    const anniversaries = anniversaryOrgs
      .filter(o => o.establishedAt && o.establishedAt.getMonth() === month && o.establishedAt.getDate() === day)
      .slice(0, 8)
      .map(o => ({ id: o.id, name: o.legalName, establishedAt: o.establishedAt }));

    res.json({
      metrics: {
        providers,
        activeProviders,
        organizations,
        practices,
        facilities,
        payers,
        employees,
        activeCases,
        pendingEnrollments,
        approvedEnrollments,
        rejectedEnrollments,
        overdueFollowUps,
        overdueTasks,
        myTasks,
        expiringDocuments,
        missingCredentials,
        pendingIntake,
        onLeaveToday,
        checkedInToday
      },
      cases,
      enrollments,
      tasks,
      recentAudit,
      upcomingFollowUps,
      expiringList,
      birthdays,
      anniversaries
    });
  } catch (e) { next(e); }
});

export default router;
