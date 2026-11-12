import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DataQualityIssueStatus, Role } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import {
  persistAuditFindings,
  runDirectoryQualityAudit
} from '../services/directoryQualityAudit';
import {
  getDataQualityIssue,
  listDataQualityIssues,
  markDuplicateDistinct,
  updateDataQualityIssueStatus
} from '../services/dataQualityIssues';
import { commitDirectoryMerge, previewDirectoryMerge } from '../services/directoryMerge';
import { validateNpi } from '../services/npiValidation';

const router = Router();

function platformAccess(req: AuthRequest) {
  return Boolean(req.tenantContext?.platformAccess) || req.user?.role === Role.ADMIN;
}

function denyClientProvider(req: AuthRequest, res: Response): boolean {
  if (req.user?.role === Role.CLIENT_USER || req.user?.role === Role.EXTERNAL_PROVIDER) {
    res.status(403).json({ error: 'Directory quality tooling is not available for this role' });
    return true;
  }
  return false;
}

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const tenantId = req.tenantContext?.tenantId ?? null;
    if (!tenantId && !platformAccess(req)) {
      requireTenantContext(req.tenantContext);
    }
    const directoryType = String(req.query.directoryType || '').trim() || undefined;
    const auditResult = await runDirectoryQualityAudit({
      tenantId,
      platformAccess: platformAccess(req),
      directoryType
    });

    const openWhere: any = {
      status: { in: ['OPEN', 'UNDER_REVIEW', 'REOPENED'] }
    };
    if (tenantId) {
      openWhere.OR = [{ tenantId }, { tenantId: null }];
    } else {
      openWhere.tenantId = null;
    }

    const { prisma } = await import('../lib/prisma');
    const openIssues = await prisma.dataQualityIssue.count({ where: openWhere });

    res.json({
      ...auditResult,
      openTrackedIssues: openIssues
    });
  } catch (e) {
    next(e);
  }
});

router.post('/scan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot run quality scans' });
    }
    const tenantId = req.tenantContext?.tenantId ?? null;
    if (!tenantId && !platformAccess(req)) requireTenantContext(req.tenantContext);
    const persist = Boolean(req.body?.persist);
    const directoryType = String(req.body?.directoryType || '').trim() || undefined;
    const result = await runDirectoryQualityAudit({
      tenantId,
      platformAccess: platformAccess(req),
      directoryType
    });
    let persistence = { created: 0, updated: 0 };
    if (persist) {
      persistence = await persistAuditFindings(result.items);
      await audit(req, 'QUALITY_SCAN', 'directoryQuality', undefined, undefined, {
        findings: result.findings.total,
        ...persistence,
        directoryType: directoryType || 'all'
      });
    }
    res.json({ ...result, persistence });
  } catch (e) {
    next(e);
  }
});

router.get('/issues', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const tenantId = req.tenantContext?.tenantId ?? null;
    if (!tenantId && !platformAccess(req)) requireTenantContext(req.tenantContext);
    const result = await listDataQualityIssues({
      tenantId,
      platformAccess: platformAccess(req),
      status: String(req.query.status || '') || undefined,
      directoryType: String(req.query.directoryType || '') || undefined,
      issueType: String(req.query.issueType || '') || undefined,
      severity: String(req.query.severity || '') || undefined,
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 25
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/issues/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const tenantId = req.tenantContext?.tenantId ?? null;
    const row = await getDataQualityIssue(req.params.id, {
      tenantId,
      platformAccess: platformAccess(req)
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/issues/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const body = z.object({
      status: z.nativeEnum(DataQualityIssueStatus),
      resolutionNotes: z.string().optional().nullable(),
      assignedToId: z.string().optional().nullable()
    }).parse(req.body);
    const before = await getDataQualityIssue(req.params.id, {
      tenantId: req.tenantContext?.tenantId ?? null,
      platformAccess: platformAccess(req)
    });
    const row = await updateDataQualityIssueStatus({
      id: req.params.id,
      status: body.status,
      resolutionNotes: body.resolutionNotes,
      assignedToId: body.assignedToId,
      actorId: req.user!.id,
      role: req.user!.role,
      tenantId: req.tenantContext?.tenantId ?? null,
      platformAccess: platformAccess(req)
    });
    await audit(req, 'QUALITY_ISSUE_UPDATE', 'dataQualityIssues', row.id, before, row);
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.post('/duplicates/mark-distinct', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const body = z.object({
      directoryType: z.string().min(1),
      leftId: z.string().min(1),
      rightId: z.string().min(1),
      notes: z.string().optional().nullable()
    }).parse(req.body);
    const row = await markDuplicateDistinct({
      ...body,
      actorId: req.user!.id,
      role: req.user!.role,
      tenantId: req.tenantContext?.tenantId ?? null
    });
    await audit(req, 'DUPLICATE_MARK_DISTINCT', 'dataQualityIssues', row.id, undefined, {
      directoryType: body.directoryType,
      leftId: body.leftId,
      rightId: body.rightId
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.post('/merge/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const body = z.object({
      directoryType: z.string().min(1),
      survivorId: z.string().min(1),
      retiredId: z.string().min(1)
    }).parse(req.body);
    const preview = await previewDirectoryMerge({
      ...body,
      role: req.user!.role,
      tenantId: req.tenantContext?.tenantId ?? null
    });
    res.json(preview);
  } catch (e) {
    next(e);
  }
});

router.post('/merge/commit', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (denyClientProvider(req, res)) return;
    const body = z.object({
      directoryType: z.string().min(1),
      survivorId: z.string().min(1),
      retiredId: z.string().min(1),
      confirm: z.literal(true)
    }).parse(req.body);
    const preview = await previewDirectoryMerge({
      directoryType: body.directoryType,
      survivorId: body.survivorId,
      retiredId: body.retiredId,
      role: req.user!.role,
      tenantId: req.tenantContext?.tenantId ?? null
    });
    const result = await commitDirectoryMerge({
      ...body,
      role: req.user!.role,
      tenantId: req.tenantContext?.tenantId ?? null
    });
    await audit(req, 'DIRECTORY_MERGE', body.directoryType, body.survivorId, preview.retired, {
      survivorId: body.survivorId,
      retiredId: body.retiredId,
      relationshipCounts: result.relationshipCounts
    });
    // Close matching duplicate issue if present
    const [a, b] = body.survivorId < body.retiredId
      ? [body.survivorId, body.retiredId]
      : [body.retiredId, body.survivorId];
    const fingerprint = `dup:${body.directoryType}:${a}:${b}`;
    const { prisma } = await import('../lib/prisma');
    await prisma.dataQualityIssue.updateMany({
      where: { fingerprint, status: { in: ['OPEN', 'UNDER_REVIEW', 'REOPENED'] } },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedById: req.user!.id,
        resolutionNotes: `Merged into ${body.survivorId}; retired ${body.retiredId}`
      }
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/npi/validate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const npi = String(req.body?.npi || '');
    res.json(validateNpi(npi));
  } catch (e) {
    next(e);
  }
});

router.get('/lifecycle', async (_req: AuthRequest, res: Response) => {
  res.json({
    directories: {
      specialties: {
        hardDelete: 'Blocked when referenced; otherwise deactivate',
        inactiveOnExisting: 'Allowed for historical provider specialties',
        inactiveOnNew: 'Rejected for new assignments'
      },
      usStates: {
        hardDelete: 'Blocked when licenses reference; deactivate otherwise',
        inactiveOnExisting: 'Historical licenses remain viewable',
        inactiveOnNew: 'Rejected for new licenses'
      },
      licenseTypes: {
        hardDelete: 'Blocked when licenses reference; deactivate otherwise',
        inactiveOnExisting: 'Allowed',
        inactiveOnNew: 'Rejected'
      },
      payers: {
        hardDelete: 'Not via directory merge; operational archive via status',
        inactiveOnExisting: 'Existing enrollments keep payerPlanId',
        inactiveOnNew: 'New enrollments require ACTIVE payer+plan'
      },
      plans: {
        hardDelete: 'Cascade only with payer delete (not used in QA merge)',
        inactiveOnExisting: 'Viewable on historical applications',
        inactiveOnNew: 'Rejected'
      },
      billingEntities: {
        hardDelete: 'Tenant-owned; soft deactivate preferred on merge',
        inactiveOnExisting: 'Links preserved until remapped',
        inactiveOnNew: 'Active required for new links'
      },
      credentialCategories: {
        hardDelete: 'Never for platform; deactivate only',
        inactiveOnExisting: 'Documents with inactive category remain viewable',
        inactiveOnNew: 'Rejected for new uploads'
      }
    },
    reactivation: 'Requires write role; platform catalogs require ADMIN or CREDENTIALING_MANAGER'
  });
});

export default router;
