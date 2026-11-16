import { Router, Response, NextFunction } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { audit } from '../lib/audit';
import { prisma } from '../lib/prisma';
import {
  createMemoryUpload,
  persistUploadedDocumentFile,
  pipeDocumentFileToResponse
} from '../lib/documentObjectStore';
import {
  assertProviderOwnsIntake,
  createIntakeDocumentMeta,
  getProviderDashboard,
  listProviderIntakes,
  sanitizeIntakeForProvider,
  saveProviderDraft,
  submitProviderIntake
} from '../services/providerIntake';
import { GENERAL_ALLOWED_MIME } from '../services/fileMagic';

const router = Router();
const upload = createMemoryUpload(GENERAL_ALLOWED_MIME);

const providerOnly = allowRoles(Role.EXTERNAL_PROVIDER, Role.CLIENT_USER, Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.CREDENTIALING_SPECIALIST);

router.get('/dashboard', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role === Role.EXTERNAL_PROVIDER || req.user!.role === Role.CLIENT_USER) {
      res.json(await getProviderDashboard(req.user!.id));
      return;
    }
    // Staff peek: empty provider dashboard
    res.json({ counts: { total: 0, draft: 0, submitted: 0, changesRequested: 0, approved: 0, rejected: 0 }, intakes: [] });
  } catch (e) { next(e); }
});

router.get('/intakes', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await listProviderIntakes(req.user!.id));
  } catch (e) { next(e); }
});

router.get('/intakes/:id', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await assertProviderOwnsIntake(req.user!.id, req.params.id);
    res.json(sanitizeIntakeForProvider(row));
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.patch('/intakes/:id/draft', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ payload: z.any() }).parse(req.body);
    const row = await saveProviderDraft(req.user!.id, req.params.id, body.payload);
    await audit(req, 'PROVIDER_DRAFT_SAVE', 'intake', req.params.id, undefined, { lastSavedAt: row.lastSavedAt });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, missing: e.missing });
    next(e);
  }
});

router.post('/intakes/:id/submit', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await submitProviderIntake(req.user!.id, req.params.id);
    await audit(req, 'PROVIDER_SUBMIT', 'intake', req.params.id, undefined, { status: row.status });
    res.json(row);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, missing: e.missing });
    next(e);
  }
});

router.post('/intakes/:id/documents', providerOnly, upload.single('file'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const intake = await assertProviderOwnsIntake(req.user!.id, req.params.id);
    if (!['INVITED', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'DRAFT'].includes(intake.status)) {
      return res.status(400).json({ error: 'Documents cannot be uploaded for this intake status' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG) under 20 MB.' });
    }
    if (!intake.tenantId) {
      return res.status(400).json({ error: 'Intake is missing tenant ownership' });
    }

    const title = String(req.body.title || req.file.originalname || 'Intake document').slice(0, 200);
    const type = String(req.body.type || 'OTHER').slice(0, 80);
    const category = String(req.body.category || 'intake').slice(0, 80);

    const doc = await createIntakeDocumentMeta({
      tenantId: intake.tenantId,
      intakeRequestId: intake.id,
      createdById: req.user!.id,
      title,
      type,
      category
    });

    const { scanOrQuarantine } = await import('../services/documentSecurity');
    let persisted;
    try {
      persisted = await persistUploadedDocumentFile({
        tenantId: intake.tenantId,
        documentId: doc.id,
        file: req.file,
        allowedMimes: GENERAL_ALLOWED_MIME,
        scanDocument: scanOrQuarantine
      });
    } catch (e: any) {
      await prisma.document.delete({ where: { id: doc.id } }).catch(() => undefined);
      if (e?.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        storageKey: persisted.storageKey,
        originalName: persisted.originalName,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.sizeBytes,
        uploadedAt: new Date(),
        securityStatus: persisted.scan.status
      }
    });

    await prisma.intakeEvent.create({
      data: {
        intakeId: intake.id,
        action: 'DOCUMENT_UPLOADED',
        actorId: req.user!.id,
        detail: { documentId: updated.id, title, securityStatus: updated.securityStatus }
      }
    });
    await audit(req, 'UPLOAD', 'documents', updated.id, undefined, {
      intakeRequestId: intake.id,
      title,
      securityStatus: updated.securityStatus
    });

    res.status(201).json({
      id: updated.id,
      title: updated.title,
      type: updated.type,
      category: updated.category,
      securityStatus: updated.securityStatus,
      originalName: updated.originalName,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
      uploadedAt: updated.uploadedAt
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/documents/:id/file', providerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc || !doc.intakeRequestId || !doc.storageKey) return res.status(404).json({ error: 'Document not found' });
    await assertProviderOwnsIntake(req.user!.id, doc.intakeRequestId);
    if (doc.securityStatus === 'DELETED' || doc.securityStatus === 'REJECTED') {
      return res.status(404).json({ error: 'Document not found' });
    }
    // Phase 2C: providers cannot download quarantined/unscanned files (malware amplification risk).
    const { canProviderDownload } = await import('../services/documentSecurity');
    if (!canProviderDownload(doc.securityStatus)) {
      return res.status(403).json({
        error: 'This file is quarantined pending security review and cannot be downloaded until released.',
        securityStatus: doc.securityStatus
      });
    }
    await audit(req, 'DOWNLOAD', 'documents', doc.id, undefined, {
      intakeRequestId: doc.intakeRequestId,
      securityStatus: doc.securityStatus
    });
    const piped = await pipeDocumentFileToResponse(res, doc.storageKey, {
      mimeType: doc.mimeType,
      downloadName: path.basename(doc.originalName || 'document'),
      inline: false
    });
    if (!piped.ok) {
      return res.status(404).json({ error: piped.error, code: piped.code });
    }
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
