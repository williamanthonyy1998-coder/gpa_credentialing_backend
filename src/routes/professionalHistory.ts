import { Router, Response, NextFunction } from 'express';
import { ProfessionalHistorySection, Role } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { requireTenantContext } from '../services/tenantAccess';
import {
  archiveHistoryRecord,
  assertProviderOwnsConvertedProvider,
  canReviewHistory,
  canVerifyHistory,
  canWriteHistoryAsClient,
  canWriteHistoryAsStaff,
  createBoardCertification,
  createEducation,
  createEmployment,
  createFellowship,
  createHospitalAffiliation,
  createMalpractice,
  createProfessionalCertification,
  createResidency,
  getHistorySummary,
  linkHistoryDocument,
  listHistorySection,
  rejectHistoryRecord,
  sanitizeHistoryRecord,
  updateHistoryRecord,
  verifyHistoryRecord,
  type HistoryAudience
} from '../services/professionalHistory';

const router = Router({ mergeParams: true });

const SECTIONS = Object.values(ProfessionalHistorySection);

function parseSection(raw: string): ProfessionalHistorySection {
  const s = String(raw || '').toUpperCase().replace(/-/g, '_');
  const map: Record<string, ProfessionalHistorySection> = {
    EDUCATION: ProfessionalHistorySection.EDUCATION,
    RESIDENCY: ProfessionalHistorySection.RESIDENCY,
    FELLOWSHIP: ProfessionalHistorySection.FELLOWSHIP,
    BOARD_CERTIFICATION: ProfessionalHistorySection.BOARD_CERTIFICATION,
    BOARD: ProfessionalHistorySection.BOARD_CERTIFICATION,
    PROFESSIONAL_CERTIFICATION: ProfessionalHistorySection.PROFESSIONAL_CERTIFICATION,
    PROFESSIONAL: ProfessionalHistorySection.PROFESSIONAL_CERTIFICATION,
    EMPLOYMENT: ProfessionalHistorySection.EMPLOYMENT,
    HOSPITAL_AFFILIATION: ProfessionalHistorySection.HOSPITAL_AFFILIATION,
    HOSPITAL: ProfessionalHistorySection.HOSPITAL_AFFILIATION,
    MALPRACTICE: ProfessionalHistorySection.MALPRACTICE
  };
  const section = map[s];
  if (!section) {
    const err: any = new Error(`Unknown professional history section: ${raw}`);
    err.status = 400;
    throw err;
  }
  return section;
}

function audienceFor(req: AuthRequest): HistoryAudience {
  if (req.user?.role === Role.EXTERNAL_PROVIDER) return 'provider';
  if (req.user?.role === Role.CLIENT_USER) return 'client';
  return 'gpa';
}

function assertCanWrite(req: AuthRequest) {
  const role = req.user!.role;
  if (role === Role.EXTERNAL_PROVIDER) return;
  if (role === Role.CLIENT_USER) {
    if (!canWriteHistoryAsClient(req.tenantContext?.tenantRole)) {
      const err: any = new Error('Insufficient permissions');
      err.status = 403;
      throw err;
    }
    return;
  }
  if (!canWriteHistoryAsStaff(role)) {
    const err: any = new Error('Insufficient permissions');
    err.status = 403;
    throw err;
  }
}

async function resolveTenantProvider(req: AuthRequest) {
  const providerId = req.params.providerId;
  // External providers are intake-scoped — no TenantMembership required.
  // Tenant is derived from their converted intake ownership.
  if (req.user!.role === Role.EXTERNAL_PROVIDER) {
    const intake = await assertProviderOwnsConvertedProvider(req.user!.id, providerId, null);
    return { tenantId: intake.tenantId, providerId };
  }
  requireTenantContext(req.tenantContext);
  return { tenantId: req.tenantContext!.tenantId!, providerId };
}

router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { tenantId, providerId } = await resolveTenantProvider(req);
    res.json(await getHistorySummary(tenantId as string, providerId));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/:section', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const audience = audienceFor(req);
    res.json(await listHistorySection(tenantId as string, providerId, section, audience));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:section', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const audience = audienceFor(req);
    const actorId = req.user!.id;
    const tid = tenantId as string;
    // External providers always create PENDING_REVIEW; they cannot self-verify
    const creators: Record<ProfessionalHistorySection, Function> = {
      EDUCATION: createEducation,
      RESIDENCY: createResidency,
      FELLOWSHIP: createFellowship,
      BOARD_CERTIFICATION: createBoardCertification,
      PROFESSIONAL_CERTIFICATION: createProfessionalCertification,
      EMPLOYMENT: createEmployment,
      HOSPITAL_AFFILIATION: createHospitalAffiliation,
      MALPRACTICE: createMalpractice
    };
    const row = await creators[section](tid, providerId, req.body || {}, actorId);
    await audit(req, 'CREATE', `professionalHistory.${section}`, row.id, undefined, {
      providerId,
      verificationStatus: row.verificationStatus
    });
    res.status(201).json(sanitizeHistoryRecord(section, row, audience));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.patch('/:section/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const audience = audienceFor(req);
    const row = await updateHistoryRecord(
      section,
      tenantId as string,
      providerId,
      req.params.id,
      req.body || {},
      req.user!.id,
      audience
    );
    await audit(req, 'UPDATE', `professionalHistory.${section}`, req.params.id, undefined, {
      providerId,
      verificationStatus: row.verificationStatus
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:section/:id/archive', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    if (req.user!.role === Role.EXTERNAL_PROVIDER) {
      return res.status(403).json({ error: 'Providers cannot archive history records' });
    }
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const row = await archiveHistoryRecord(section, tenantId as string, providerId, req.params.id, req.user!.id);
    await audit(req, 'ARCHIVE', `professionalHistory.${section}`, req.params.id, undefined, { providerId });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:section/:id/verify', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canVerifyHistory(req.user!.role)) {
      return res.status(403).json({ error: 'Only authorized reviewers can verify professional history' });
    }
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const body = z.object({ reviewerNotes: z.string().optional().nullable() }).parse(req.body || {});
    const row = await verifyHistoryRecord(section, tenantId as string, providerId, req.params.id, req.user!.id, body);
    await audit(req, 'VERIFY', `professionalHistory.${section}`, req.params.id, undefined, {
      providerId,
      verificationStatus: row.verificationStatus
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:section/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canReviewHistory(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const body = z.object({
      reason: z.string().min(2),
      reviewerNotes: z.string().optional().nullable()
    }).parse(req.body || {});
    const row = await rejectHistoryRecord(
      section,
      tenantId as string,
      providerId,
      req.params.id,
      req.user!.id,
      body.reason,
      { reviewerNotes: body.reviewerNotes }
    );
    await audit(req, 'REJECT', `professionalHistory.${section}`, req.params.id, undefined, {
      providerId,
      reason: body.reason
    });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:section/:id/documents', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertCanWrite(req);
    const { tenantId, providerId } = await resolveTenantProvider(req);
    const section = parseSection(req.params.section);
    const body = z.object({ documentId: z.string().min(1) }).parse(req.body || {});
    const row = await linkHistoryDocument(
      section,
      tenantId as string,
      providerId,
      req.params.id,
      body.documentId,
      req.user!.id
    );
    await audit(req, 'LINK_DOCUMENT', `professionalHistory.${section}`, req.params.id, undefined, {
      documentId: body.documentId
    });
    res.json(sanitizeHistoryRecord(section, row, audienceFor(req)));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
export { SECTIONS };
