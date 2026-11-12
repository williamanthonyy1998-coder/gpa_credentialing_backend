import { Router, Response, NextFunction } from 'express';
import { Priority, Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { assertRecordInTenant, requireTenantContext } from '../services/tenantAccess';
import {
  SUBMISSION_CHANNELS,
  COMMUNICATION_TYPES,
  COMMUNICATION_CHANNELS,
  FOLLOW_UP_TYPES,
  prepareSubmission,
  confirmSubmission,
  listSubmissions,
  listCommunications,
  createCommunication,
  createTypedFollowUp,
  listFollowUps,
  completeFollowUp,
  cancelFollowUp,
  getEnrollmentTimeline,
  sanitizeSubmissionForAudience,
  sanitizeCommunicationForAudience,
  isFollowUpOverdue
} from '../services/enrollmentSubmission';

const router = Router({ mergeParams: true });

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

router.get('/submissions', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listSubmissions(req.tenantContext!.tenantId!, req.params.id);
    res.json({
      items: rows.map((r) => sanitizeSubmissionForAudience(r, audienceFor(req))),
      note: 'Manual submission records only — not automated payer transmission.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/submissions/:submissionId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listSubmissions(req.tenantContext!.tenantId!, req.params.id);
    const row = rows.find((r) => r.id === req.params.submissionId);
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    res.json(sanitizeSubmissionForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/submissions/:submissionId/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listSubmissions(req.tenantContext!.tenantId!, req.params.id);
    res.json({
      items: rows.map((r) => sanitizeSubmissionForAudience(r, audienceFor(req))),
      focusId: req.params.submissionId
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/submissions/prepare', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may prepare payer submissions' });
    }
    const body = z.object({
      channel: z.enum(SUBMISSION_CHANNELS as unknown as [string, ...string[]]),
      channelExplanation: z.string().max(2000).optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      submittedAt: z.coerce.date().optional().nullable()
    }).parse(req.body || {});
    const result = await prepareSubmission({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.submission_prepare', 'enrollments', req.params.id, null, {
      submissionId: result.submission.id,
      channel: body.channel,
      packetVersion: result.submission.packetVersion
    });
    res.status(201).json({
      ...result,
      submission: sanitizeSubmissionForAudience(result.submission, audienceFor(req))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/submissions/confirm', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may confirm payer submissions' });
    }
    const body = z.object({
      submissionId: z.string().optional().nullable(),
      channel: z.enum(SUBMISSION_CHANNELS as unknown as [string, ...string[]]).optional().nullable(),
      channelExplanation: z.string().max(2000).optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      submittedAt: z.coerce.date().optional().nullable(),
      confirmedSent: z.boolean(),
      overrideReason: z.string().max(4000).optional().nullable(),
      createInitialFollowUp: z.boolean().optional()
    }).parse(req.body || {});
    const result = await confirmSubmission({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.submission_confirm', 'enrollments', req.params.id, null, {
      submissionId: result.submission.id,
      channel: result.submission.channel,
      packetId: result.submission.packetId,
      packetVersion: result.submission.packetVersion,
      referenceNo: result.submission.referenceNo,
      confirmedSent: result.submission.confirmedSent,
      exceptionalOverride: Boolean(result.submission.overrideReason),
      overrideReason: result.submission.overrideReason || null,
      confirmedById: result.submission.confirmedById
    });
    res.json({
      ...result,
      submission: sanitizeSubmissionForAudience(result.submission, audienceFor(req))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/communications', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listCommunications(req.tenantContext!.tenantId!, req.params.id);
    res.json({ items: rows.map((r) => sanitizeCommunicationForAudience(r, audienceFor(req))) });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/communications', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may record payer communications' });
    }
    const body = z.object({
      communicationType: z.enum(COMMUNICATION_TYPES as unknown as [string, ...string[]]),
      channel: z.enum(COMMUNICATION_CHANNELS as unknown as [string, ...string[]]),
      channelExplanation: z.string().max(2000).optional().nullable(),
      occurredAt: z.coerce.date().optional().nullable(),
      contactName: z.string().max(256).optional().nullable(),
      contactDepartment: z.string().max(256).optional().nullable(),
      referenceNo: z.string().max(200).optional().nullable(),
      summary: z.string().min(1).max(1000),
      notes: z.string().max(4000).optional().nullable(),
      internalNotes: z.string().max(4000).optional().nullable(),
      submissionId: z.string().optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await createCommunication({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.communication_create', 'enrollments', req.params.id, null, {
      communicationId: row.id,
      communicationType: body.communicationType
    });
    res.status(201).json(sanitizeCommunicationForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/communications/:communicationId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listCommunications(req.tenantContext!.tenantId!, req.params.id);
    const row = rows.find((r) => r.id === req.params.communicationId);
    if (!row) return res.status(404).json({ error: 'Communication not found' });
    res.json(sanitizeCommunicationForAudience(row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/follow-ups', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const rows = await listFollowUps(req.tenantContext!.tenantId!, req.params.id);
    res.json({
      items: rows.map((r) => ({
        ...r,
        overdue: isFollowUpOverdue(r)
      }))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/follow-ups', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may create enrollment follow-ups' });
    }
    // Accept Phase 4C typed payload and Phase 4A legacy { reason, dueAt }.
    const body = z.object({
      followUpType: z.enum(FOLLOW_UP_TYPES as unknown as [string, ...string[]]).optional(),
      dueAt: z.coerce.date(),
      description: z.string().max(4000).optional().nullable(),
      reason: z.string().max(4000).optional().nullable(),
      priority: z.nativeEnum(Priority).optional(),
      assignedToId: z.string().optional().nullable(),
      submissionId: z.string().optional().nullable(),
      communicationId: z.string().optional().nullable()
    }).parse(req.body || {});
    const description = String(body.description || body.reason || '').trim();
    if (!description) {
      return res.status(400).json({ error: 'description or reason is required' });
    }
    const task = await createTypedFollowUp({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      followUpType: body.followUpType || 'OTHER',
      dueAt: body.dueAt,
      description,
      priority: body.priority,
      assignedToId: body.assignedToId,
      submissionId: body.submissionId,
      communicationId: body.communicationId
    });
    await audit(req, 'enrollment.follow_up_create', 'tasks', task.id, null, {
      enrollmentId: req.params.id,
      followUpType: body.followUpType || 'OTHER'
    });
    res.status(201).json(task);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/follow-ups/:followUpId/complete', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({ completionNotes: z.string().max(4000).optional().nullable() }).parse(req.body || {});
    const task = await completeFollowUp({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      followUpId: req.params.followUpId,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.follow_up_complete', 'tasks', task.id, null, { enrollmentId: req.params.id });
    res.json(task);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/follow-ups/:followUpId/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({ reason: z.string().max(4000).optional().nullable() }).parse(req.body || {});
    const task = await cancelFollowUp({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      followUpId: req.params.followUpId,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.follow_up_cancel', 'tasks', task.id, null, { enrollmentId: req.params.id });
    res.json(task);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/timeline', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const data = await getEnrollmentTimeline(req.tenantContext!.tenantId!, req.params.id);
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
