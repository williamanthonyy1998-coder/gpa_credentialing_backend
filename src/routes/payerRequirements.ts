import { Router, Response, NextFunction } from 'express';
import { DirectoryScope, RecordStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { requireTenantContext } from '../services/tenantAccess';
import {
  bumpRequirementVersion,
  canManagePlatformRequirements,
  canManageTenantRequirements,
  listPayerRequirements,
  normalizeRequirementWrite,
  previewRequirements,
  recordRequirementHistory
} from '../services/payerRequirementsEngine';
import { validateConditionSchema } from '../services/requirementConditions';

const router = Router();

const writeSchema = z.object({
  scope: z.enum(['PLATFORM', 'TENANT']).optional(),
  payerId: z.string().optional().nullable(),
  payerPlanId: z.string().optional().nullable(),
  code: z.string().max(128).optional().nullable(),
  title: z.string().min(1).max(512),
  description: z.string().max(4000).optional().nullable(),
  category: z.string().max(128).optional().nullable(),
  requirementKind: z.string().max(128).optional().nullable(),
  isRequired: z.boolean().optional(),
  enrollmentTypes: z.any().optional().nullable(),
  appliesToProviderTypes: z.any().optional().nullable(),
  appliesToSpecialties: z.any().optional().nullable(),
  appliesToStates: z.any().optional().nullable(),
  appliesToFacility: z.boolean().optional(),
  appliesToGroup: z.boolean().optional(),
  documentCategoryCode: z.string().max(128).optional().nullable(),
  tracksExpiration: z.boolean().optional(),
  conditions: z.any().optional().nullable(),
  effectiveFrom: z.coerce.date().optional().nullable(),
  effectiveTo: z.coerce.date().optional().nullable(),
  source: z.string().max(512).optional().nullable(),
  sourceReference: z.string().max(1024).optional().nullable(),
  sourceVerifiedAt: z.coerce.date().optional().nullable(),
  instructions: z.string().max(4000).optional().nullable(),
  sortOrder: z.coerce.number().int().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED']).optional(),
  metadata: z.any().optional().nullable(),
  changeReason: z.string().max(1000).optional().nullable()
});

function denyClientWrites(role: Role) {
  if (role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER || role === Role.READ_ONLY || role === Role.AUDITOR) {
    const err: any = new Error('Your role cannot modify payer requirements');
    err.status = 403;
    throw err;
  }
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const rows = await listPayerRequirements({
      tenantId: req.tenantContext!.tenantId!,
      payerId: req.query.payerId ? String(req.query.payerId) : null,
      payerPlanId: req.query.payerPlanId ? String(req.query.payerPlanId) : null,
      category: req.query.category ? String(req.query.category) : null,
      includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true'
    });
    res.json({ data: rows, total: rows.length });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      payerId: z.string().min(1),
      payerPlanId: z.string().min(1),
      enrollmentType: z.enum(['INDIVIDUAL', 'GROUP', 'FACILITY', 'REASSIGNMENT', 'OTHER']).default('INDIVIDUAL'),
      specialty: z.string().optional().nullable(),
      state: z.string().optional().nullable(),
      hasFacility: z.boolean().optional(),
      hasBillingEntity: z.boolean().optional(),
      providerType: z.string().optional().nullable(),
      asOf: z.coerce.date().optional()
    }).parse(req.body || {});
    const result = await previewRequirements({
      tenantId: req.tenantContext!.tenantId!,
      ...body
    });
    res.json({
      ...result,
      note: 'Preview uses configured requirements only — the platform does not invent payer rules.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const row = await prisma.payerRequirement.findUnique({
      where: { id: req.params.id },
      include: {
        payer: { select: { id: true, name: true } },
        payerPlan: { select: { id: true, name: true } }
      }
    });
    if (!row) return res.status(404).json({ error: 'Requirement not found' });
    if (row.scope === DirectoryScope.TENANT && row.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Requirement not found' });
    }
    res.json(row);
  } catch (e) { next(e); }
});

router.get('/:id/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const row = await prisma.payerRequirement.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Requirement not found' });
    if (row.scope === DirectoryScope.TENANT && row.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Requirement not found' });
    }
    const history = await prisma.payerRequirementHistory.findMany({
      where: { requirementId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ items: history });
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    denyClientWrites(req.user!.role);
    const parsed = writeSchema.parse(req.body || {});
    const data = normalizeRequirementWrite(
      { ...parsed, scope: parsed.scope || 'PLATFORM' },
      req.user!.role,
      req.tenantContext!.tenantId!
    );
    if (data.conditions) validateConditionSchema(data.conditions);
    if (data.payerPlanId && data.payerId) {
      const plan = await prisma.payerPlan.findUnique({ where: { id: data.payerPlanId } });
      if (!plan || plan.payerId !== data.payerId) {
        return res.status(400).json({ error: 'Payer plan does not belong to selected payer' });
      }
    }
    const { changeReason, ...createData } = data;
    const row = await prisma.payerRequirement.create({
      data: {
        ...createData,
        lastReviewedById: req.user!.id,
        lastReviewedAt: new Date()
      }
    });
    await recordRequirementHistory({
      requirementId: row.id,
      version: row.version,
      snapshot: row,
      changedById: req.user!.id,
      changeReason: changeReason || 'Requirement created'
    });
    await audit(req, 'payer_requirement.create', 'payerRequirements', row.id, null, {
      code: row.code,
      scope: row.scope,
      version: row.version
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    denyClientWrites(req.user!.role);
    const existing = await prisma.payerRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Requirement not found' });
    if (existing.scope === DirectoryScope.PLATFORM && !canManagePlatformRequirements(req.user!.role)) {
      return res.status(403).json({ error: 'Only GPA platform admins may edit PLATFORM requirements' });
    }
    if (existing.scope === DirectoryScope.TENANT) {
      if (existing.tenantId !== req.tenantContext!.tenantId) return res.status(404).json({ error: 'Requirement not found' });
      if (!canManageTenantRequirements(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const parsed = writeSchema.partial().extend({ title: z.string().min(1).max(512).optional() }).parse(req.body || {});
    if (parsed.conditions !== undefined && parsed.conditions !== null) {
      parsed.conditions = validateConditionSchema(parsed.conditions) as any;
    }
    const bump = Boolean(
      parsed.title || parsed.conditions || parsed.isRequired !== undefined
      || parsed.effectiveFrom || parsed.effectiveTo || parsed.enrollmentTypes
      || parsed.appliesToSpecialties || parsed.appliesToStates || parsed.documentCategoryCode
    );
    if (bump) {
      await bumpRequirementVersion(existing.id, req.user!.id, parsed.changeReason || 'Material requirement update');
    }
    const { changeReason, ...patch } = parsed as any;
    const row = await prisma.payerRequirement.update({
      where: { id: existing.id },
      data: {
        ...patch,
        lastReviewedById: req.user!.id,
        lastReviewedAt: new Date()
      }
    });
    await audit(req, 'payer_requirement.update', 'payerRequirements', row.id, existing, {
      code: row.code,
      version: row.version,
      changeReason: changeReason || null
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/activate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    denyClientWrites(req.user!.role);
    const existing = await prisma.payerRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Requirement not found' });
    if (existing.scope === DirectoryScope.PLATFORM && !canManagePlatformRequirements(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (existing.scope === DirectoryScope.TENANT) {
      if (existing.tenantId !== req.tenantContext!.tenantId) return res.status(404).json({ error: 'Requirement not found' });
      if (!canManageTenantRequirements(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const row = await prisma.payerRequirement.update({
      where: { id: existing.id },
      data: { status: RecordStatus.ACTIVE, lastReviewedById: req.user!.id, lastReviewedAt: new Date() }
    });
    await recordRequirementHistory({
      requirementId: row.id,
      version: row.version,
      snapshot: row,
      changedById: req.user!.id,
      changeReason: 'Activated — affects future packets only'
    });
    await audit(req, 'payer_requirement.activate', 'payerRequirements', row.id, null, { version: row.version });
    res.json({
      ...row,
      note: 'Activation affects future enrollment packet evaluations only. Existing packet snapshots are unchanged.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/deactivate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    denyClientWrites(req.user!.role);
    const existing = await prisma.payerRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Requirement not found' });
    if (existing.scope === DirectoryScope.PLATFORM && !canManagePlatformRequirements(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (existing.scope === DirectoryScope.TENANT) {
      if (existing.tenantId !== req.tenantContext!.tenantId) return res.status(404).json({ error: 'Requirement not found' });
      if (!canManageTenantRequirements(req.user!.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const row = await prisma.payerRequirement.update({
      where: { id: existing.id },
      data: { status: RecordStatus.INACTIVE, lastReviewedById: req.user!.id, lastReviewedAt: new Date() }
    });
    await recordRequirementHistory({
      requirementId: row.id,
      version: row.version,
      snapshot: row,
      changedById: req.user!.id,
      changeReason: 'Deactivated — existing packet snapshots preserved'
    });
    await audit(req, 'payer_requirement.deactivate', 'payerRequirements', row.id, null, { version: row.version });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
