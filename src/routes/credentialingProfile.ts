import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import { prisma } from '../lib/prisma';
import {
  getUnifiedCredentialingProfile,
  runProfileConsistencyChecks
} from '../services/credentialingProfile';
import {
  assessProviderReadiness,
  listTenantReadiness,
  type ReadinessAudience
} from '../services/credentialingReadiness';
import {
  attemptResolveGap,
  listCredentialingGaps,
  syncCredentialingGaps
} from '../services/credentialingGaps';
import {
  completeProfileReview,
  getProfileReview,
  listProfileReviewHistory,
  requestProfileCorrections,
  startProfileReview,
  submitProfileCorrections,
  canViewInternalReviewNotes
} from '../services/profileReview';
import { assertProviderOwnsConvertedProvider } from '../services/professionalHistory';

const router = Router();

function audienceFor(req: AuthRequest): ReadinessAudience {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider';
  if (req.user?.role === Role.CLIENT_USER) return 'client';
  return 'gpa';
}

async function resolveProviderOwnership(req: AuthRequest, providerId: string) {
  if (req.user!.role === Role.EXTERNAL_PROVIDER) {
    await assertProviderOwnsConvertedProvider(req.user!.id, providerId);
    const intake = await prisma.intakeRequest.findFirst({
      where: { providerUserId: req.user!.id, convertedProviderId: providerId },
      select: { tenantId: true }
    });
    if (!intake?.tenantId) {
      const err: any = new Error('Provider profile not found');
      err.status = 404;
      throw err;
    }
    return intake.tenantId;
  }
  requireTenantContext(req.tenantContext);
  return req.tenantContext!.tenantId!;
}

function stripGpaOnly(payload: any, audience: ReadinessAudience) {
  if (audience === 'gpa') return payload;
  if (payload?.profileReview) {
    delete payload.profileReview.internalNotes;
    delete payload.profileReview.startedById;
    delete payload.profileReview.completedById;
  }
  if (payload?.readiness?.dimensions) {
    // Client/provider see dimensions and client-visible notes only.
  }
  return payload;
}

router.get('/credentialing/readiness', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const data = await listTenantReadiness(req.tenantContext!.tenantId!, {
      providerId: typeof req.query.providerId === 'string' ? req.query.providerId : undefined,
      overall: typeof req.query.overall === 'string' ? req.query.overall : undefined,
      specialtyId: typeof req.query.specialtyId === 'string' ? req.query.specialtyId : undefined,
      missingInformation: req.query.missingInformation === '1',
      pendingVerification: req.query.pendingVerification === '1',
      expiredCredentials: req.query.expiredCredentials === '1',
      rejectedEvidence: req.query.rejectedEvidence === '1',
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0
    });
    res.json(data);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/credentialing-profile', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const audience = audienceFor(req);
    const profile = await getUnifiedCredentialingProfile(tenantId, req.params.providerId, audience, {
      syncGaps: req.query.syncGaps === '1',
      actorId: req.user?.id
    });
    res.json(stripGpaOnly(profile, audience));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/readiness', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const audience = audienceFor(req);
    const readiness = await assessProviderReadiness(tenantId, req.params.providerId, audience);
    if (audience !== 'gpa' && readiness.profileReview) {
      delete (readiness.profileReview as any).internalNotes;
      delete (readiness.profileReview as any).startedById;
      delete (readiness.profileReview as any).completedById;
    }
    res.json(readiness);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/gaps', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    if (req.query.recalc === '1') {
      await syncCredentialingGaps(tenantId, req.params.providerId, req.user?.id, audienceFor(req));
    }
    const gaps = await listCredentialingGaps(tenantId, req.params.providerId, {
      includeResolved: req.query.includeResolved === '1'
    });
    res.json({ providerId: req.params.providerId, tenantId, gaps });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/gaps/recalculate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const result = await syncCredentialingGaps(tenantId, req.params.providerId, req.user?.id, audienceFor(req));
    await audit(req, 'credentialing.gaps.recalculate', 'Provider', req.params.providerId, null, {
      sync: result.sync,
      overall: result.assessment.overall
    });
    res.json({
      sync: result.sync,
      overall: result.assessment.overall,
      gaps: result.gaps,
      disclaimer: result.assessment.disclaimer
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/gaps/:taskId/resolve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const result = await attemptResolveGap(tenantId, req.params.providerId, req.params.taskId, req.user?.id);
    await audit(req, 'credentialing.gaps.resolve', 'Task', req.params.taskId, null, {
      providerId: req.params.providerId,
      resolved: true
    });
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/consistency', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    if (audienceFor(req) !== 'gpa') {
      return res.status(403).json({ error: 'Consistency checks are GPA-only' });
    }
    const findings = await runProfileConsistencyChecks(tenantId, req.params.providerId);
    res.json(findings);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/review', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const audience = audienceFor(req);
    const review = await getProfileReview(tenantId, req.params.providerId, audience);
    res.json(review);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/review/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    if (!canViewInternalReviewNotes(req.user!.role) && req.user!.role !== Role.CLIENT_USER) {
      // External providers get limited history via review status only.
      const review = await getProfileReview(tenantId, req.params.providerId, audienceFor(req));
      return res.json({ items: review ? [{ status: review.status, updatedAt: review.updatedAt }] : [] });
    }
    const items = await listProfileReviewHistory(tenantId, req.params.providerId);
    res.json({ items });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/review/start', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId!;
    const body = z.object({ internalNotes: z.string().max(4000).optional() }).parse(req.body || {});
    const before = await getProfileReview(tenantId, req.params.providerId, 'gpa');
    const review = await startProfileReview(
      tenantId,
      req.params.providerId,
      req.user!.id,
      req.user!.role,
      body
    );
    await audit(req, 'credentialing.review.start', 'ProviderProfileReview', review!.id, before, {
      providerId: req.params.providerId,
      status: review!.status
      // internalNotes intentionally omitted from audit payload beyond redact — still avoid storing long notes
    });
    res.json({
      review,
      notice: 'Profile review started. This does not verify individual licenses or history records.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/review/request-corrections', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId!;
    const body = z.object({
      clientVisibleNotes: z.string().min(1).max(4000),
      internalNotes: z.string().max(4000).optional()
    }).parse(req.body || {});
    const before = await getProfileReview(tenantId, req.params.providerId, 'gpa');
    const review = await requestProfileCorrections(
      tenantId,
      req.params.providerId,
      req.user!.id,
      req.user!.role,
      body
    );
    await audit(req, 'credentialing.review.request_corrections', 'ProviderProfileReview', review!.id, before, {
      providerId: req.params.providerId,
      status: review!.status,
      clientVisibleNotes: body.clientVisibleNotes.slice(0, 500)
    });
    res.json({ review });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/review/submit-corrections', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const before = await getProfileReview(tenantId, req.params.providerId, audienceFor(req));
    const review = await submitProfileCorrections(
      tenantId,
      req.params.providerId,
      req.user!.id,
      req.user!.role
    );
    await audit(req, 'credentialing.review.submit_corrections', 'ProviderProfileReview', review!.id, before, {
      providerId: req.params.providerId,
      status: review!.status
    });
    res.json({
      review,
      notice: 'Corrections submitted for reassessment. This does not self-verify licenses or history.'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId/review/complete', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId!;
    const body = z.object({ internalNotes: z.string().max(4000).optional() }).parse(req.body || {});
    const before = await getProfileReview(tenantId, req.params.providerId, 'gpa');
    const result = await completeProfileReview(
      tenantId,
      req.params.providerId,
      req.user!.id,
      req.user!.role,
      body
    );
    await audit(req, 'credentialing.review.complete', 'ProviderProfileReview', result.review!.id, before, {
      providerId: req.params.providerId,
      status: result.review!.status,
      readinessOverall: result.readiness.overall
    });
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
