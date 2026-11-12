import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext, assertRecordInTenant } from '../services/tenantAccess';
import { recordManualIntegrationAction } from '../services/externalIntegrations';

const router = Router({ mergeParams: true });

router.post('/integrations/manual-action', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Only GPA staff may record manual integration actions' });
    }
    const body = z.object({
      integrationId: z.string().min(1),
      actionType: z.string().min(2).max(80),
      summary: z.string().min(2).max(2000),
      externalReference: z.string().max(200).optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable(),
      channel: z.string().max(40).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      createCommunication: z.boolean().optional(),
      idempotencyKey: z.string().max(200).optional().nullable()
    }).parse(req.body || {});

    const result = await recordManualIntegrationAction({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });

    await audit(req, 'integration.manual_action', 'enrollments', req.params.id, null, {
      operationId: result.operation.id,
      integrationId: body.integrationId,
      actionType: body.actionType,
      enrollmentStatus: result.enrollmentStatus,
      apiSuccessClaimed: false
    });

    res.status(201).json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
