import { Router, Response, NextFunction } from 'express';
import { EnrollmentStatus, Priority, Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext, assertRecordInTenant } from '../services/tenantAccess';
import {
  computeEnrollmentAttention,
  createEnrollmentFollowUp,
  getEnrollmentDashboardCounts,
  markReadyForSubmission,
  recordAcknowledgment,
  recordApproval,
  recordEffective,
  recordRejection,
  recordSubmission,
  recordTermination,
  requestAdditionalInformation,
  startPayerReview,
  startPreparation,
  sanitizeEnrollmentForAudience
} from '../services/enrollmentLifecycle';
import { prisma } from '../lib/prisma';

const router = Router();

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

router.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Enrollment dashboard is not available to external providers' });
    }
    const data = await getEnrollmentDashboardCounts(req.tenantContext!.tenantId!);
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await prisma.statusHistory.findMany({
      where: { enrollmentId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ items: rows });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/prepare', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const row = await startPreparation(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      req.user!.role
    );
    await audit(req, 'enrollment.prepare', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/ready', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const row = await markReadyForSubmission(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      req.user!.role
    );
    await audit(req, 'enrollment.ready', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/submit', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      submittedAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      notes: z.string().max(4000).optional().nullable()
    }).parse(req.body || {});
    const row = await recordSubmission({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.submit', 'enrollments', row.id, null, {
      status: row.status,
      referenceNo: body.referenceNo || null,
      evidenceDocumentId: body.evidenceDocumentId || null
    });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/acknowledge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      acknowledgedAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      notes: z.string().max(4000).optional().nullable()
    }).parse(req.body || {});
    const row = await recordAcknowledgment({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.acknowledge', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/payer-review', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({ notes: z.string().max(4000).optional().nullable() }).parse(req.body || {});
    const row = await startPayerReview(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      req.user!.role,
      body.notes
    );
    await audit(req, 'enrollment.payer_review', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/request-information', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      reason: z.string().min(1).max(4000),
      nextFollowUpAt: z.coerce.date().optional().nullable()
    }).parse(req.body || {});
    const row = await requestAdditionalInformation({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.request_information', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      decisionAt: z.coerce.date().optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      payerEnrollmentId: z.string().max(200).optional().nullable()
    }).parse(req.body || {});
    const row = await recordApproval({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.approve', 'enrollments', row.id, null, {
      status: row.status,
      payerEnrollmentId: body.payerEnrollmentId || null
    });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/effective', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      effectiveAt: z.coerce.date(),
      evidenceDocumentId: z.string().optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      revalidationAt: z.coerce.date().optional().nullable()
    }).parse(req.body || {});
    const row = await recordEffective({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.effective', 'enrollments', row.id, null, {
      status: row.status,
      effectiveAt: body.effectiveAt
    });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      reason: z.string().min(1).max(4000),
      evidenceDocumentId: z.string().optional().nullable(),
      decisionAt: z.coerce.date().optional().nullable()
    }).parse(req.body || {});
    const row = await recordRejection({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.reject', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/terminate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      reason: z.string().min(1).max(4000),
      terminatedAt: z.coerce.date().optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await recordTermination({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.terminate', 'enrollments', row.id, null, { status: row.status });
    res.json(sanitizeEnrollmentForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/follow-ups', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({
      dueAt: z.coerce.date(),
      reason: z.string().min(1).max(4000),
      priority: z.nativeEnum(Priority).optional(),
      assignedToId: z.string().optional().nullable()
    }).parse(req.body || {});
    const task = await createEnrollmentFollowUp({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.follow_up', 'tasks', task.id, null, {
      enrollmentId: req.params.id,
      dueAt: body.dueAt
    });
    res.status(201).json(task);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id/attention', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const row = await prisma.enrollmentApplication.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Enrollment not found' });
    res.json({
      enrollmentId: row.id,
      status: row.status,
      attention: computeEnrollmentAttention(row),
      effectiveAt: row.effectiveAt,
      nextFollowUpAt: row.nextFollowUpAt,
      note: 'Attention is computed; it does not mean payer API confirmation.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

void EnrollmentStatus;
export default router;
