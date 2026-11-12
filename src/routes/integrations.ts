import { Router, Response, NextFunction } from 'express';
import {
  ExternalConnectionMode,
  ExternalIntegrationStatus,
  ExternalIntegrationType,
  Role
} from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import {
  configureIntegrationCredentials,
  createTenantIntegration,
  getIntegration,
  getOperation,
  listIntegrations,
  listOperations,
  runUnsupportedExternalOperation,
  testIntegrationConnection,
  updateIntegration
} from '../services/externalIntegrations';

const router = Router();

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const items = await listIntegrations({
      tenantId: req.tenantContext!.tenantId!,
      role: req.user!.role,
      audience: audienceFor(req)
    });
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Clients and external providers cannot configure integrations' });
    }
    const body = z.object({
      integrationType: z.nativeEnum(ExternalIntegrationType),
      displayName: z.string().min(2).max(200),
      systemName: z.string().min(2).max(120),
      connectionMode: z.nativeEnum(ExternalConnectionMode).optional(),
      status: z.nativeEnum(ExternalIntegrationStatus).optional(),
      feasibilityNotes: z.string().max(8000).optional().nullable(),
      officialSourceUrl: z.string().max(2000).optional().nullable(),
      cloneFromPlatformId: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await createTenantIntegration({
      tenantId: req.tenantContext!.tenantId!,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'integration.create', 'externalIntegrations', row.id, null, {
      integrationType: row.integrationType,
      status: row.status
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/operations/:operationId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const row = await getOperation({
      tenantId: req.tenantContext!.tenantId!,
      operationId: req.params.operationId,
      role: req.user!.role
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const row = await getIntegration({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      role: req.user!.role,
      audience: audienceFor(req)
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      displayName: z.string().min(2).max(200).optional(),
      status: z.nativeEnum(ExternalIntegrationStatus).optional(),
      connectionMode: z.nativeEnum(ExternalConnectionMode).optional(),
      feasibilityNotes: z.string().max(8000).optional().nullable(),
      officialSourceUrl: z.string().max(2000).optional().nullable(),
      disabled: z.boolean().optional()
    }).parse(req.body || {});
    const row = await updateIntegration({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'integration.update', 'externalIntegrations', row.id, null, {
      status: row.status,
      connectionMode: row.connectionMode
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/credentials', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      envVarName: z.string().max(120).optional().nullable(),
      awsSecretId: z.string().max(500).optional().nullable(),
      /** Dev/test only — never returned; sets process env for env: refs */
      localSecretValue: z.string().max(4000).optional().nullable()
    }).parse(req.body || {});
    const row = await configureIntegrationCredentials({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'integration.credentials_configure', 'externalIntegrations', row.id, null, {
      credentialConfigured: row.credentialConfigured,
      credentialBackend: row.credentialBackend,
      // never audit secret values
      hasLocalSecretValue: Boolean(body.localSecretValue)
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/test-connection', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const result = await testIntegrationConnection({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role
    });
    await audit(req, 'integration.test_connection', 'externalIntegrations', req.params.id, null, {
      ok: result.ok,
      code: result.code,
      operationId: result.operationId
    });
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id/operations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const items = await listOperations({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      role: req.user!.role
    });
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/operations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      operationType: z.string().min(2).max(120),
      providerId: z.string().optional().nullable(),
      enrollmentId: z.string().optional().nullable(),
      idempotencyKey: z.string().max(200).optional().nullable()
    }).parse(req.body || {});
    const op = await runUnsupportedExternalOperation({
      tenantId: req.tenantContext!.tenantId!,
      integrationId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'integration.operation', 'externalIntegrationOperations', op.id, null, {
      operationType: op.operationType,
      operationStatus: op.operationStatus
    });
    res.status(201).json(op);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
