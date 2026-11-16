import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  OrganizationEmploymentStatus,
  OrganizationPayerParticipationStatus,
  Role
} from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { requireTenantContext } from '../services/tenantAccess';
import { audit } from '../lib/audit';
import {
  addOrganizationPayer,
  assertCanManageOrganizationWorkspace,
  assertOrgWorkspaceAccess,
  assignOrganizationEmployee,
  canManageOrganizationWorkspace,
  getOrganizationWorkspaceSummary,
  listAssignableEmployees,
  listOrganizationEmployeeTasks,
  listOrganizationEmployees,
  listOrganizationPayers,
  removeOrganizationEmployee,
  removeOrganizationPayer,
  updateOrganizationEmployee,
  updateOrganizationPayer
} from '../services/organizationWorkspace';

const router = Router({ mergeParams: true });

function orgId(req: AuthRequest) {
  return String(req.params.organizationId || '');
}

async function gateRead(req: AuthRequest) {
  requireTenantContext(req.tenantContext);
  await assertOrgWorkspaceAccess(req.user!.id, req.user!.role, orgId(req), req.tenantContext);
}

async function gateManage(req: AuthRequest) {
  await gateRead(req);
  assertCanManageOrganizationWorkspace(req.user!.role);
}

const assignEmployeeSchema = z.object({
  userId: z.string().min(1),
  department: z.string().max(120).optional().nullable(),
  jobTitle: z.string().max(120).optional().nullable(),
  employmentStatus: z.nativeEnum(OrganizationEmploymentStatus).optional(),
  responsibilities: z.string().max(2000).optional().nullable(),
  effectiveFrom: z.coerce.date().optional().nullable(),
  effectiveTo: z.coerce.date().optional().nullable()
});

const updateEmployeeSchema = assignEmployeeSchema.partial().omit({ userId: true });

const addPayerSchema = z.object({
  payerId: z.string().min(1),
  participationStatus: z.nativeEnum(OrganizationPayerParticipationStatus).optional(),
  contractReference: z.string().max(120).optional().nullable(),
  effectiveDate: z.coerce.date().optional().nullable(),
  terminationDate: z.coerce.date().optional().nullable(),
  renewalDate: z.coerce.date().optional().nullable(),
  assignedContactId: z.string().optional().nullable(),
  notes: z.string().max(4000).optional().nullable()
});

const updatePayerSchema = addPayerSchema.partial().omit({ payerId: true });

router.get('/workspace-summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateRead(req);
    const summary = await getOrganizationWorkspaceSummary(orgId(req));
    res.json({
      organizationId: orgId(req),
      ...summary,
      canManage: canManageOrganizationWorkspace(req.user!.role)
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/employees', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateRead(req);
    const rows = await listOrganizationEmployees({
      organizationId: orgId(req),
      department: String(req.query.department || '') || null,
      role: String(req.query.role || '') || null,
      employmentStatus: (String(req.query.employmentStatus || '') || null) as OrganizationEmploymentStatus | null,
      q: String(req.query.q || '') || null
    });
    res.json({
      items: rows,
      canManage: canManageOrganizationWorkspace(req.user!.role)
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/employees/assignable', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    const items = await listAssignableEmployees(req.tenantContext!);
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/employees/:assignmentId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateRead(req);
    const rows = await listOrganizationEmployees({ organizationId: orgId(req) });
    const row = rows.find((r) => r.id === req.params.assignmentId);
    if (!row) return res.status(404).json({ error: 'Assignment not found' });
    const tasks = await listOrganizationEmployeeTasks(orgId(req), row.userId);
    res.json({
      ...row,
      organizationTasks: tasks,
      // Explicit: HR assignment does not imply ACL membership.
      grantsOrganizationAccess: false
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/employees', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    // CLIENT_USER cannot reach manage gate; double-check role class.
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Client users cannot assign organization employees' });
    }
    const body = assignEmployeeSchema.parse(req.body);
    const row = await assignOrganizationEmployee({
      organizationId: orgId(req),
      ...body
    });
    await audit(req, 'ORG_EMPLOYEE_ASSIGN', 'organizationEmployees', row.id, undefined, {
      organizationId: orgId(req),
      userId: row.userId,
      employmentStatus: row.employmentStatus
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/employees/:assignmentId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    const body = updateEmployeeSchema.parse(req.body);
    const before = await listOrganizationEmployees({ organizationId: orgId(req) });
    const existing = before.find((r) => r.id === req.params.assignmentId);
    const row = await updateOrganizationEmployee({
      organizationId: orgId(req),
      assignmentId: req.params.assignmentId,
      ...body
    });
    await audit(req, 'ORG_EMPLOYEE_UPDATE', 'organizationEmployees', row.id, existing, row);
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.delete('/employees/:assignmentId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    const result = await removeOrganizationEmployee(orgId(req), req.params.assignmentId);
    await audit(req, 'ORG_EMPLOYEE_REMOVE', 'organizationEmployees', req.params.assignmentId, {
      organizationId: orgId(req)
    }, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/payers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateRead(req);
    const renewalBefore = req.query.renewalBefore
      ? new Date(String(req.query.renewalBefore))
      : null;
    const rows = await listOrganizationPayers({
      organizationId: orgId(req),
      participationStatus: (String(req.query.participationStatus || '') || null) as OrganizationPayerParticipationStatus | null,
      renewalBefore: renewalBefore && !Number.isNaN(renewalBefore.getTime()) ? renewalBefore : null,
      q: String(req.query.q || '') || null
    });
    res.json({
      items: rows,
      canManage: canManageOrganizationWorkspace(req.user!.role)
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/payers/:relationshipId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateRead(req);
    const rows = await listOrganizationPayers({ organizationId: orgId(req) });
    const row = rows.find((r) => r.id === req.params.relationshipId);
    if (!row) return res.status(404).json({ error: 'Payer relationship not found' });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/payers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Client users cannot manage payer contracts' });
    }
    const body = addPayerSchema.parse(req.body);
    const row = await addOrganizationPayer({
      organizationId: orgId(req),
      ...body
    });
    await audit(req, 'ORG_PAYER_ADD', 'organizationPayers', row.id, undefined, {
      organizationId: orgId(req),
      payerId: row.payerId,
      participationStatus: row.participationStatus
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/payers/:relationshipId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    const body = updatePayerSchema.parse(req.body);
    const beforeList = await listOrganizationPayers({ organizationId: orgId(req) });
    const before = beforeList.find((r) => r.id === req.params.relationshipId);
    const row = await updateOrganizationPayer({
      organizationId: orgId(req),
      relationshipId: req.params.relationshipId,
      ...body
    });
    await audit(req, 'ORG_PAYER_UPDATE', 'organizationPayers', row.id, before, row);
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.delete('/payers/:relationshipId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await gateManage(req);
    const result = await removeOrganizationPayer(orgId(req), req.params.relationshipId);
    await audit(req, 'ORG_PAYER_REMOVE', 'organizationPayers', req.params.relationshipId, {
      organizationId: orgId(req)
    }, result);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
