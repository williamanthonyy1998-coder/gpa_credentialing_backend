import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { IntakeKind, IntakeStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { convertIntake, missingIntakeFields } from '../services/intakeConvert';
import { notifyUser } from '../services/notifications';

const router = Router();

const include = {
  organization: { select: { id: true, legalName: true } },
  assignedTo: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  events: { orderBy: { createdAt: 'desc' as const }, take: 50 }
};

function refNo() {
  return `INT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [total, draft, sent, submitted, underReview, converted, pending] = await Promise.all([
      prisma.intakeRequest.count(),
      prisma.intakeRequest.count({ where: { status: 'DRAFT' } }),
      prisma.intakeRequest.count({ where: { status: 'SENT' } }),
      prisma.intakeRequest.count({ where: { status: 'SUBMITTED' } }),
      prisma.intakeRequest.count({ where: { status: 'UNDER_REVIEW' } }),
      prisma.intakeRequest.count({ where: { status: 'CONVERTED' } }),
      prisma.intakeRequest.count({ where: { status: { in: ['SENT', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW'] } } })
    ]);
    res.json({ total, draft, sent, submitted, underReview, converted, pending });
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where: any = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { referenceNo: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { contactEmail: { contains: q, mode: 'insensitive' } }
      ];
    }
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

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.intakeRequest.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: 'Intake request not found' });
    res.json(row);
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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
    const missing = missingIntakeFields(kind, input.payload);
    const row = await prisma.intakeRequest.create({
      data: {
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
      notes: z.string().optional().nullable(),
      status: z.nativeEnum(IntakeStatus).optional()
    }).parse(req.body);
    const before = await prisma.intakeRequest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Intake request not found' });
    if (before.status === 'CONVERTED') return res.status(400).json({ error: 'Converted intake cannot be edited' });
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
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot perform this action' });
    }
    const before = await prisma.intakeRequest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Intake request not found' });
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
  } catch (e) { next(e); }
}

router.post('/:id/send', (req, res, next) => transition(req, res, next, 'SENT', IntakeStatus.SENT, { sentAt: new Date() }));
router.post('/:id/submit', (req, res, next) => transition(req, res, next, 'SUBMITTED', IntakeStatus.SUBMITTED, { submittedAt: new Date() }));
router.post('/:id/review', (req, res, next) => transition(req, res, next, 'REVIEW', IntakeStatus.UNDER_REVIEW, { reviewedAt: new Date() }));

router.post('/:id/convert', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (([Role.READ_ONLY, Role.AUDITOR, Role.ENROLLMENT_SPECIALIST] as Role[]).includes(req.user!.role)) {
      // enrollment specialists may convert if needed — actually allow credentialing roles
    }
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot convert intake requests' });
    }
    const result = await convertIntake(req.params.id, req.user!.id);
    await audit(req, 'CONVERT', 'intake', req.params.id, undefined, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, missing: e.missing });
    next(e);
  }
});

export default router;
