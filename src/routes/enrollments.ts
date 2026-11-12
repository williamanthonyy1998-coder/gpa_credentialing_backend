import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EnrollmentStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { allowedEnrollmentTransitions, daysConsumed } from '../services/workflow';
import {
  assertNoDuplicateActiveEnrollment,
  computeEnrollmentAttention,
  validateEnrollmentRelationships
} from '../services/enrollmentLifecycle';
import { getAuthorizedOrganizationIds } from '../services/orgAccess';
import {
  andWhere,
  assertRecordInTenant,
  assertRelatedRecordsSameTenant,
  listWhereForResource,
  requireTenantContext
} from '../services/tenantAccess';
import { notifyUser } from '../services/notifications';
import {
  AssigneeUser,
  enrollmentAssigneeDisplayName,
  enrollmentFacilityDisplayName,
  enrollmentProviderDisplayName,
  enrollmentSubjectDisplay,
  generateApplicationNo,
  loadAssigneeMap,
  resolveEnrollmentLinks
} from '../services/enrollments';
import { assertPayerPlanAssignable } from '../services/directoryIntegration';
import {
  ensureOverdueFollowUpNotifications,
  notifyEnrollmentStakeholders,
  unreadActivityCountForUser
} from '../services/enrollmentActivity';
import enrollmentActivityRoutes from './enrollmentActivity';

const router = Router();

const enrollmentInclude = {
  provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
  organization: { select: { id: true, legalName: true, dba: true } },
  facility: { select: { id: true, name: true } },
  practice: { select: { id: true, name: true } },
  payerPlan: { include: { payer: true } },
  statusHistory: { orderBy: { createdAt: 'desc' as const }, take: 50 },
  approvalDetails: {
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      updatedBy: { select: { id: true, name: true, email: true } }
    }
  }
};

function enrich(row: any, role: Role, usersByEmail?: Map<string, AssigneeUser>, extras?: { unreadActivityCount?: number }) {
  if (!row) return row;
  const start = row.submittedAt || row.createdAt;
  const assigneeKey = String(row.assignedTo || '').trim().toLowerCase();
  const assignedToUser = assigneeKey && usersByEmail?.get(assigneeKey) ? usersByEmail.get(assigneeKey)! : null;
  return {
    ...row,
    subjectDisplay: enrollmentSubjectDisplay(row),
    facilityName: enrollmentFacilityDisplayName(row),
    providerName: enrollmentProviderDisplayName(row),
    payerName: row.payerPlan?.payer?.name || null,
    planName: row.payerPlan?.name || null,
    daysConsumed: daysConsumed(start),
    highlighted: Boolean(row.highlighted),
    assigneeName: enrollmentAssigneeDisplayName(row.assignedTo, usersByEmail),
    assignedToUser,
    attention: computeEnrollmentAttention(row),
    allowedTransitions: allowedEnrollmentTransitions(row.status, role),
    unreadActivityCount: extras?.unreadActivityCount ?? row.unreadActivityCount ?? 0,
    hasApprovalDetails: Boolean(row.approvalDetails?.id || row.referenceNo || row.effectiveAt),
    // GPA-only internal notes
    ...(role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER
      ? { internalNotes: undefined, notes: row.notes }
      : {})
  };
}

function buildWhere(query: any, userEmail: string, tenantId: string, orgIds: string[]) {
  const where: any = {};
  const tenantScope = listWhereForResource('enrollments', tenantId);
  const and: any[] = tenantScope ? [tenantScope] : [];
  const q = String(query.q || '').trim();
  if (q) {
    and.push({
      OR: [
        { applicationNo: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
        { referenceNo: { contains: q, mode: 'insensitive' } },
        { assignedTo: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
        { provider: { is: { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] } } },
        { facility: { is: { name: { contains: q, mode: 'insensitive' } } } },
        { practice: { is: { name: { contains: q, mode: 'insensitive' } } } },
        { organization: { is: { legalName: { contains: q, mode: 'insensitive' } } } },
        { payerPlan: { is: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { payer: { is: { name: { contains: q, mode: 'insensitive' } } } }] } } }
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
  if (orgIds.length) {
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

router.use(enrollmentActivityRoutes);

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await ensureOverdueFollowUpNotifications(req.user!.email, req.user!.id).catch(() => {});
    const tenantId = req.tenantContext!.tenantId;
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const base = buildWhere(req.query, req.user!.email, tenantId, orgIds);
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
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const where = buildWhere(req.query, req.user!.email, tenantId, orgIds);
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
    const usersByEmail = await loadAssigneeMap(rows.map(r => r.assignedTo));
    const unreadCounts = await Promise.all(rows.map(r => unreadActivityCountForUser(r.id, req.user!.id)));
    res.json({
      data: rows.map((r, i) => enrich(r, req.user!.role, usersByEmail, { unreadActivityCount: unreadCounts[i] })),
      total,
      page,
      pageSize
    });
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot create enrollments' });
    }
    const schema = z.object({
      // applicationNo is generated server-side; ignore client-supplied values
      applicationNo: z.string().optional().nullable(),
      subject: z.string().optional().nullable(),
      payerId: z.string().optional().nullable(),
      providerId: z.string().optional().nullable(),
      organizationId: z.string().optional().nullable(),
      facilityId: z.string().min(1, 'Facility is required'),
      practiceId: z.string().optional().nullable(),
      payerPlanId: z.string().min(1, 'Payer plan is required'),
      enrollmentType: z.enum(['INDIVIDUAL', 'GROUP', 'FACILITY', 'REASSIGNMENT', 'OTHER']).optional(),
      billingEntityId: z.string().optional().nullable(),
      assignedTo: z.string().optional().nullable(),
      dueAt: z.coerce.date().optional().nullable(),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      notes: z.string().optional().nullable(),
      checklist: z.any().optional(),
      highlighted: z.boolean().optional()
    });
    const parsed: any = schema.parse(req.body);
    for (const k of Object.keys(parsed)) if (parsed[k] === '') parsed[k] = null;

    if (!parsed.payerId && !parsed.payerPlanId) {
      return res.status(400).json({ error: 'Payer and payer plan are required' });
    }

    await assertPayerPlanAssignable(parsed.payerPlanId, { requireActive: true });

    const links = await resolveEnrollmentLinks({
      facilityId: parsed.facilityId,
      practiceId: parsed.practiceId,
      organizationId: parsed.organizationId,
      providerId: parsed.providerId,
      payerPlanId: parsed.payerPlanId,
      payerId: parsed.payerId
    });

    await assertRelatedRecordsSameTenant(tenantId, {
      organizationId: links.organizationId,
      practiceId: links.practiceId,
      facilityId: links.facilityId,
      providerId: links.providerId
    });

    await validateEnrollmentRelationships({
      tenantId,
      providerId: links.providerId,
      organizationId: links.organizationId,
      practiceId: links.practiceId,
      facilityId: links.facilityId,
      billingEntityId: parsed.billingEntityId,
      payerPlanId: links.payerPlanId,
      payerId: parsed.payerId
    });

    await assertNoDuplicateActiveEnrollment({
      tenantId,
      providerId: links.providerId,
      payerPlanId: links.payerPlanId,
      facilityId: links.facilityId
    });

    const row = await prisma.$transaction(async (tx) => {
      const applicationNo = await generateApplicationNo(tx);
      const created = await tx.enrollmentApplication.create({
        data: {
          tenantId,
          applicationNo,
          subject: parsed.subject || null,
          providerId: links.providerId,
          organizationId: links.organizationId,
          facilityId: links.facilityId,
          practiceId: links.practiceId,
          billingEntityId: parsed.billingEntityId || null,
          enrollmentType: parsed.enrollmentType || 'INDIVIDUAL',
          payerPlanId: links.payerPlanId,
          // Always start as draft — lifecycle endpoints record submission/approval/effective.
          status: EnrollmentStatus.NOT_STARTED,
          assignedTo: parsed.assignedTo || null,
          dueAt: parsed.dueAt || null,
          nextFollowUpAt: parsed.nextFollowUpAt || null,
          notes: parsed.notes || null,
          checklist: parsed.checklist || undefined,
          highlighted: Boolean(parsed.highlighted)
        },
        include: enrollmentInclude
      });
      await tx.statusHistory.create({
        data: {
          enrollmentId: created.id,
          toStatus: created.status,
          changedBy: req.user!.id,
          actorRole: req.user!.role,
          eventType: 'ENROLLMENT_CREATED',
          reason: 'Enrollment created'
        }
      });
      return created;
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
          href: `/enrollments?activity=${row.id}`
        });
      }
    }
    const usersByEmail = await loadAssigneeMap([row.assignedTo]);
    await audit(req, 'CREATE', 'enrollments', row.id, undefined, row);
    res.status(201).json(enrich(row, req.user!.role, usersByEmail));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const row = await prisma.enrollmentApplication.findUnique({ where: { id: req.params.id }, include: enrollmentInclude });
    if (!row) return res.status(404).json({ error: 'Enrollment not found' });
    const orgId = row.organizationId || (row as any).practice?.organizationId;
    if (orgId && orgIds.length && !orgIds.includes(orgId)) return res.status(404).json({ error: 'Enrollment not found' });
    const usersByEmail = await loadAssigneeMap([row.assignedTo]);
    const unreadActivityCount = await unreadActivityCountForUser(row.id, req.user!.id);
    res.json(enrich(row, req.user!.role, usersByEmail, { unreadActivityCount }));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot modify enrollments' });
    }
    const isClient = req.user!.role === Role.CLIENT_USER;
    const schema = z.object({
      subject: z.string().optional().nullable(),
      assignedTo: z.string().optional().nullable(),
      dueAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().optional().nullable(),
      lastFollowUpAt: z.coerce.date().optional().nullable(),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      revalidationAt: z.coerce.date().optional().nullable(),
      notes: z.string().optional().nullable(),
      internalNotes: z.string().optional().nullable(),
      checklist: z.any().optional(),
      enrollmentType: z.enum(['INDIVIDUAL', 'GROUP', 'FACILITY', 'REASSIGNMENT', 'OTHER']).optional(),
      billingEntityId: z.string().optional().nullable(),
      // Highlight/alert flag — must never alter status by itself
      highlighted: z.boolean().optional(),
      // Relationship updates are allowed but must keep facility when clearing provider
      providerId: z.string().optional().nullable(),
      facilityId: z.string().optional().nullable(),
      practiceId: z.string().optional().nullable(),
      payerPlanId: z.string().optional(),
      payerId: z.string().optional().nullable()
    });
    const data: any = schema.parse(req.body);
    for (const k of Object.keys(data)) if (data[k] === '') data[k] = null;
    // GPA-only field — never accept from client/external roles (SEC-04)
    if (isClient || req.user!.role === Role.EXTERNAL_PROVIDER) {
      const restrictedAttempted: string[] = [];
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'internalNotes')) {
        restrictedAttempted.push('internalNotes');
      }
      delete data.internalNotes;
      if (restrictedAttempted.length) {
        await audit(req, 'restricted_field_write_attempt', 'enrollments', req.params.id, undefined, {
          fields: restrictedAttempted,
          role: req.user!.role
        });
      }
    }

    // Lifecycle status changes must use dedicated endpoints (Phase 4A).
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'submittedAt')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'effectiveAt')
      || Object.prototype.hasOwnProperty.call(req.body || {}, 'decisionAt')) {
      return res.status(400).json({
        error: 'Use /api/enrollments/:id/prepare|ready|submit|acknowledge|approve|effective|reject|terminate for lifecycle changes',
        code: 'LIFECYCLE_ENDPOINT_REQUIRED'
      });
    }

    const before = await prisma.enrollmentApplication.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Enrollment not found' });
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const beforeOrgId = before.organizationId;
    if (beforeOrgId && orgIds.length && !orgIds.includes(beforeOrgId)) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    const relationshipTouched = ['providerId', 'facilityId', 'practiceId', 'payerPlanId', 'payerId']
      .some(k => Object.prototype.hasOwnProperty.call(data, k));

    if (relationshipTouched) {
      const facilityId = data.facilityId !== undefined ? data.facilityId : before.facilityId;
      if (!facilityId) {
        return res.status(400).json({ error: 'Facility is required' });
      }
      const nextPlanId = data.payerPlanId || before.payerPlanId;
      if (data.payerPlanId && data.payerPlanId !== before.payerPlanId) {
        await assertPayerPlanAssignable(String(data.payerPlanId), { requireActive: true });
      }
      const links = await resolveEnrollmentLinks({
        facilityId,
        practiceId: data.practiceId !== undefined ? data.practiceId : before.practiceId,
        organizationId: before.organizationId,
        providerId: data.providerId !== undefined ? data.providerId : before.providerId,
        payerPlanId: nextPlanId,
        payerId: data.payerId
      });
      data.facilityId = links.facilityId;
      data.practiceId = links.practiceId;
      data.organizationId = links.organizationId;
      data.providerId = links.providerId;
      data.payerPlanId = links.payerPlanId;
      delete data.payerId;
      await assertRelatedRecordsSameTenant(tenantId, {
        organizationId: links.organizationId,
        practiceId: links.practiceId,
        facilityId: links.facilityId,
        providerId: links.providerId
      });
    }

    // Never allow client to change applicationNo; highlighting must not mutate status
    delete data.applicationNo;
    if (Object.prototype.hasOwnProperty.call(data, 'highlighted') && Object.keys(data).length === 1) {
      // status intentionally untouched when only toggling highlight
    }

    const assigneeChanging = Object.prototype.hasOwnProperty.call(data, 'assignedTo')
      && data.assignedTo !== before.assignedTo;

    if (data.billingEntityId) {
      await validateEnrollmentRelationships({
        tenantId,
        providerId: before.providerId,
        organizationId: before.organizationId,
        practiceId: before.practiceId,
        facilityId: before.facilityId,
        billingEntityId: data.billingEntityId,
        payerPlanId: before.payerPlanId
      });
    }

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.enrollmentApplication.update({
        where: { id: req.params.id },
        data,
        include: enrollmentInclude
      });
      if (assigneeChanging) {
        await tx.enrollmentActivity.create({
          data: {
            enrollmentId: updated.id,
            authorId: req.user!.id,
            body: data.assignedTo
              ? `Assigned to ${data.assignedTo}`
              : 'Assignee cleared',
            activityType: 'ASSIGNMENT',
            metadata: {
              previousAssignedTo: before.assignedTo,
              assignedTo: data.assignedTo
            }
          }
        });
      }
      return updated;
    });

    if (assigneeChanging && data.assignedTo) {
      const assignee = await prisma.user.findFirst({ where: { email: { equals: data.assignedTo, mode: 'insensitive' } } });
      if (assignee && assignee.id !== req.user!.id) {
        await notifyUser({
          userId: assignee.id,
          title: 'Enrollment assigned',
          body: `${row.applicationNo} was assigned to you`,
          type: 'enrollment',
          entityType: 'enrollments',
          entityId: row.id,
          href: `/enrollments?activity=${row.id}`
        });
      }
    }
    const usersByEmail = await loadAssigneeMap([row.assignedTo]);
    const unreadActivityCount = await unreadActivityCountForUser(row.id, req.user!.id);
    const action = Object.prototype.hasOwnProperty.call(data, 'highlighted')
      && Object.keys(data).every(k => k === 'highlighted')
      ? (data.highlighted ? 'HIGHLIGHT' : 'UNHIGHLIGHT')
      : 'UPDATE';
    await audit(req, action, 'enrollments', row.id, before, row);
    res.json(enrich(row, req.user!.role, usersByEmail, { unreadActivityCount }));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/bulk-assign', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.ENROLLMENT_SPECIALIST), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    const tenantScope = listWhereForResource('enrollments', tenantId);
    const input = z.object({
      ids: z.array(z.string().min(1)).min(1).max(100),
      assignedTo: z.string().min(1)
    }).parse(req.body);
    for (const id of input.ids) {
      await assertRecordInTenant(req.tenantContext!, 'enrollments', id);
    }
    const result = await prisma.enrollmentApplication.updateMany({
      where: andWhere({ id: { in: input.ids } }, tenantScope)!,
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
    if (input.ids.length) {
      const now = new Date();
      await prisma.enrollmentActivity.createMany({
        data: input.ids.map(enrollmentId => ({
          enrollmentId,
          authorId: req.user!.id,
          body: `Assigned to ${input.assignedTo}`,
          activityType: 'ASSIGNMENT',
          metadata: { assignedTo: input.assignedTo, bulk: true },
          createdAt: now,
          updatedAt: now
        }))
      });
    }
    await audit(req, 'BULK_ASSIGN', 'enrollments', undefined, undefined, { ids: input.ids, assignedTo: input.assignedTo, count: result.count });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

export default router;
