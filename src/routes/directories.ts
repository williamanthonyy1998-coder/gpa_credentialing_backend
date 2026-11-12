import { Router, Response, NextFunction } from 'express';
import { Role, RecordStatus, DirectoryScope } from '@prisma/client';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import {
  createDirectoryRecord,
  deleteDirectoryRecord,
  getDirectoryRecord,
  getDirectoryEntityType,
  isDirectoryResource,
  linkBillingEntityPractice,
  listDirectoryRecords,
  resolveCredentialCategories,
  unlinkBillingEntityPractice,
  updateDirectoryRecord
} from '../services/directories';
import { DOCUMENT_CATEGORIES, DOCUMENT_TYPES_BY_CATEGORY } from '../services/credentials';

const router = Router();

function canWrite(role: Role) {
  return !([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role);
}

function parseStatus(raw: unknown): RecordStatus | undefined {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return undefined;
  if (['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED'].includes(s)) return s as RecordStatus;
  return undefined;
}

router.get('/credentialCategories/resolved', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.tenantContext?.tenantId ?? null;
    const rows = await resolveCredentialCategories(tenantId);
    if (rows.length) {
      return res.json(
        rows.map((c) => ({
          key: c.code,
          label: c.name,
          types: (c.documentTypes as unknown[]) ?? [],
          scope: c.scope,
          tenantId: c.tenantId,
          id: c.id
        }))
      );
    }
  const fallback = DOCUMENT_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    types: DOCUMENT_TYPES_BY_CATEGORY[c.key as keyof typeof DOCUMENT_TYPES_BY_CATEGORY] ?? c.types
  }));
    res.json(fallback);
  } catch (e) {
    next(e);
  }
});

router.post('/billingEntities/:id/practices', async (req: AuthRequest, res, next) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const practiceId = String(req.body?.practiceId || '').trim();
    if (!practiceId) return res.status(400).json({ error: 'practiceId is required' });
    const row = await linkBillingEntityPractice(req.params.id, practiceId, req.tenantContext);
    await audit(req, 'LINK_PRACTICE', 'billingEntities', req.params.id, undefined, { practiceId });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.delete('/billingEntities/:id/practices/:practiceId', async (req: AuthRequest, res, next) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    await unlinkBillingEntityPractice(req.params.id, req.params.practiceId, req.tenantContext);
    await audit(req, 'UNLINK_PRACTICE', 'billingEntities', req.params.id, { practiceId: req.params.practiceId }, undefined);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.get('/:resource', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource;
    if (!isDirectoryResource(resource)) return res.status(404).json({ error: 'Unknown directory resource' });
    const scopeRaw = String(req.query.scope || '').trim().toUpperCase();
    const scope =
      scopeRaw === 'PLATFORM' || scopeRaw === 'TENANT' ? (scopeRaw as DirectoryScope) : undefined;
    const pageParam = req.query.page;
    const wantsPagination = pageParam !== undefined && String(pageParam).length > 0;
    const page = Math.max(1, Number(pageParam) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const result = await listDirectoryRecords(
      resource,
      {
        q: String(req.query.q || ''),
        status: parseStatus(req.query.status),
        page: wantsPagination ? page : 1,
        pageSize: wantsPagination ? pageSize : Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
        scope
      },
      req.tenantContext
    );
    if (wantsPagination) return res.json(result);
    res.json(result.data);
  } catch (e) {
    next(e);
  }
});

router.get('/:resource/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource;
    if (!isDirectoryResource(resource)) return res.status(404).json({ error: 'Unknown directory resource' });
    const row = await getDirectoryRecord(resource, req.params.id, req.tenantContext);
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.post('/:resource', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource;
    if (!isDirectoryResource(resource)) return res.status(404).json({ error: 'Unknown directory resource' });
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const row = await createDirectoryRecord(resource, req.body, req.tenantContext, req.user!.role);
    await audit(req, 'CREATE', getDirectoryEntityType(resource), row.id, undefined, row);
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:resource/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource;
    if (!isDirectoryResource(resource)) return res.status(404).json({ error: 'Unknown directory resource' });
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const before = await getDirectoryRecord(resource, req.params.id, req.tenantContext);
    const row = await updateDirectoryRecord(resource, req.params.id, req.body, req.tenantContext, req.user!.role);
    await audit(req, 'UPDATE', getDirectoryEntityType(resource), row.id, before, row);
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.delete('/:resource/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource;
    if (!isDirectoryResource(resource)) return res.status(404).json({ error: 'Unknown directory resource' });
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const before = await getDirectoryRecord(resource, req.params.id, req.tenantContext);
    const row = await deleteDirectoryRecord(resource, req.params.id, req.tenantContext, req.user!.role);
    await audit(
      req,
      row ? 'DEACTIVATE' : 'DELETE',
      getDirectoryEntityType(resource),
      req.params.id,
      before,
      row || undefined
    );
    if (row) res.json(row);
    else res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
