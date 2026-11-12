import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import {
  grantProviderAuthorization,
  listProviderAuthorizations,
  revokeProviderAuthorization
} from '../services/externalIntegrations';

const router = Router({ mergeParams: true });

router.get('/integration-authorizations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const items = await listProviderAuthorizations({
      tenantId: req.tenantContext!.tenantId!,
      providerId: req.params.providerId,
      role: req.user!.role
    });
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/integration-authorizations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may record provider integration authorizations' });
    }
    const body = z.object({
      integrationId: z.string().min(1),
      authorizationType: z.string().max(80).optional(),
      expiresAt: z.coerce.date().optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      externalReference: z.string().max(200).optional().nullable(),
      scope: z.array(z.string()).optional(),
      notes: z.string().max(4000).optional().nullable()
    }).parse(req.body || {});
    const row = await grantProviderAuthorization({
      tenantId: req.tenantContext!.tenantId!,
      providerId: req.params.providerId,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'integration.authorization_grant', 'providerIntegrationAuthorizations', row.id, null, {
      providerId: req.params.providerId,
      integrationId: body.integrationId,
      status: row.status
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/integration-authorizations/:authorizationId/revoke', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const body = z.object({
      reason: z.string().max(2000).optional().nullable()
    }).parse(req.body || {});
    const row = await revokeProviderAuthorization({
      tenantId: req.tenantContext!.tenantId!,
      providerId: req.params.providerId,
      authorizationId: req.params.authorizationId,
      actorId: req.user!.id,
      role: req.user!.role,
      reason: body.reason
    });
    await audit(req, 'integration.authorization_revoke', 'providerIntegrationAuthorizations', row.id, null, {
      providerId: req.params.providerId,
      status: row.status
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
