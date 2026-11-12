import { Router, Response, NextFunction } from 'express';
import { RevalidationDueDateSource, Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext, assertRecordInTenant } from '../services/tenantAccess';
import {
  acknowledgeRevalidation,
  approveRevalidation,
  canManageRevalidation,
  cancelRevalidation,
  completeRevalidation,
  createRevalidation,
  denyRevalidation,
  getRevalidation,
  getRevalidationDashboardCounts,
  getRevalidationHistory,
  getRevalidationWorklist,
  listEnrollmentRevalidations,
  markReadyForInternalReview,
  prepareRevalidation,
  requestRevalidationInformation,
  REVALIDATION_TYPES,
  sanitizeRevalidationForAudience,
  submitRevalidation,
  evaluateOverdueRevalidations
} from '../services/enrollmentRevalidation';

const enrollmentRouter = Router({ mergeParams: true });
const rootRouter = Router();

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

enrollmentRouter.get('/revalidations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const items = await listEnrollmentRevalidations(req.tenantContext!.tenantId!, req.params.id);
    const audience = audienceFor(req);
    res.json({ items: items.map((i) => sanitizeRevalidationForAudience(i, audience)) });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

enrollmentRouter.post('/revalidations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may create revalidations' });
    }
    const body = z.object({
      revalidationType: z.enum(REVALIDATION_TYPES as unknown as [string, ...string[]]),
      dueDate: z.coerce.date().optional().nullable(),
      dueDateSource: z.nativeEnum(RevalidationDueDateSource).optional(),
      referenceNumber: z.string().max(200).optional().nullable(),
      source: z.string().max(200).optional().nullable(),
      sourceReference: z.string().max(400).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      assignedToId: z.string().optional().nullable(),
      notificationDate: z.coerce.date().optional().nullable()
    }).parse(req.body || {});
    const row = await createRevalidation({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'revalidation.create', 'enrollmentRevalidations', row.id, null, {
      enrollmentId: req.params.id,
      type: row.revalidationType,
      status: row.status
    });
    res.status(201).json(sanitizeRevalidationForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

rootRouter.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Not available to external providers' });
    }
    const data = await getRevalidationDashboardCounts(req.tenantContext!.tenantId!);
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

rootRouter.get('/worklist', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Not available to external providers' });
    }
    const q = req.query;
    const data = await getRevalidationWorklist({
      tenantId: req.tenantContext!.tenantId!,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 25,
      status: q.status ? String(q.status) : undefined,
      payerId: q.payerId ? String(q.payerId) : undefined,
      providerId: q.providerId ? String(q.providerId) : undefined,
      assignedToId: q.assignedToId ? String(q.assignedToId) : undefined,
      revalidationType: q.revalidationType ? String(q.revalidationType) : undefined,
      dueFrom: q.dueFrom ? String(q.dueFrom) : undefined,
      dueTo: q.dueTo ? String(q.dueTo) : undefined,
      sort: q.sort ? String(q.sort) : undefined
    });
    const audience = audienceFor(req);
    res.json({
      ...data,
      items: data.items.map((i) => sanitizeRevalidationForAudience(i, audience))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

rootRouter.post('/evaluate-overdue', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageRevalidation(req.user!.role)) {
      return res.status(403).json({ error: 'Only GPA staff may evaluate overdue revalidations' });
    }
    const result = await evaluateOverdueRevalidations(req.tenantContext!.tenantId!, req.user!.id);
    await audit(req, 'revalidation.evaluate_overdue', 'enrollmentRevalidations', undefined, null, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

rootRouter.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const row = await getRevalidation(req.tenantContext!.tenantId!, req.params.id);
    res.json(sanitizeRevalidationForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

rootRouter.get('/:id/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Revalidation history is available to GPA staff only' });
    }
    const items = await getRevalidationHistory(req.tenantContext!.tenantId!, req.params.id);
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

function lifecycle(action: string, handler: (req: AuthRequest) => Promise<any>) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      requireTenantContext(req.tenantContext);
      if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
        return res.status(403).json({ error: 'Only GPA staff may change revalidation status' });
      }
      const row = await handler(req);
      await audit(req, `revalidation.${action}`, 'enrollmentRevalidations', req.params.id, null, {
        status: row.status
      });
      res.json(sanitizeRevalidationForAudience(row, audienceFor(req)));
    } catch (e: any) {
      if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  };
}

rootRouter.post('/:id/prepare', lifecycle('prepare', async (req) => {
  const body = z.object({ notes: z.string().max(4000).optional().nullable() }).parse(req.body || {});
  return prepareRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    notes: body.notes
  });
}));

rootRouter.post('/:id/ready', lifecycle('ready', async (req) => {
  const body = z.object({ notes: z.string().max(4000).optional().nullable() }).parse(req.body || {});
  return markReadyForInternalReview({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    notes: body.notes
  });
}));

rootRouter.post('/:id/submit', lifecycle('submit', async (req) => {
  const body = z.object({
    submittedAt: z.coerce.date().optional().nullable(),
    referenceNumber: z.string().max(200).optional().nullable(),
    evidenceDocumentId: z.string().optional().nullable(),
    confirmedSent: z.boolean(),
    notes: z.string().max(4000).optional().nullable()
  }).parse(req.body || {});
  return submitRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    ...body
  });
}));

rootRouter.post('/:id/acknowledge', lifecycle('acknowledge', async (req) => {
  const body = z.object({
    acknowledgedAt: z.coerce.date().optional().nullable(),
    notes: z.string().max(4000).optional().nullable()
  }).parse(req.body || {});
  return acknowledgeRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    ...body
  });
}));

rootRouter.post('/:id/request-information', lifecycle('request_information', async (req) => {
  const body = z.object({ reason: z.string().min(2).max(4000) }).parse(req.body || {});
  return requestRevalidationInformation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    reason: body.reason
  });
}));

rootRouter.post('/:id/approve', lifecycle('approve', async (req) => {
  const body = z.object({
    effectiveDate: z.coerce.date().optional().nullable(),
    evidenceDocumentId: z.string().optional().nullable(),
    notes: z.string().max(4000).optional().nullable()
  }).parse(req.body || {});
  return approveRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    ...body
  });
}));

rootRouter.post('/:id/complete', lifecycle('complete', async (req) => {
  const body = z.object({
    evidenceDocumentId: z.string().optional().nullable(),
    effectiveDate: z.coerce.date().optional().nullable(),
    notes: z.string().max(4000).optional().nullable()
  }).parse(req.body || {});
  return completeRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    ...body
  });
}));

rootRouter.post('/:id/deny', lifecycle('deny', async (req) => {
  const body = z.object({
    reason: z.string().min(2).max(4000),
    evidenceDocumentId: z.string().optional().nullable()
  }).parse(req.body || {});
  return denyRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    ...body
  });
}));

rootRouter.post('/:id/cancel', lifecycle('cancel', async (req) => {
  const body = z.object({ reason: z.string().min(2).max(4000) }).parse(req.body || {});
  return cancelRevalidation({
    tenantId: req.tenantContext!.tenantId!,
    revalidationId: req.params.id,
    actorId: req.user!.id,
    role: req.user!.role,
    reason: body.reason
  });
}));

export { enrollmentRouter as enrollmentRevalidationRoutes, rootRouter as revalidationRoutes };
