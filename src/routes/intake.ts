import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { IntakeKind, IntakeStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { convertIntake, missingIntakeFields } from '../services/intakeConvert';
import { notifyUser } from '../services/notifications';
import {
  assertOrganizationInTenant,
  assertRecordInTenant,
  requireTenantContext
} from '../services/tenantAccess';
import {
  approveIntake,
  canApproveIntake,
  canReviewIntake,
  rejectIntake,
  releaseDocumentFromQuarantine,
  requestIntakeChanges,
  resolveAmbiguousIdentity,
  sanitizeIntakeForClient
} from '../services/providerIntake';
import {
  createProviderIntakeInvitation,
  listProviderInvitations,
  resendProviderIntakeInvitation,
  revokeProviderIntakeInvitation
} from '../services/providerInvitations';

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invitation requests. Try again later.' }
});

const router = Router();

function intakeTenantWhere(tenantId: string) {
  return { OR: [{ tenantId }, { organization: { is: { tenantId } } }] };
}

const include = {
  organization: { select: { id: true, legalName: true } },
  assignedTo: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  events: { orderBy: { createdAt: 'desc' as const }, take: 50 },
  submissions: {
    orderBy: { version: 'desc' as const },
    take: 50,
    select: {
      id: true,
      version: true,
      submittedAt: true,
      reviewAction: true,
      reviewComments: true,
      reviewedAt: true,
      submittedById: true
    }
  },
  documents: {
    where: { securityStatus: { not: 'DELETED' as const } },
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      title: true,
      type: true,
      category: true,
      status: true,
      securityStatus: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      uploadedAt: true
    }
  }
};

function refNo() {
  return `INT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantScope = intakeTenantWhere(req.tenantContext!.tenantId);
    const [total, draft, sent, submitted, underReview, converted, pending] = await Promise.all([
      prisma.intakeRequest.count({ where: tenantScope }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: 'DRAFT' }] } }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: 'SENT' }] } }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: 'SUBMITTED' }] } }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: 'UNDER_REVIEW' }] } }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: 'CONVERTED' }] } }),
      prisma.intakeRequest.count({ where: { AND: [tenantScope, { status: { in: ['SENT', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW'] } }] } })
    ]);
    res.json({ total, draft, sent, submitted, underReview, converted, pending });
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantScope = intakeTenantWhere(req.tenantContext!.tenantId);
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const and: any[] = [tenantScope];
    if (status) and.push({ status });
    if (q) {
      and.push({
        OR: [
          { referenceNo: { contains: q, mode: 'insensitive' } },
          { contactName: { contains: q, mode: 'insensitive' } },
          { contactEmail: { contains: q, mode: 'insensitive' } }
        ]
      });
    }
    const where = { AND: and };
    const [total, data] = await Promise.all([
      prisma.intakeRequest.count({ where }),
      prisma.intakeRequest.findMany({
        where,
        include,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ]);
    res.json({ data, total, page, pageSize });
  } catch (e) { next(e); }
});

router.post('/provider-invitations/:invitationId/resend', inviteLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canReviewIntake(req.user!.role) && req.user!.role !== Role.CLIENT_USER) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const result = await resendProviderIntakeInvitation(req.params.invitationId, req.user!.id);
    if (result.invitation.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    await audit(req, 'PROVIDER_INVITATION_RESEND', 'providerIntakeInvitations', result.invitation.id, undefined, {
      email: result.invitation.email,
      deliveryStatus: result.invitation.deliveryStatus
    });
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/provider-invitations/:invitationId/revoke', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canReviewIntake(req.user!.role) && req.user!.role !== Role.CLIENT_USER) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const row = await revokeProviderIntakeInvitation(req.params.invitationId, req.user!.id);
    if (row.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    await audit(req, 'PROVIDER_INVITATION_REVOKE', 'providerIntakeInvitations', row.id, undefined, {
      email: row.email,
      status: row.status
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/documents/:documentId/release', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const { canManualRelease, MANUAL_RELEASE_REASON_MIN } = await import('../services/documentSecurity');
    if (!canManualRelease(req.user!.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions for manual document release. Requires ADMIN, CREDENTIALING_MANAGER, or APPROVER.'
      });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MANUAL_RELEASE_REASON_MIN) {
      return res.status(400).json({
        error: `Release reason is required (minimum ${MANUAL_RELEASE_REASON_MIN} characters). Manual release is not a malware scan.`,
        code: 'RELEASE_REASON_REQUIRED'
      });
    }
    const doc = await prisma.document.findUnique({ where: { id: req.params.documentId } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await assertRecordInTenant(req.tenantContext!, 'documents', doc.id);
    const previousStatus = doc.securityStatus;
    const updated = await releaseDocumentFromQuarantine(doc.id, req.user!.id, {
      role: req.user!.role,
      reason
    });
    await audit(req, 'DOCUMENT_RELEASE', 'documents', doc.id, { securityStatus: previousStatus }, {
      securityStatus: updated.securityStatus,
      previousStatus,
      reason,
      malwareScanned: false,
      note: 'Manual review release — not malware-scanned'
    });
    res.json({
      ...updated,
      releaseNote: 'Manual review — not malware-scanned'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    const row = await prisma.intakeRequest.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: 'Intake request not found' });
    res.json(row);
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot create intake requests' });
    }
    const input = z.object({
      kind: z.nativeEnum(IntakeKind).optional(),
      organizationId: z.string().optional().nullable(),
      assignedToId: z.string().optional().nullable(),
      contactName: z.string().optional().nullable(),
      contactEmail: z.string().email().optional().or(z.literal('')).nullable(),
      contactPhone: z.string().optional().nullable(),
      payload: z.any().optional(),
      notes: z.string().optional().nullable()
    }).parse(req.body);
    const kind = input.kind || IntakeKind.PROVIDER;
    if (input.organizationId) await assertOrganizationInTenant(tenantId, input.organizationId);
    const missing = missingIntakeFields(kind, input.payload);
    const row = await prisma.intakeRequest.create({
      data: {
        tenantId,
        referenceNo: refNo(),
        kind,
        organizationId: input.organizationId || null,
        assignedToId: input.assignedToId || null,
        createdById: req.user!.id,
        contactName: input.contactName || null,
        contactEmail: input.contactEmail || null,
        contactPhone: input.contactPhone || null,
        payload: input.payload || {},
        missingFields: missing,
        notes: input.notes || null,
        status: IntakeStatus.DRAFT
      },
      include
    });
    await prisma.intakeEvent.create({
      data: { intakeId: row.id, action: 'CREATED', actorId: req.user!.id, detail: { kind } }
    });
    await audit(req, 'CREATE', 'intake', row.id, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot update intake requests' });
    }
    const input = z.object({
      kind: z.nativeEnum(IntakeKind).optional(),
      organizationId: z.string().optional().nullable(),
      assignedToId: z.string().optional().nullable(),
      contactName: z.string().optional().nullable(),
      contactEmail: z.string().email().optional().or(z.literal('')).nullable(),
      contactPhone: z.string().optional().nullable(),
      payload: z.any().optional(),
      notes: z.string().optional().nullable()
      // status is intentionally omitted — use dedicated transition endpoints (Phase 2C)
    }).parse(req.body);
    const before = await prisma.intakeRequest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Intake request not found' });
    if (before.status === 'CONVERTED' || before.status === 'CANCELLED' || before.status === 'EXPIRED') {
      return res.status(400).json({ error: 'This intake cannot be edited' });
    }
    if (input.organizationId) await assertOrganizationInTenant(tenantId, input.organizationId);
    const payload = input.payload !== undefined ? input.payload : before.payload;
    const kind = input.kind || before.kind;
    const missing = missingIntakeFields(kind, payload);
    const row = await prisma.intakeRequest.update({
      where: { id: req.params.id },
      data: { ...input, missingFields: missing },
      include
    });
    await prisma.intakeEvent.create({
      data: { intakeId: row.id, action: 'UPDATED', actorId: req.user!.id, detail: input }
    });
    await audit(req, 'UPDATE', 'intake', row.id, before, row);
    res.json(row);
  } catch (e) { next(e); }
});

async function transition(req: AuthRequest, res: Response, next: NextFunction, action: string, status: IntakeStatus, extra: any = {}) {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (([Role.READ_ONLY, Role.AUDITOR, Role.EXTERNAL_PROVIDER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot perform this action' });
    }
    const before = await prisma.intakeRequest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Intake request not found' });
    const { assertTransition } = await import('../services/intakeStateMachine');
    assertTransition(before.status, status, action);
    const row = await prisma.intakeRequest.update({
      where: { id: req.params.id },
      data: { status, ...extra },
      include
    });
    await prisma.intakeEvent.create({
      data: { intakeId: row.id, action, actorId: req.user!.id, detail: { from: before.status, to: status } }
    });
    if (row.assignedToId) {
      await notifyUser({
        userId: row.assignedToId,
        title: `Intake ${action.toLowerCase()}`,
        body: `${row.referenceNo} is now ${status}`,
        type: 'intake',
        entityType: 'intake',
        entityId: row.id,
        href: '/intake'
      });
    }
    await audit(req, action, 'intake', row.id, before, row);
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
}

router.post('/:id/send', (req, res, next) => transition(req, res, next, 'SENT', IntakeStatus.SENT, { sentAt: new Date() }));
router.post('/:id/submit', (req, res, next) => transition(req, res, next, 'SUBMITTED', IntakeStatus.SUBMITTED, { submittedAt: new Date() }));
router.post('/:id/review', (req, res, next) => transition(req, res, next, 'REVIEW', IntakeStatus.UNDER_REVIEW, { reviewedAt: new Date() }));

router.post('/:id/convert', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (([Role.READ_ONLY, Role.AUDITOR, Role.CLIENT_USER, Role.EXTERNAL_PROVIDER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot convert intake requests' });
    }
    if (!canApproveIntake(req.user!.role) && req.user!.role !== Role.CREDENTIALING_SPECIALIST) {
      return res.status(403).json({ error: 'Your role cannot convert intake requests' });
    }
    const result = await convertIntake(req.params.id, req.user!.id);
    await audit(req, 'CONVERT', 'intake', req.params.id, undefined, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, missing: e.missing, code: e.code });
    next(e);
  }
});

router.post('/:id/invite-provider', inviteLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (!canReviewIntake(req.user!.role) && req.user!.role !== Role.CLIENT_USER) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (req.user!.role === Role.CLIENT_USER) {
      const tr = req.tenantContext!.tenantRole;
      if (tr !== 'TENANT_ADMIN' && tr !== 'CREDENTIALING_MANAGER') {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
    }
    const body = z.object({
      email: z.string().email(),
      knownProviderId: z.string().optional().nullable(),
      send: z.boolean().optional()
    }).parse(req.body);
    const result = await createProviderIntakeInvitation({
      tenantId: req.tenantContext!.tenantId!,
      intakeRequestId: req.params.id,
      email: body.email,
      knownProviderId: body.knownProviderId,
      invitedById: req.user!.id,
      send: body.send
    });
    await audit(req, 'PROVIDER_INVITATION_CREATE', 'providerIntakeInvitations', result.invitation.id, undefined, {
      intakeRequestId: req.params.id,
      email: result.invitation.email,
      deliveryStatus: result.invitation.deliveryStatus
    });
    res.status(201).json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id/provider-invitations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    res.json(await listProviderInvitations(req.tenantContext!.tenantId!, req.params.id));
  } catch (e) { next(e); }
});

router.post('/:id/request-changes', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (!canReviewIntake(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const body = z.object({
      comments: z.string().min(2),
      internalNotes: z.string().optional().nullable()
    }).parse(req.body);
    const row = await requestIntakeChanges(req.params.id, req.user!.id, body.comments, {
      internalNotes: body.internalNotes
    });
    await audit(req, 'CHANGES_REQUESTED', 'intake', req.params.id, undefined, { comments: body.comments });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (!canApproveIntake(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const body = z.object({
      reviewerComments: z.string().optional().nullable(),
      internalNotes: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await approveIntake(req.params.id, req.user!.id, body);
    await audit(req, 'APPROVE', 'intake', req.params.id, undefined, { status: row.status });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (!canApproveIntake(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const body = z.object({
      reason: z.string().min(2),
      internalNotes: z.string().optional().nullable()
    }).parse(req.body);
    const row = await rejectIntake(req.params.id, req.user!.id, body.reason, { internalNotes: body.internalNotes });
    await audit(req, 'REJECT', 'intake', req.params.id, undefined, { reason: body.reason });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/resolve-identity', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    if (!canApproveIntake(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const body = z.object({
      decision: z.enum(['USE_EXISTING', 'CREATE_NEW']),
      matchedProviderId: z.string().optional().nullable()
    }).parse(req.body);
    const row = await resolveAmbiguousIdentity(req.params.id, req.user!.id, body.decision, body.matchedProviderId);
    await audit(req, 'IDENTITY_RESOLVED', 'intake', req.params.id, undefined, body);
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/** Strip GPA internal notes for client users viewing intake detail. */
router.get('/:id/safe', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    const row = await prisma.intakeRequest.findUnique({
      where: { id: req.params.id },
      include: {
        ...include,
        documents: {
          where: { securityStatus: { not: 'DELETED' } },
          select: {
            id: true, title: true, type: true, category: true, status: true,
            securityStatus: true, originalName: true, mimeType: true, sizeBytes: true, uploadedAt: true
          }
        }
      }
    });
    if (!row) return res.status(404).json({ error: 'Intake request not found' });
    if (req.user!.role === Role.CLIENT_USER) return res.json(sanitizeIntakeForClient(row));
    res.json(row);
  } catch (e) { next(e); }
});

export default router;
