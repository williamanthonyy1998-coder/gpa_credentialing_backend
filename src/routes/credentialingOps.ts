import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import { prisma } from '../lib/prisma';
import {
  evaluateCredentialingDeadlines,
  getCredentialRenewalWorklist,
  getDeadlineDashboardExtras,
  listCredentialingDeadlines
} from '../services/credentialingDeadlines';
import {
  buildExcelReportBuffer,
  buildPdfReportBuffer,
  canExportReports,
  canViewReports,
  credentialsReport,
  enrollmentStatusReport,
  payerPerformanceReport,
  revalidationReport
} from '../services/credentialingReports';
import {
  getRevalidationDashboardCounts,
  getRevalidationWorklist,
  sanitizeRevalidationForAudience
} from '../services/enrollmentRevalidation';

const router = Router();

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

router.get('/deadlines', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    const withinDays = req.query.withinDays ? Number(req.query.withinDays) : 120;
    const includeOverdue = req.query.includeOverdue !== '0';
    const data = await listCredentialingDeadlines({
      tenantId: req.tenantContext!.tenantId!,
      withinDays,
      includeOverdue
    });
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/deadlines/evaluate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      windows: z.array(z.number().int().min(0).max(365)).optional()
    }).parse(req.body || {});
    const result = await evaluateCredentialingDeadlines({
      tenantId: req.tenantContext!.tenantId!,
      actorId: req.user!.id,
      role: req.user!.role,
      windows: body.windows
    });
    await audit(req, 'credentialing.deadlines.evaluate', 'tasks', undefined, null, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/revalidation-worklist', async (req: AuthRequest, res: Response, next: NextFunction) => {
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

router.get('/renewal-worklist', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Renewal worklist is available to GPA staff only' });
    }
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    const data = await getCredentialRenewalWorklist({
      tenantId: req.tenantContext!.tenantId!,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25
    });
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/ops-dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    const tenantId = req.tenantContext!.tenantId!;
    const [reval, deadlines] = await Promise.all([
      getRevalidationDashboardCounts(tenantId),
      getDeadlineDashboardExtras(tenantId)
    ]);
    res.json({ revalidations: reval, credentials: deadlines });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/enrollments', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    const data = await enrollmentStatusReport(req.tenantContext!.tenantId!, audienceFor(req) === 'gpa' ? 'gpa' : 'client');
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/revalidations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    if (req.user!.role === Role.CLIENT_USER) {
      const data = await revalidationReport(req.tenantContext!.tenantId!);
      // Sanitize: drop assigned workload emails-level detail for clients already id-only
      res.json({
        report: data.report,
        generatedAt: data.generatedAt,
        dashboard: data.dashboard,
        dueThisMonth: data.dueThisMonth,
        dueNextMonth: data.dueNextMonth,
        note: data.note
      });
      return;
    }
    res.json(await revalidationReport(req.tenantContext!.tenantId!));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/credentials', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    res.json(await credentialsReport(req.tenantContext!.tenantId!));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/payer-performance', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canViewReports(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
    res.json(await payerPerformanceReport(
      req.tenantContext!.tenantId!,
      req.query.from ? String(req.query.from) : null,
      req.query.to ? String(req.query.to) : null
    ));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/export.xlsx', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canExportReports(req.user!.role)) {
      return res.status(403).json({ error: 'Export not permitted for this role' });
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantContext!.tenantId! },
      select: { name: true }
    });
    const buf = await buildExcelReportBuffer({
      tenantId: req.tenantContext!.tenantId!,
      tenantName: tenant?.name,
      audience: audienceFor(req) === 'gpa' ? 'gpa' : 'client',
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null
    });
    await audit(req, 'credentialing.reports.export_xlsx', 'reports', undefined, null, {
      bytes: buf.length
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="credentialing-report.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/reports/export.pdf', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canExportReports(req.user!.role)) {
      return res.status(403).json({ error: 'Export not permitted for this role' });
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantContext!.tenantId! },
      select: { name: true }
    });
    const buf = await buildPdfReportBuffer({
      tenantId: req.tenantContext!.tenantId!,
      tenantName: tenant?.name,
      audience: audienceFor(req) === 'gpa' ? 'gpa' : 'client',
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null
    });
    await audit(req, 'credentialing.reports.export_pdf', 'reports', undefined, null, {
      bytes: buf.length
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="credentialing-report.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
