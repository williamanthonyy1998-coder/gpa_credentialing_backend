import { Router, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import { prisma } from '../lib/prisma';
import {
  archiveLicense,
  assertLicenseInTenant,
  canReviewLicense,
  canVerifyLicense,
  canWriteLicenseAsClient,
  canWriteLicenseAsStaff,
  createLicense,
  getLicenseExpirationSummary,
  getLicenseHistory,
  listProviderLicenses,
  rejectLicense,
  renewLicense,
  requestLicenseCorrection,
  submitLicenseForReview,
  updateLicense,
  verifyLicense,
  type LicenseAudience
} from '../services/licenseLifecycle';
import { getProviderCredentialCompleteness } from '../services/credentialCompleteness';

const router = Router();

function audienceFor(req: AuthRequest): LicenseAudience {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider';
  if (req.user?.role === Role.CLIENT_USER) return 'client';
  return 'gpa';
}

function assertCanWrite(req: AuthRequest) {
  const role = req.user!.role;
  if (role === Role.EXTERNAL_PROVIDER) return;
  if (role === Role.CLIENT_USER) {
    if (!canWriteLicenseAsClient(req.tenantContext?.tenantRole)) {
      const err: any = new Error('Insufficient permissions');
      err.status = 403;
      throw err;
    }
    return;
  }
  if (!canWriteLicenseAsStaff(role)) {
    const err: any = new Error('Insufficient permissions');
    err.status = 403;
    throw err;
  }
}

async function resolveProviderOwnership(req: AuthRequest, providerId: string) {
  if (req.user!.role === Role.EXTERNAL_PROVIDER) {
    const intake = await prisma.intakeRequest.findFirst({
      where: { providerUserId: req.user!.id, convertedProviderId: providerId },
      select: { tenantId: true }
    });
    if (!intake?.tenantId) {
      const err: any = new Error('License records not found');
      err.status = 404;
      throw err;
    }
    return intake.tenantId;
  }
  requireTenantContext(req.tenantContext);
  return req.tenantContext!.tenantId!;
}

router.get('/expiration-summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const summary = await getLicenseExpirationSummary(req.tenantContext!.tenantId!, {
      providerId: typeof req.query.providerId === 'string' ? req.query.providerId : undefined,
      licenseTypeId: typeof req.query.licenseTypeId === 'string' ? req.query.licenseTypeId : undefined,
      usStateId: typeof req.query.usStateId === 'string' ? req.query.usStateId : undefined,
      state: typeof req.query.state === 'string' ? req.query.state : undefined
    });
    res.json(summary);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const audience = audienceFor(req);
    const licenses = await listProviderLicenses(tenantId, req.params.providerId, audience, {
      includeArchived: req.query.includeArchived === '1'
    });
    res.json(licenses);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/providers/:providerId/completeness', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    if (audienceFor(req) === 'provider') {
      // Providers get counts without GPA reviewer notes
      const data = await getProviderCredentialCompleteness(tenantId, req.params.providerId);
      res.json({
        counts: data.counts,
        unresolved: data.unresolved,
        labels: data.labels,
        disclaimer: data.disclaimer,
        licenses: data.licenses.map((l) => ({
          id: l.id,
          label: l.label,
          attention: l.attention,
          verificationStatus: l.verificationStatus,
          informationComplete: l.informationComplete,
          verified: l.verified,
          expired: l.expired,
          pending: l.pending,
          rejected: l.rejected
        }))
      });
      return;
    }
    res.json(await getProviderCredentialCompleteness(tenantId, req.params.providerId));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/providers/:providerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    const tenantId = await resolveProviderOwnership(req, req.params.providerId);
    const row = await createLicense({
      tenantId,
      providerId: req.params.providerId,
      body: req.body || {},
      actorId: req.user!.id,
      audience: audienceFor(req)
    });
    await audit(req, 'LICENSE_CREATE', 'licenses', row.id, undefined, {
      providerId: req.params.providerId,
      verificationStatus: row.verificationStatus,
      attention: row.attention
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    requireTenantContext(req.tenantContext);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      const before = await prisma.license.findUnique({ where: { id: req.params.id } });
      if (!before) return res.status(404).json({ error: 'License not found' });
      const tenantId = await resolveProviderOwnership(req, before.providerId);
      const row = await updateLicense({
        tenantId,
        licenseId: req.params.id,
        body: req.body || {},
        actorId: req.user!.id,
        audience: 'provider'
      });
      await audit(req, 'LICENSE_UPDATE', 'licenses', req.params.id, undefined, {
        verificationStatus: row.verificationStatus
      });
      return res.json(row);
    }
    const tenantId = req.tenantContext!.tenantId!;
    const row = await updateLicense({
      tenantId,
      licenseId: req.params.id,
      body: req.body || {},
      actorId: req.user!.id,
      audience: audienceFor(req)
    });
    await audit(req, 'LICENSE_UPDATE', 'licenses', req.params.id, undefined, {
      verificationStatus: row.verificationStatus
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/submit', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    let tenantId: string;
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      const before = await prisma.license.findUnique({ where: { id: req.params.id } });
      if (!before) return res.status(404).json({ error: 'License not found' });
      tenantId = await resolveProviderOwnership(req, before.providerId);
    } else {
      requireTenantContext(req.tenantContext);
      tenantId = req.tenantContext!.tenantId!;
    }
    const row = await submitLicenseForReview(tenantId, req.params.id, req.user!.id);
    await audit(req, 'LICENSE_SUBMIT', 'licenses', req.params.id, undefined, {
      verificationStatus: row.verificationStatus
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/verify', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canVerifyLicense(req.user!.role)) {
      return res.status(403).json({ error: 'Only authorized reviewers can verify licenses' });
    }
    requireTenantContext(req.tenantContext);
    const body = z.object({
      reviewerNotes: z.string().max(4000).optional().nullable(),
      verificationSource: z.string().optional().nullable(),
      evidenceDocumentId: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await verifyLicense(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      body
    );
    await audit(req, 'LICENSE_VERIFY', 'licenses', req.params.id, undefined, {
      verificationStatus: row.verificationStatus,
      verificationSource: body.verificationSource || 'manual_document_review',
      evidenceDocumentId: body.evidenceDocumentId || null
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReviewLicense(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    requireTenantContext(req.tenantContext);
    const body = z.object({
      reason: z.string().min(2),
      reviewerNotes: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await rejectLicense(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      body.reason,
      { reviewerNotes: body.reviewerNotes }
    );
    await audit(req, 'LICENSE_REJECT', 'licenses', req.params.id, undefined, { reason: body.reason });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/request-correction', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReviewLicense(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    requireTenantContext(req.tenantContext);
    const body = z.object({ comments: z.string().min(2) }).parse(req.body || {});
    const row = await requestLicenseCorrection(
      req.tenantContext!.tenantId!,
      req.params.id,
      req.user!.id,
      body.comments
    );
    await audit(req, 'LICENSE_CORRECTION_REQUEST', 'licenses', req.params.id, undefined, {
      comments: body.comments
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/renew', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    let tenantId: string;
    let audience = audienceFor(req);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      const before = await prisma.license.findUnique({ where: { id: req.params.id } });
      if (!before) return res.status(404).json({ error: 'License not found' });
      tenantId = await resolveProviderOwnership(req, before.providerId);
      audience = 'provider';
    } else {
      requireTenantContext(req.tenantContext);
      tenantId = req.tenantContext!.tenantId!;
    }
    const row = await renewLicense({
      tenantId,
      licenseId: req.params.id,
      body: req.body || {},
      actorId: req.user!.id,
      audience
    });
    await audit(req, 'LICENSE_RENEW', 'licenses', row.id, undefined, {
      renewedFromId: req.params.id,
      verificationStatus: row.verificationStatus
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:id/archive', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Providers cannot archive licenses' });
    }
    assertCanWrite(req);
    requireTenantContext(req.tenantContext);
    const row = await archiveLicense(req.tenantContext!.tenantId!, req.params.id, req.user!.id);
    await audit(req, 'LICENSE_ARCHIVE', 'licenses', req.params.id, undefined, {});
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id/history', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    res.json(await getLicenseHistory(req.tenantContext!.tenantId!, req.params.id));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const lic = await assertLicenseInTenant(req.tenantContext!.tenantId!, req.params.id);
    const full = await prisma.license.findUnique({
      where: { id: lic.id },
      include: { licenseType: true, usState: true, renewals: true, renewedFrom: true }
    });
    const { annotateLicense } = await import('../services/licenseLifecycle');
    res.json(annotateLicense(full, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
