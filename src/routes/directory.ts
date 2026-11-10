import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { assertOwnershipWithinLimit, ownershipSummary } from '../services/ownership';
import { assertResourceRecordAccess } from '../services/orgAccess';

const facilityProviderSelect = {
  id: true,
  firstName: true,
  lastName: true,
  npi: true,
  status: true,
  primarySpecialty: true
} as const;

const router = Router();

function canWrite(role: Role) {
  return !([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role);
}
function canSeeSensitive(role: Role) {
  return ([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(role);
}
function sanitizeOwner(row: any, role: Role) {
  if (!row) return row;
  const copy = { ...row, ownershipPercent: Number(row.ownershipPercent) };
  if (!canSeeSensitive(role)) {
    if (copy.ssn) copy.ssn = copy.ssn.length > 4 ? `***-**-${copy.ssn.slice(-4)}` : '[REDACTED]';
  }
  return copy;
}
function sanitizeBank(practice: any, role: Role) {
  if (!practice) return practice;
  const copy = { ...practice };
  if (role !== Role.ADMIN) {
    delete copy.bankAccountNumber;
    delete copy.bankRoutingNumber;
  } else if (copy.bankAccountNumber) {
    copy.bankAccountNumberMasked = `****${String(copy.bankAccountNumber).slice(-4)}`;
  }
  if (!canSeeSensitive(role)) delete copy.taxId;
  if (copy.owners) copy.owners = copy.owners.map((o: any) => sanitizeOwner(o, role));
  return copy;
}
function clean(data: any) {
  const out = { ...data };
  for (const k of Object.keys(out)) if (out[k] === '') out[k] = null;
  return out;
}

const ownerSchema = z.object({
  practiceId: z.string().min(1),
  name: z.string().min(2),
  ownershipPercent: z.coerce.number().positive().max(100),
  ssn: z.string().optional().nullable(),
  dateOfBirth: z.coerce.date().optional().nullable(),
  ownershipDate: z.coerce.date().optional().nullable(),
  placeOfBirth: z.string().optional().nullable(),
  address: z.any().optional(),
  phone: z.string().optional().nullable(),
  fax: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable()
});

const contactObjectSchema = z.object({
  facilityId: z.string().min(1),
  kind: z.enum(['PERSON', 'ORGANIZATION']),
  name: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  organizationName: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  phone: z.string().optional().nullable()
});
const contactSchema = contactObjectSchema.superRefine((val, ctx) => {
  if (val.kind === 'PERSON' && !val.name) ctx.addIssue({ code: 'custom', message: 'Person contact requires a name', path: ['name'] });
  if (val.kind === 'ORGANIZATION' && !val.organizationName) ctx.addIssue({ code: 'custom', message: 'Organization contact requires an organization name', path: ['organizationName'] });
});

const daySchema = z.object({
  open: z.boolean(),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  breakStart: z.string().optional().nullable(),
  breakEnd: z.string().optional().nullable(),
  appointmentDuration: z.coerce.number().int().positive().optional().nullable(),
  slots: z.array(z.object({
    startTime: z.string(),
    endTime: z.string()
  })).optional()
}).superRefine((day, ctx) => {
  if (!day.open) return;
  if (!day.startTime || !day.endTime) {
    ctx.addIssue({ code: 'custom', message: 'Open days require start and end times' });
    return;
  }
  if (day.startTime >= day.endTime) ctx.addIssue({ code: 'custom', message: 'End time must be after start time' });
  if (day.breakStart && day.breakEnd && day.breakStart >= day.breakEnd) {
    ctx.addIssue({ code: 'custom', message: 'Break end must be after break start' });
  }
});

const scheduleSchema = z.object({
  Monday: daySchema.optional(),
  Tuesday: daySchema.optional(),
  Wednesday: daySchema.optional(),
  Thursday: daySchema.optional(),
  Friday: daySchema.optional(),
  Saturday: daySchema.optional(),
  Sunday: daySchema.optional()
});

router.get('/practices/:id/detail', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const practice = await prisma.practice.findUnique({
      where: { id: req.params.id },
      include: {
        organization: { select: { id: true, legalName: true, dba: true } },
        owners: { orderBy: { createdAt: 'asc' } },
        facilities: { select: { id: true, name: true, status: true, npi: true } },
        providers: { include: { provider: { select: { id: true, firstName: true, lastName: true, npi: true, status: true } } } }
      }
    });
    if (!practice) return res.status(404).json({ error: 'Practice not found' });
    const summary = await ownershipSummary(practice.id);
    res.json({ ...sanitizeBank(practice, req.user!.role), ownershipTotal: summary.totalPercent, ownershipRemaining: summary.remainingPercent });
  } catch (e) { next(e); }
});

router.get('/practices/:id/owners', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const summary = await ownershipSummary(req.params.id);
    res.json({
      totalPercent: summary.totalPercent,
      remainingPercent: summary.remainingPercent,
      owners: summary.owners.map(o => sanitizeOwner(o, req.user!.role))
    });
  } catch (e) { next(e); }
});

router.post('/practice-owners', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(ownerSchema.parse(req.body));
    if (data.ssn && !canSeeSensitive(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers' });
    await assertOwnershipWithinLimit(data.practiceId, data.ownershipPercent);
    const row = await prisma.practiceOwner.create({ data });
    await audit(req, 'CREATE', 'practiceOwners', row.id, undefined, { ...row, ssn: data.ssn ? '[REDACTED]' : null });
    res.status(201).json(sanitizeOwner(row, req.user!.role));
  } catch (e: any) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.patch('/practice-owners/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(ownerSchema.partial().parse(req.body));
    const before = await prisma.practiceOwner.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Owner not found' });
    if (('ssn' in data) && !canSeeSensitive(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers' });
    const practiceId = data.practiceId || before.practiceId;
    const percent = data.ownershipPercent !== undefined ? Number(data.ownershipPercent) : Number(before.ownershipPercent);
    await assertOwnershipWithinLimit(practiceId, percent, before.id);
    const row = await prisma.practiceOwner.update({ where: { id: before.id }, data });
    await audit(req, 'UPDATE', 'practiceOwners', row.id, { ...before, ssn: before.ssn ? '[REDACTED]' : null }, { ...row, ssn: row.ssn ? '[REDACTED]' : null });
    res.json(sanitizeOwner(row, req.user!.role));
  } catch (e: any) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.delete('/practice-owners/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const before = await prisma.practiceOwner.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Owner not found' });
    await prisma.practiceOwner.delete({ where: { id: before.id } });
    await audit(req, 'DELETE', 'practiceOwners', before.id, { ...before, ssn: before.ssn ? '[REDACTED]' : null }, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.get('/facilities/:id/detail', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await assertResourceRecordAccess(req.user!.id, req.user!.role, 'facilities', req.params.id);
    const facility = await prisma.facility.findUnique({
      where: { id: req.params.id },
      include: {
        practice: { select: { id: true, name: true, organizationId: true } },
        organization: { select: { id: true, legalName: true } },
        contacts: { orderBy: { createdAt: 'asc' } },
        providers: {
          orderBy: [{ provider: { lastName: 'asc' } }, { provider: { firstName: 'asc' } }],
          include: { provider: { select: facilityProviderSelect } }
        }
      }
    });
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    res.json(facility);
  } catch (e) { next(e); }
});

/** Lightweight facility-scoped provider list (same ProviderFacility join as detail). */
router.get('/facilities/:id/providers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await assertResourceRecordAccess(req.user!.id, req.user!.role, 'facilities', req.params.id);
    const facility = await prisma.facility.findUnique({
      where: { id: req.params.id },
      select: { id: true }
    });
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    const rows = await prisma.providerFacility.findMany({
      where: { facilityId: facility.id },
      orderBy: [{ provider: { lastName: 'asc' } }, { provider: { firstName: 'asc' } }],
      include: { provider: { select: facilityProviderSelect } }
    });
    res.json(rows.map(row => ({
      providerId: row.providerId,
      facilityId: row.facilityId,
      approvalStatus: row.approvalStatus,
      effectiveAt: row.effectiveAt,
      endAt: row.endAt,
      provider: row.provider
    })));
  } catch (e) { next(e); }
});

router.get('/facility-contacts', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const facilityId = String(req.query.facilityId || '').trim();
    if (!facilityId) return res.status(400).json({ error: 'facilityId is required' });
    const kind = String(req.query.kind || '').trim();
    const rows = await prisma.facilityContact.findMany({
      where: { facilityId, ...(kind ? { kind: kind as any } : {}) },
      orderBy: { createdAt: 'desc' }
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/facility-contacts', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(contactSchema.parse(req.body));
    const row = await prisma.facilityContact.create({ data });
    await audit(req, 'CREATE', 'facilityContacts', row.id, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.patch('/facility-contacts/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = clean(contactObjectSchema.partial().parse(req.body));
    const before = await prisma.facilityContact.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Contact not found' });
    const row = await prisma.facilityContact.update({ where: { id: before.id }, data });
    await audit(req, 'UPDATE', 'facilityContacts', row.id, before, row);
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/facility-contacts/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const before = await prisma.facilityContact.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Contact not found' });
    await prisma.facilityContact.delete({ where: { id: before.id } });
    await audit(req, 'DELETE', 'facilityContacts', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.put('/facilities/:id/schedule', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const schedule = scheduleSchema.parse(req.body?.schedule ?? req.body);
    const before = await prisma.facility.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Facility not found' });
    const row = await prisma.facility.update({ where: { id: before.id }, data: { schedule } });
    await audit(req, 'UPDATE', 'facilities', row.id, { schedule: before.schedule }, { schedule: row.schedule });
    res.json(row);
  } catch (e) { next(e); }
});

router.post('/provider-facilities', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = z.object({
      providerId: z.string().min(1),
      facilityId: z.string().min(1),
      approvalStatus: z.string().optional().nullable(),
      effectiveAt: z.coerce.date().optional().nullable(),
      endAt: z.coerce.date().optional().nullable()
    }).parse(req.body);
    await assertResourceRecordAccess(req.user!.id, req.user!.role, 'facilities', data.facilityId);
    const provider = await prisma.provider.findUnique({ where: { id: data.providerId }, select: { id: true } });
    if (!provider) return res.status(400).json({ error: 'Provider not found' });
    const facility = await prisma.facility.findUnique({ where: { id: data.facilityId }, select: { id: true } });
    if (!facility) return res.status(400).json({ error: 'Facility not found' });
    const row = await prisma.providerFacility.upsert({
      where: { providerId_facilityId: { providerId: data.providerId, facilityId: data.facilityId } },
      update: { approvalStatus: data.approvalStatus || undefined, effectiveAt: data.effectiveAt || undefined, endAt: data.endAt || undefined },
      create: { providerId: data.providerId, facilityId: data.facilityId, approvalStatus: data.approvalStatus || 'Pending', effectiveAt: data.effectiveAt || new Date(), endAt: data.endAt || null },
      include: {
        provider: { select: facilityProviderSelect },
        facility: { select: { id: true, name: true } }
      }
    });
    await audit(req, 'CREATE', 'providerFacilities', `${data.providerId}:${data.facilityId}`, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.delete('/provider-facilities/:providerId/:facilityId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    await assertResourceRecordAccess(req.user!.id, req.user!.role, 'facilities', req.params.facilityId);
    const before = await prisma.providerFacility.findUnique({
      where: { providerId_facilityId: { providerId: req.params.providerId, facilityId: req.params.facilityId } }
    });
    if (!before) return res.status(404).json({ error: 'Affiliation not found' });
    await prisma.providerFacility.delete({
      where: { providerId_facilityId: { providerId: req.params.providerId, facilityId: req.params.facilityId } }
    });
    await audit(req, 'DELETE', 'providerFacilities', `${req.params.providerId}:${req.params.facilityId}`, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/provider-practices', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = z.object({
      providerId: z.string().min(1),
      practiceId: z.string().min(1),
      affiliationTitle: z.string().optional().nullable(),
      effectiveAt: z.coerce.date().optional().nullable(),
      endAt: z.coerce.date().optional().nullable()
    }).parse(req.body);
    const row = await prisma.providerPractice.upsert({
      where: { providerId_practiceId: { providerId: data.providerId, practiceId: data.practiceId } },
      update: { affiliationTitle: data.affiliationTitle || undefined, effectiveAt: data.effectiveAt || undefined, endAt: data.endAt || undefined },
      create: { providerId: data.providerId, practiceId: data.practiceId, affiliationTitle: data.affiliationTitle || 'Rendering Provider', effectiveAt: data.effectiveAt || new Date(), endAt: data.endAt || null },
      include: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } }, practice: { select: { id: true, name: true } } }
    });
    await audit(req, 'CREATE', 'providerPractices', `${data.providerId}:${data.practiceId}`, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

export default router;
