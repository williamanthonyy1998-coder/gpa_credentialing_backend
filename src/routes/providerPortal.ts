import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { audit } from '../lib/audit';
import { prisma } from '../lib/prisma';
import {
  assertProviderOwnsIntake,
  createIntakeDocumentMeta,
  getProviderDashboard,
  listProviderIntakes,
  sanitizeIntakeForProvider,
  saveProviderDraft,
  submitProviderIntake
} from '../services/providerIntake';
import {
  GENERAL_ALLOWED_MIME,
  validateUploadedFile
} from '../services/fileMagic';

const router = Router();
const uploadDir = path.resolve(process.cwd(), 'private-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, GENERAL_ALLOWED_MIME.has(file.mimetype))
});

function safeUnlink(p?: string | null) {
  if (!p) return;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

function resolveStoredPath(storageKey: string) {
  const safeName = path.basename(storageKey);
  const fullPath = path.resolve(uploadDir, safeName);
  if (!fullPath.startsWith(uploadDir + path.sep)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

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
      if (req.file) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Documents cannot be uploaded for this intake status' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG) under 20 MB.' });
    if (!intake.tenantId) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Intake is missing tenant ownership' });
    }

    const title = String(req.body.title || req.file.originalname || 'Intake document').slice(0, 200);
    const type = String(req.body.type || 'OTHER').slice(0, 80);
    const category = String(req.body.category || 'intake').slice(0, 80);

    const validation = validateUploadedFile({
      filePath: req.file.path,
      originalName: req.file.originalname,
      declaredMime: req.file.mimetype,
      allowedMimes: GENERAL_ALLOWED_MIME
    });
    if (!validation.ok) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: validation.error });
    }

    // Path traversal: reject dangerous original names
    if (req.file.originalname.includes('..') || req.file.originalname.includes('/') || req.file.originalname.includes('\\')) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Invalid file name' });
    }

    const doc = await createIntakeDocumentMeta({
      tenantId: intake.tenantId,
      intakeRequestId: intake.id,
      createdById: req.user!.id,
      title,
      type,
      category
    });

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        storageKey: req.file.filename,
        originalName: path.basename(req.file.originalname),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        uploadedAt: new Date(),
        // Remain quarantined until malware scan policy or manual release
        securityStatus: 'QUARANTINED'
      }
    });

    await prisma.intakeEvent.create({
      data: {
        intakeId: intake.id,
        action: 'DOCUMENT_UPLOADED',
        actorId: req.user!.id,
        detail: { documentId: updated.id, title, securityStatus: 'QUARANTINED' }
      }
    });
    await audit(req, 'UPLOAD', 'documents', updated.id, undefined, {
      intakeRequestId: intake.id,
      title,
      securityStatus: 'QUARANTINED'
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
    if (req.file) safeUnlink(req.file.path);
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
    const fullPath = resolveStoredPath(doc.storageKey);
    if (!fullPath) return res.status(404).json({ error: 'File not found' });
    await audit(req, 'DOWNLOAD', 'documents', doc.id, undefined, {
      intakeRequestId: doc.intakeRequestId,
      securityStatus: doc.securityStatus
    });
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.originalName || 'document')}"`);
    fs.createReadStream(fullPath).pipe(res);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
