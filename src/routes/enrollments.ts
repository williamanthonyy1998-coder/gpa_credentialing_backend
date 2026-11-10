import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EnrollmentStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { assertEnrollmentTransition, allowedEnrollmentTransitions, daysConsumed } from '../services/workflow';
import { getAuthorizedOrganizationIds } from '../services/orgAccess';
import { notifyUser } from '../services/notifications';

const router = Router();

const enrollmentInclude = {
  provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
  organization: { select: { id: true, legalName: true } },
  facility: { select: { id: true, name: true } },
  practice: { select: { id: true, name: true } },
  payerPlan: { include: { payer: true } },
  statusHistory: { orderBy: { createdAt: 'desc' as const }, take: 50 }
};

function enrich(row: any, role: Role) {
  if (!row) return row;
  const start = row.submittedAt || row.createdAt;
  return {
    ...row,
    daysConsumed: daysConsumed(start),
    allowedTransitions: allowedEnrollmentTransitions(row.status, role)
  };
}

function buildWhere(query: any, userEmail: string, orgIds: string[] | null) {
  const where: any = {};
  const and: any[] = [];
  const q = String(query.q || '').trim();
  if (q) {
    and.push({
      OR: [
        { applicationNo: { contains: q, mode: 'insensitive' } },
        { referenceNo: { contains: q, mode: 'insensitive' } },
        { assignedTo: { contains: q, mode: 'insensitive' } },
        { provider: { is: { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] } } },
        { organization: { is: { legalName: { contains: q, mode: 'insensitive' } } } }
      ]
    });
  }
  if (query.status) and.push({ status: String(query.status) });
  if (query.payerId) and.push({ payerPlan: { is: { payerId: String(query.payerId) } } });
  if (query.payerPlanId || query.planId) and.push({ payerPlanId: String(query.payerPlanId || query.planId) });
  if (query.providerId) and.push({ providerId: String(query.providerId) });
  if (query.organizationId) and.push({ organizationId: String(query.organizationId) });
  if (query.practiceId) and.push({ practiceId: String(query.practiceId) });
  if (query.facilityId) and.push({ facilityId: String(query.facilityId) });
  if (query.assignedTo) and.push({ assignedTo: { contains: String(query.assignedTo), mode: 'insensitive' } });
  if (query.mine === '1' || query.mine === 'true') and.push({ assignedTo: { equals: userEmail, mode: 'insensitive' } });
  if (query.overdue === '1' || query.overdue === 'true') {
    and.push({ nextFollowUpAt: { lt: new Date() }, status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } });
  }
  if (query.submittedFrom || query.submittedTo) {
    const submittedAt: any = {};
    if (query.submittedFrom) submittedAt.gte = new Date(String(query.submittedFrom));
    if (query.submittedTo) submittedAt.lte = new Date(String(query.submittedTo));
    and.push({ submittedAt });
  }
  if (query.followUpFrom || query.followUpTo) {
    const nextFollowUpAt: any = {};
    if (query.followUpFrom) nextFollowUpAt.gte = new Date(String(query.followUpFrom));
    if (query.followUpTo) nextFollowUpAt.lte = new Date(String(query.followUpTo));
    and.push({ nextFollowUpAt });
  }
  if (orgIds) {
    and.push({
      OR: [
        { organizationId: { in: orgIds } },
        { practice: { is: { organizationId: { in: orgIds } } } },
        { facility: { is: { OR: [{ organizationId: { in: orgIds } }, { practice: { is: { organizationId: { in: orgIds } } } }] } } }
      ]
    });
  }
  if (and.length) where.AND = and;
  return where;
}

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role);
    const base = buildWhere(req.query, req.user!.email, orgIds);
    const statuses = Object.values(EnrollmentStatus);
    const counts = await Promise.all(statuses.map(async status => ({
      status,
      count: await prisma.enrollmentApplication.count({ where: { AND: [base, { status }] } })
    })));
    const byStatus = Object.fromEntries(counts.map(c => [c.status, c.count]));
    const [total, overdueFollowUps, myCount, approved, denied, pending] = await Promise.all([
      prisma.enrollmentApplication.count({ where: base }),
      prisma.enrollmentApplication.count({
        where: { AND: [base, { nextFollowUpAt: { lt: new Date() }, status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }] }
      }),
      prisma.enrollmentApplication.count({
        where: { AND: [base, { assignedTo: { equals: req.user!.email, mode: 'insensitive' } }] }
      }),
      prisma.enrollmentApplication.count({ where: { AND: [base, { status: 'APPROVED' }] } }),
      prisma.enrollmentApplication.count({ where: { AND: [base, { status: 'DENIED' }] } }),
      prisma.enrollmentApplication.count({
        where: { AND: [base, { status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }] }
      })
    ]);
    res.json({ total, overdueFollowUps, myCount, approved, denied, pending, byStatus });
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role);
    const where = buildWhere(req.query, req.user!.email, orgIds);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || Number(req.query.limit) || 25));
    const [total, rows] = await Promise.all([
      prisma.enrollmentApplication.count({ where }),
      prisma.enrollmentApplication.findMany({
        where,
        include: enrollmentInclude,
        orderBy: [{ nextFollowUpAt: 'asc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ]);
    res.json({
      data: rows.map(r => enrich(r, req.user!.role)),
      total,
      page,
      pageSize
    });
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot create enrollments' });
    }
    const schema = z.object({
      applicationNo: z.string().min(1),
      providerId: z.string().optional().nullable(),
      organizationId: z.string().optional().nullable(),
      facilityId: z.string().optional().nullable(),
      practiceId: z.string().optional().nullable(),
      payerPlanId: z.string().min(1),
      status: z.nativeEnum(EnrollmentStatus).optional(),
      assignedTo: z.string().optional().nullable(),
      dueAt: z.coerce.date().optional().nullable(),
      submittedAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().optional().nullable(),
      lastFollowUpAt: z.coerce.date().optional().nullable(),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      effectiveAt: z.coerce.date().optional().nullable(),
      notes: z.string().optional().nullable(),
      checklist: z.any().optional()
    });
    const data: any = schema.parse(req.body);
    for (const k of Object.keys(data)) if (data[k] === '') data[k] = null;
    if (!data.organizationId && data.providerId && !data.practiceId && !data.facilityId) {
      const affiliations = await prisma.providerOrganization.findMany({
        where: { providerId: data.providerId, status: 'ACTIVE', OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
        select: { organizationId: true },
        take: 2
      });
      if (affiliations.length === 1) data.organizationId = affiliations[0].organizationId;
    }
    if (!data.providerId && !data.organizationId && !data.practiceId && !data.facilityId) {
      return res.status(400).json({ error: 'Enrollment must be linked to a provider, organization, practice, or facility' });
    }
    if (data.practiceId) {
      const practice = await prisma.practice.findUnique({ where: { id: data.practiceId }, select: { organizationId: true } });
      if (!practice) return res.status(400).json({ error: 'Selected practice was not found' });
      if (data.organizationId && data.organizationId !== practice.organizationId) {
        return res.status(400).json({ error: 'Enrollment organization must match the selected practice organization' });
      }
      if (!data.organizationId) data.organizationId = practice.organizationId;
    }
    if (data.facilityId) {
      const facility = await prisma.facility.findUnique({
        where: { id: data.facilityId },
        select: { organizationId: true, practice: { select: { organizationId: true } } }
      });
      if (!facility) return res.status(400).json({ error: 'Selected facility was not found' });
      const facilityOrg = facility.organizationId || facility.practice?.organizationId;
      if (data.organizationId && facilityOrg && data.organizationId !== facilityOrg) {
        return res.status(400).json({ error: 'Enrollment organization must match the selected facility organization' });
      }
      if (!data.organizationId && facilityOrg) data.organizationId = facilityOrg;
    }
    const row = await prisma.enrollmentApplication.create({ data, include: enrollmentInclude });
    await prisma.statusHistory.create({
      data: { enrollmentId: row.id, toStatus: row.status, changedBy: req.user!.id, reason: 'Enrollment created' }
    });
    if (row.assignedTo) {
      const assignee = await prisma.user.findFirst({ where: { email: { equals: row.assignedTo, mode: 'insensitive' } } });
      if (assignee) {
        await notifyUser({
          userId: assignee.id,
          title: 'Enrollment assigned',
          body: `${row.applicationNo} was assigned to you`,
          type: 'enrollment',
          entityType: 'enrollments',
          entityId: row.id,
          href: `/enrollments?edit=${row.id}`
        });
      }
    }
    await audit(req, 'CREATE', 'enrollments', row.id, undefined, row);
    res.status(201).json(enrich(row, req.user!.role));
  } catch (e) { next(e); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.enrollmentApplication.findUnique({ where: { id: req.params.id }, include: enrollmentInclude });
    if (!row) return res.status(404).json({ error: 'Enrollment not found' });
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role);
    if (orgIds) {
      const orgId = row.organizationId || (row as any).practice?.organizationId;
      if (orgId && !orgIds.includes(orgId)) return res.status(403).json({ error: 'You do not have access to this enrollment' });
    }
    res.json(enrich(row, req.user!.role));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot modify enrollments' });
    }
    const schema = z.object({
      status: z.nativeEnum(EnrollmentStatus).optional(),
      assignedTo: z.string().optional().nullable(),
      dueAt: z.coerce.date().optional().nullable(),
      submittedAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().optional().nullable(),
      lastFollowUpAt: z.coerce.date().optional().nullable(),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      effectiveAt: z.coerce.date().optional().nullable(),
      decisionAt: z.coerce.date().optional().nullable(),
      decisionReason: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      checklist: z.any().optional()
    });
    const data = schema.parse(req.body);
    const before = await prisma.enrollmentApplication.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Enrollment not found' });
    if (data.status && data.status !== before.status) {
      assertEnrollmentTransition(before.status, data.status, req.user!.role);
    }
    const row = await prisma.enrollmentApplication.update({
      where: { id: req.params.id },
      data,
      include: enrollmentInclude
    });
    if (data.status && data.status !== before.status) {
      await prisma.statusHistory.create({
        data: {
          enrollmentId: row.id,
          fromStatus: before.status,
          toStatus: data.status,
          changedBy: req.user!.id,
          reason: data.decisionReason || 'Status updated'
        }
      });
    }
    if (data.assignedTo && data.assignedTo !== before.assignedTo) {
      const assignee = await prisma.user.findFirst({ where: { email: { equals: data.assignedTo, mode: 'insensitive' } } });
      if (assignee) {
        await notifyUser({
          userId: assignee.id,
          title: 'Enrollment assigned',
          body: `${row.applicationNo} was assigned to you`,
          type: 'enrollment',
          entityType: 'enrollments',
          entityId: row.id,
          href: `/enrollments?edit=${row.id}`
        });
      }
    }
    await audit(req, 'UPDATE', 'enrollments', row.id, before, row);
    res.json(enrich(row, req.user!.role));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/bulk-assign', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.ENROLLMENT_SPECIALIST), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = z.object({
      ids: z.array(z.string().min(1)).min(1).max(100),
      assignedTo: z.string().min(1)
    }).parse(req.body);
    const result = await prisma.enrollmentApplication.updateMany({
      where: { id: { in: input.ids } },
      data: { assignedTo: input.assignedTo }
    });
    const assignee = await prisma.user.findFirst({ where: { email: { equals: input.assignedTo, mode: 'insensitive' } } });
    if (assignee) {
      await notifyUser({
        userId: assignee.id,
        title: 'Enrollments assigned',
        body: `${result.count} enrollment(s) were assigned to you`,
        type: 'enrollment',
        href: '/enrollments?mine=1'
      });
    }
    await audit(req, 'BULK_ASSIGN', 'enrollments', undefined, undefined, { ids: input.ids, assignedTo: input.assignedTo, count: result.count });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

export default router;
