import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { DOCUMENT_CATEGORIES, withAttention, computeCredentialAttention } from '../services/credentials';

const router = Router();

function canWrite(role: Role) {
  return !([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role);
}

const docSchema = z.object({
  title: z.string().min(1),
  type: z.string().min(1),
  category: z.string().optional().nullable(),
  status: z.enum(['MISSING', 'RECEIVED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']).optional(),
  issuedAt: z.coerce.date().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  notes: z.string().optional().nullable(),
  ignored: z.boolean().optional(),
  required: z.boolean().optional(),
  reportingRequired: z.boolean().optional(),
  warningDays: z.coerce.number().int().positive().optional().nullable(),
  providerId: z.string().optional().nullable(),
  organizationId: z.string().optional().nullable(),
  practiceId: z.string().optional().nullable(),
  facilityId: z.string().optional().nullable()
});

function clean(data: any) {
  const out = { ...data };
  for (const k of Object.keys(out)) if (out[k] === '') out[k] = null;
  return out;
}

router.get('/categories', (_req, res) => {
  res.json(DOCUMENT_CATEGORIES);
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const category = String(req.query.category || '').trim();
    const organizationId = String(req.query.organizationId || '').trim();
    const practiceId = String(req.query.practiceId || '').trim();
    const facilityId = String(req.query.facilityId || '').trim();
    const providerId = String(req.query.providerId || '').trim();
    const q = String(req.query.q || '').trim();
    const where: any = {};
    if (category) where.category = category;
    if (organizationId) where.organizationId = organizationId;
    if (practiceId) where.practiceId = practiceId;
    if (facilityId) where.facilityId = facilityId;
    if (providerId) where.providerId = providerId;
    if (q) where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { type: { contains: q, mode: 'insensitive' } }];
    const rows = await prisma.document.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        organization: { select: { id: true, legalName: true } },
        practice: { select: { id: true, name: true } },
        facility: { select: { id: true, name: true } },
        provider: { select: { id: true, firstName: true, lastName: true } }
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    });
    res.json(rows.map(r => withAttention(r)));
  } catch (e) { next(e); }
});

router.get('/attention', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = String(req.query.organizationId || '').trim();
    const practiceId = String(req.query.practiceId || '').trim();
    const facilityId = String(req.query.facilityId || '').trim();
    const where: any = { ignored: false };
    if (facilityId) where.facilityId = facilityId;
    else if (practiceId) where.practiceId = practiceId;
    else if (organizationId) where.organizationId = organizationId;
    const rows = await prisma.document.findMany({ where, take: 200, orderBy: { expiresAt: 'asc' } });
    const annotated = rows.map(r => withAttention(r));
    const expiringSoon = annotated.filter(r => r.attention === 'EXPIRING_SOON');
    const expired = annotated.filter(r => r.attention === 'EXPIRED');
    const missingRequired = annotated.filter(r => r.required && r.attention === 'MISSING');
    res.json({
      expiringSoon,
      expired,
      missingRequired,
      counts: {
        expiringSoon: expiringSoon.length,
        expired: expired.length,
        missingRequired: missingRequired.length
      }
    });
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(docSchema.parse(req.body));
    if (!data.category) data.category = 'organization';
    const attention = computeCredentialAttention({ ...data, storageKey: null });
    if (attention === 'MISSING' && !data.status) data.status = 'MISSING';
    if (attention === 'EXPIRED') data.status = 'EXPIRED';
    const row = await prisma.document.create({
      data: { ...data, createdById: req.user!.id },
      include: { createdBy: { select: { id: true, name: true, email: true } } }
    });
    await audit(req, 'CREATE', 'documents', row.id, undefined, row);
    res.status(201).json(withAttention(row));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(docSchema.partial().parse(req.body));
    const before = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Document not found' });
    const merged = { ...before, ...data };
    const attention = computeCredentialAttention(merged);
    if (attention === 'EXPIRED') data.status = 'EXPIRED';
    const row = await prisma.document.update({
      where: { id: before.id },
      data,
      include: { createdBy: { select: { id: true, name: true, email: true } } }
    });
    await audit(req, 'UPDATE', 'documents', row.id, before, row);
    res.json(withAttention(row));
  } catch (e) { next(e); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const before = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Document not found' });
    await prisma.document.delete({ where: { id: before.id } });
    await audit(req, 'DELETE', 'documents', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
