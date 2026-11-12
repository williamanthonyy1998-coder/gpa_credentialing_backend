import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { assertRecordInTenant, requireTenantContext } from '../services/tenantAccess';
import {
  attachPacketEvidence,
  evaluateEnrollmentPacket,
  getLatestPacket,
  listPacketHistory,
  reviewPacketItem,
  sanitizePacketForAudience,
  waivePacketItem
} from '../services/enrollmentPacket';
import { prisma } from '../lib/prisma';

const router = Router({ mergeParams: true });

function audienceFor(req: AuthRequest) {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider' as const;
  if (req.user?.role === Role.CLIENT_USER) return 'client' as const;
  return 'gpa' as const;
}

router.get('/packet', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const packet = await getLatestPacket(req.tenantContext!.tenantId!, req.params.id);
    if (!packet) return res.json({ packet: null, note: 'No packet evaluated yet' });
    res.json({
      packet: sanitizePacketForAudience(packet, audienceFor(req)),
      enrollmentId: req.params.id
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/packet/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const items = await listPacketHistory(req.tenantContext!.tenantId!, req.params.id);
    const audience = audienceFor(req);
    res.json({
      items: items.map((row) => sanitizePacketForAudience(row, audience))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/packet/requirements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const packet = await getLatestPacket(req.tenantContext!.tenantId!, req.params.id);
    if (!packet) return res.json({ items: [] });
    const sanitized = sanitizePacketForAudience(packet, audienceFor(req));
    res.json({ items: sanitized.items, packetStatus: packet.status, version: packet.version });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/packet/evaluate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'External providers cannot evaluate enrollment packets' });
    }
    const before = await prisma.enrollmentApplication.findUnique({
      where: { id: req.params.id },
      select: { status: true }
    });
    const result = await evaluateEnrollmentPacket({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      actorId: req.user!.id,
      role: req.user!.role,
      forceNewVersion: true
    });
    await audit(req, 'enrollment.packet_evaluate', 'enrollments', req.params.id, null, {
      packetId: result.packet.id,
      version: result.packet.version,
      packetStatus: result.packet.status,
      enrollmentStatus: before?.status
    });
    res.json({
      ...result,
      packet: sanitizePacketForAudience(result.packet, audienceFor(req)),
      enrollmentStatus: before?.status,
      note: 'Packet readiness is internal only and does not change enrollment lifecycle status or submit to a payer.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/packet/requirements/:requirementId/evidence', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({ documentId: z.string().min(1) }).parse(req.body || {});
    const item = await attachPacketEvidence({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      itemId: req.params.requirementId,
      documentId: body.documentId,
      actorId: req.user!.id,
      role: req.user!.role
    });
    await audit(req, 'enrollment.packet_evidence', 'enrollments', req.params.id, null, {
      itemId: item.id,
      documentId: body.documentId
    });
    res.json(item);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/packet/requirements/:requirementId/review', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Clients and providers cannot verify or reject packet requirements' });
    }
    const body = z.object({
      decision: z.enum(['VERIFY', 'REJECT', 'NOT_APPLICABLE', 'REQUEST_CORRECTION']),
      reason: z.string().max(4000).optional().nullable(),
      reviewNotes: z.string().max(4000).optional().nullable(),
      internalNotes: z.string().max(4000).optional().nullable()
    }).parse(req.body || {});
    const item = await reviewPacketItem({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      itemId: req.params.requirementId,
      actorId: req.user!.id,
      role: req.user!.role,
      ...body
    });
    await audit(req, 'enrollment.packet_review', 'enrollments', req.params.id, null, {
      itemId: item.id,
      decision: body.decision
    });
    res.json(item);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/packet/requirements/:requirementId/request-correction', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body || {});
    const item = await reviewPacketItem({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      itemId: req.params.requirementId,
      actorId: req.user!.id,
      role: req.user!.role,
      decision: 'REQUEST_CORRECTION',
      reason: body.reason
    });
    await audit(req, 'enrollment.packet_correction', 'enrollments', req.params.id, null, { itemId: item.id });
    res.json(item);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/packet/requirements/:requirementId/waive', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    await assertRecordInTenant(req.tenantContext!, 'enrollments', req.params.id);
    if (req.user!.role === Role.CLIENT_USER || req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Clients and providers cannot waive requirements' });
    }
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body || {});
    const item = await waivePacketItem({
      tenantId: req.tenantContext!.tenantId!,
      enrollmentId: req.params.id,
      itemId: req.params.requirementId,
      actorId: req.user!.id,
      role: req.user!.role,
      reason: body.reason
    });
    await audit(req, 'enrollment.packet_waive', 'enrollments', req.params.id, null, { itemId: item.id });
    res.json(item);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
