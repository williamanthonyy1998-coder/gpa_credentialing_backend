import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  AutomationPolicyKind,
  Role
} from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import {
  canManageAutomationPolicies,
  canReadAutomation,
  canRunAutomationJobs,
  ensureDefaultPoliciesForTenant,
  listPolicies,
  upsertPolicy
} from '../services/automationPolicies';
import {
  getAutomationDashboard,
  reassignTask,
  runTenantAutomationSweep
} from '../services/automationEngine';
import { getCredentialExpirationCalendar } from '../services/credentialExpirationCalendar';
import { getAutomationOpsVisibility } from '../services/automationOps';
import { getOrgRestrictionIds } from '../services/orgAccess';
import { ENROLLMENT_FOLLOWUP_SOURCE } from '../services/enrollmentLifecycle';
import { TaskStatus } from '@prisma/client';

const router = Router();

function deny(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function requireTenant(req: AuthRequest) {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    const err: any = new Error('Tenant context required');
    err.status = 400;
    throw err;
  }
  return tenantId;
}

router.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReadAutomation(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const organizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;
    const data = await getAutomationDashboard(tenantId, {
      userId: req.user!.id,
      organizationId
    });
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/queues/:queue', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReadAutomation(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const queue = String(req.params.queue || '');
    const organizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;
    const now = new Date();
    const open = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];
    const org = organizationId ? { organizationId } : {};

    if (queue === 'my-work') {
      const items = await prisma.task.findMany({
        where: { tenantId, ...org, assignedToId: req.user!.id, status: { in: open } },
        orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'organization-work') {
      if (!organizationId) return deny(res, 400, 'organizationId required');
      const items = await prisma.task.findMany({
        where: { tenantId, organizationId, status: { in: open } },
        orderBy: [{ dueAt: 'asc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'pending-follow-ups') {
      const items = await prisma.task.findMany({
        where: {
          tenantId,
          ...org,
          source: ENROLLMENT_FOLLOWUP_SOURCE,
          status: { in: open },
          dueAt: { gte: now }
        },
        orderBy: [{ dueAt: 'asc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'overdue') {
      const items = await prisma.task.findMany({
        where: { tenantId, ...org, status: { in: open }, dueAt: { lt: now } },
        orderBy: [{ dueAt: 'asc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'escalated') {
      const items = await prisma.escalationRecord.findMany({
        where: { tenantId, ...org, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: [{ level: 'desc' }, { createdAt: 'desc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'expiring-credentials') {
      const items = await prisma.automationAlert.findMany({
        where: {
          tenantId,
          ...org,
          status: { in: ['PENDING', 'SENT'] },
          thresholdKey: { not: 'EXPIRED' }
        },
        orderBy: { createdAt: 'desc' },
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'revalidation-due') {
      const items = await prisma.enrollmentRevalidation.findMany({
        where: {
          tenantId,
          status: { in: ['NOT_STARTED', 'UPCOMING', 'PREPARING', 'READY_FOR_INTERNAL_REVIEW', 'SUBMITTED', 'ACKNOWLEDGED', 'ADDITIONAL_INFORMATION_REQUIRED', 'OVERDUE'] }
        },
        orderBy: [{ dueDate: 'asc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    if (queue === 'sla') {
      const items = await prisma.workflowSlaRecord.findMany({
        where: { tenantId, ...org },
        orderBy: [{ slaStatus: 'asc' }, { expectedCompletionAt: 'asc' }],
        take: 100
      });
      return res.json({ queue, items });
    }
    return deny(res, 400, 'Unknown queue');
  } catch (e) { next(e); }
});

router.get('/policies', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReadAutomation(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    await ensureDefaultPoliciesForTenant(tenantId);
    const kind = typeof req.query.kind === 'string' ? req.query.kind as AutomationPolicyKind : undefined;
    const organizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;
    const items = await listPolicies({ tenantId, kind, organizationId });
    res.json({ items });
  } catch (e) { next(e); }
});

router.post('/policies', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canManageAutomationPolicies(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const body = z.object({
      id: z.string().optional(),
      kind: z.nativeEnum(AutomationPolicyKind),
      name: z.string().min(2).max(200),
      description: z.string().max(2000).optional().nullable(),
      enabled: z.boolean().optional(),
      organizationId: z.string().optional().nullable(),
      payerId: z.string().optional().nullable(),
      config: z.record(z.any())
    }).parse(req.body);

    const row = await upsertPolicy({
      tenantId,
      actorRole: req.user!.role,
      ...body
    });
    await audit(req, body.id ? 'UPDATE' : 'CREATE', 'automationPolicy', row.id, undefined, {
      kind: row.kind,
      name: row.name,
      enabled: row.enabled,
      organizationId: row.organizationId,
      payerId: row.payerId
    });
    res.status(body.id ? 200 : 201).json(row);
  } catch (e) { next(e); }
});

router.patch('/policies/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canManageAutomationPolicies(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const existing = await prisma.automationPolicy.findFirst({
      where: { id: req.params.id, tenantId }
    });
    if (!existing) return deny(res, 404, 'Policy not found');
    const body = z.object({
      name: z.string().min(2).max(200).optional(),
      description: z.string().max(2000).optional().nullable(),
      enabled: z.boolean().optional(),
      organizationId: z.string().optional().nullable(),
      payerId: z.string().optional().nullable(),
      config: z.record(z.any()).optional()
    }).parse(req.body);

    const row = await upsertPolicy({
      tenantId,
      actorRole: req.user!.role,
      id: existing.id,
      kind: existing.kind,
      name: body.name || existing.name,
      description: body.description === undefined ? existing.description : body.description,
      enabled: body.enabled,
      organizationId: body.organizationId === undefined ? existing.organizationId : body.organizationId,
      payerId: body.payerId === undefined ? existing.payerId : body.payerId,
      config: body.config || existing.config
    });
    await audit(req, 'UPDATE', 'automationPolicy', row.id, { enabled: existing.enabled }, {
      enabled: row.enabled,
      name: row.name
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.get('/runs', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReadAutomation(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const items = await prisma.automationJobRun.findMany({
      where: {
        OR: [{ tenantId }, { jobType: 'GLOBAL_AUTOMATION_TICK' }]
      },
      orderBy: { startedAt: 'desc' },
      take: 50
    });
    res.json({ items });
  } catch (e) { next(e); }
});

router.post('/runs/sweep', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canRunAutomationJobs(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const run = await runTenantAutomationSweep(tenantId, req.user!.id);
    await audit(req, 'CREATE', 'automationJobRun', run.id, undefined, {
      jobType: run.jobType,
      status: run.status
    });
    res.status(202).json(run);
  } catch (e) { next(e); }
});

router.post('/escalations/:id/acknowledge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canRunAutomationJobs(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const row = await prisma.escalationRecord.findFirst({ where: { id: req.params.id, tenantId } });
    if (!row) return deny(res, 404, 'Escalation not found');
    const updated = await prisma.escalationRecord.update({
      where: { id: row.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedById: req.user!.id
      }
    });
    await audit(req, 'UPDATE', 'escalationRecord', updated.id, { status: row.status }, { status: updated.status });
    res.json(updated);
  } catch (e) { next(e); }
});

router.post('/escalations/:id/resolve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canManageAutomationPolicies(req.user!.role) && req.user!.role !== Role.APPROVER) {
      return deny(res, 403, 'Insufficient permissions');
    }
    const tenantId = requireTenant(req);
    const body = z.object({ resolutionNotes: z.string().max(2000).optional() }).parse(req.body || {});
    const row = await prisma.escalationRecord.findFirst({ where: { id: req.params.id, tenantId } });
    if (!row) return deny(res, 404, 'Escalation not found');
    const updated = await prisma.escalationRecord.update({
      where: { id: row.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedById: req.user!.id,
        resolutionNotes: body.resolutionNotes || null
      }
    });
    await audit(req, 'UPDATE', 'escalationRecord', updated.id, { status: row.status }, { status: 'RESOLVED' });
    res.json(updated);
  } catch (e) { next(e); }
});

router.post('/alerts/:id/acknowledge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canRunAutomationJobs(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const row = await prisma.automationAlert.findFirst({ where: { id: req.params.id, tenantId } });
    if (!row) return deny(res, 404, 'Alert not found');
    const updated = await prisma.automationAlert.update({
      where: { id: row.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedById: req.user!.id
      }
    });
    res.json(updated);
  } catch (e) { next(e); }
});

router.post('/tasks/:taskId/reassign', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireTenant(req);
    const body = z.object({
      toUserId: z.string().min(1),
      reason: z.string().max(500).optional()
    }).parse(req.body);
    const task = await reassignTask({
      tenantId,
      taskId: req.params.taskId,
      toUserId: body.toUserId,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      reason: body.reason
    });
    await audit(req, 'UPDATE', 'tasks', task.id, undefined, { assignedToId: task.assignedToId, reason: body.reason || 'MANUAL_REASSIGN' });
    res.json(task);
  } catch (e) { next(e); }
});

router.get('/calendar', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReadAutomation(req.user!.role)) return deny(res, 403, 'Insufficient permissions');
    const tenantId = requireTenant(req);
    const orgRestriction = await getOrgRestrictionIds(req.user!.id, req.user!.role, req.tenantContext);
    const data = await getCredentialExpirationCalendar({
      tenantId,
      view: (typeof req.query.view === 'string' ? req.query.view : 'month') as 'month' | 'week' | 'upcoming',
      anchor: req.query.anchor ? new Date(String(req.query.anchor)) : undefined,
      organizationId: typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined,
      providerId: typeof req.query.providerId === 'string' ? req.query.providerId : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      payerId: typeof req.query.payerId === 'string' ? req.query.payerId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      assignedToId: typeof req.query.assignedToId === 'string' ? req.query.assignedToId : undefined,
      from: req.query.from ? new Date(String(req.query.from)) : undefined,
      to: req.query.to ? new Date(String(req.query.to)) : undefined,
      organizationIds: orgRestriction
    });
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/ops', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canManageAutomationPolicies(req.user!.role) && req.user!.role !== Role.APPROVER) {
      return deny(res, 403, 'Insufficient permissions');
    }
    const tenantId = requireTenant(req);
    const data = await getAutomationOpsVisibility({
      tenantId,
      organizationId: typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined,
      jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      from: req.query.from ? new Date(String(req.query.from)) : undefined,
      to: req.query.to ? new Date(String(req.query.to)) : undefined
    });
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
