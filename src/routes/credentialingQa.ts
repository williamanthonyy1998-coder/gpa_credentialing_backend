import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import {
  canRunCredentialingQa,
  getCredentialingQaDashboard,
  listCredentialingQaScans,
  resolveCredentialingQaFinding,
  runCredentialingQaScan,
  evaluateProviderCredentialingQa
} from '../services/credentialingQa';
import { listDataQualityIssues, getDataQualityIssue } from '../services/dataQualityIssues';
import { VERIFICATION_SOURCES } from '../services/verificationSources';

const router = Router();

function denyClientProvider(req: AuthRequest) {
  if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
    const err: any = new Error('Credentialing QA is GPA-only');
    err.status = 403;
    throw err;
  }
}

router.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    if (!canRunCredentialingQa(req.user!.role) && req.user!.role !== Role.AUDITOR && req.user!.role !== Role.ENROLLMENT_SPECIALIST) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const data = await getCredentialingQaDashboard(req.tenantContext!.tenantId!);
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/scan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const body = z.object({
      providerId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      persist: z.boolean().optional()
    }).parse(req.body || {});
    const result = await runCredentialingQaScan({
      tenantId: req.tenantContext!.tenantId!,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'credentialing.qa.scan', 'CredentialingQaScan', result.scan.id, null, {
      providersInspected: result.scan.providersInspected,
      findingsCreated: result.scan.findingsCreated,
      status: result.scan.status
    });
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/scans', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const rows = await listCredentialingQaScans(req.tenantContext!.tenantId!);
    res.json({ items: rows });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/findings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const result = await listDataQualityIssues({
      tenantId: req.tenantContext!.tenantId!,
      platformAccess: false,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      directoryType: typeof req.query.directoryType === 'string'
        ? req.query.directoryType
        : 'credentialing.providers',
      issueType: typeof req.query.issueType === 'string' ? req.query.issueType : undefined,
      severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25
    });
    // When directoryType defaults to providers only — also allow prefix filter via query all=1
    if (req.query.all === '1' || !req.query.directoryType) {
      const { prisma } = await import('../lib/prisma');
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
      const where: any = {
        tenantId: req.tenantContext!.tenantId!,
        directoryType: { startsWith: 'credentialing.' }
      };
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.severity) where.severity = String(req.query.severity);
      if (req.query.issueType) where.issueType = String(req.query.issueType);
      if (req.query.providerId) {
        where.OR = [
          { recordId: String(req.query.providerId) },
          { details: { path: ['providerId'], equals: String(req.query.providerId) } }
        ];
      }
      const [total, data] = await Promise.all([
        prisma.dataQualityIssue.count({ where }),
        prisma.dataQualityIssue.findMany({
          where,
          include: {
            assignedTo: { select: { id: true, name: true, email: true } },
            resolvedBy: { select: { id: true, name: true, email: true } }
          },
          orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize
        })
      ]);
      return res.json({ data, total, page, pageSize });
    }
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/findings/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const row = await getDataQualityIssue(req.params.id, {
      tenantId: req.tenantContext!.tenantId!,
      platformAccess: false
    });
    if (!String(row.directoryType || '').startsWith('credentialing.')) {
      return res.status(404).json({ error: 'Finding not found' });
    }
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/findings/:id/resolve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const body = z.object({
      mode: z.enum(['RESOLVED', 'ACCEPTED_RISK', 'FALSE_POSITIVE']),
      notes: z.string().max(2000).optional()
    }).parse(req.body || {});
    const before = await getDataQualityIssue(req.params.id, {
      tenantId: req.tenantContext!.tenantId!,
      platformAccess: false
    });
    const row = await resolveCredentialingQaFinding({
      issueId: req.params.id,
      tenantId: req.tenantContext!.tenantId!,
      actorId: req.user!.id,
      role: req.user!.role,
      mode: body.mode,
      notes: body.notes
    });
    await audit(req, 'credentialing.qa.resolve', 'DataQualityIssue', row.id, before, {
      mode: body.mode,
      status: row.status
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/evaluate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    requireTenantContext(req.tenantContext);
    const result = await evaluateProviderCredentialingQa(
      req.tenantContext!.tenantId!,
      req.params.providerId
    );
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/verification-sources', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    denyClientProvider(req);
    res.json({
      sources: VERIFICATION_SOURCES,
      note: 'manual_document_review is not automated state-board verification. external_api requires a configured integration.'
    });
  } catch (e: any) {
    next(e);
  }
});

export default router;
