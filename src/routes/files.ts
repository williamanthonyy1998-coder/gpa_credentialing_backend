import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import {
  computeCredentialAttention,
  isAgreementsCategory,
  isBankingCredentialType,
  isInsuranceLiabilityType,
  isIrsCategory,
  isOtherDocumentsCategory
} from '../services/credentials';
import { extractInsuranceFromFile } from '../services/insuranceExtract';
import { extractBankingFromFile } from '../services/bankingExtract';
import {
  AGREEMENTS_ALLOWED_MIME,
  BANKING_ALLOWED_MIME,
  GENERAL_ALLOWED_MIME,
  INSURANCE_ALLOWED_MIME,
  IRS_ALLOWED_MIME,
  OTHER_DOCUMENTS_ALLOWED_MIME,
  validateUploadedFile
} from '../services/fileMagic';
import { assertOrganizationAccess, resolveRecordOrganizationId } from '../services/orgAccess';

const router = Router();
const uploadDir = path.resolve(process.cwd(), 'private-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, GENERAL_ALLOWED_MIME.has(file.mimetype));
  }
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

async function assertDocAccess(req: AuthRequest, documentId: string) {
  const orgId = await resolveRecordOrganizationId('documents', documentId);
  await assertOrganizationAccess(req.user!.id, req.user!.role, orgId);
}

router.post('/:id/file', upload.single('file'), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG) under 20 MB.' });
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) {
      safeUnlink(req.file.path);
      return res.status(404).json({ error: 'Document record not found' });
    }
    if (['AUDITOR', 'READ_ONLY'].includes(req.user!.role)) {
      safeUnlink(req.file.path);
      return res.status(403).json({ error: 'Your role cannot upload files' });
    }
    await assertDocAccess(req, document.id);

    const insurance = isInsuranceLiabilityType(document.type);
    const banking = isBankingCredentialType(document.type) || document.category === 'banking';
    const otherDocs = isOtherDocumentsCategory(document.category);
    const agreements = isAgreementsCategory(document.category);
    const irs = isIrsCategory(document.category);
    const allowed = otherDocs
      ? OTHER_DOCUMENTS_ALLOWED_MIME
      : agreements
        ? AGREEMENTS_ALLOWED_MIME
        : irs
          ? IRS_ALLOWED_MIME
          : insurance || banking
            ? (banking ? BANKING_ALLOWED_MIME : INSURANCE_ALLOWED_MIME)
            : GENERAL_ALLOWED_MIME;
    const validation = validateUploadedFile({
      filePath: req.file.path,
      originalName: req.file.originalname,
      declaredMime: req.file.mimetype,
      allowedMimes: allowed
    });
    if (!validation.ok) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: validation.error });
    }

    const replace = String(req.query.replace || req.body?.replace || '').toLowerCase() === 'true';
    if (document.storageKey && !replace) {
      safeUnlink(req.file.path);
      return res.status(409).json({
        error: 'A document is already attached. Confirm replace to overwrite the existing file.',
        code: 'REPLACE_REQUIRED'
      });
    }

    const previousKey = document.storageKey;
    const updated = await prisma.document.update({
      where: { id: document.id },
      data: {
        storageKey: req.file.filename,
        originalName: path.basename(req.file.originalname),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        status: 'RECEIVED',
        uploadedAt: new Date()
      }
    });

    if (previousKey && previousKey !== updated.storageKey) {
      const oldPath = resolveStoredPath(previousKey);
      if (oldPath) safeUnlink(oldPath);
    }

    await audit(
      req,
      previousKey ? 'REPLACE_FILE' : 'UPLOAD_FILE',
      'documents',
      updated.id,
      { hadFile: Boolean(previousKey), originalName: document.originalName, sizeBytes: document.sizeBytes },
      { originalName: updated.originalName, sizeBytes: updated.sizeBytes, mimeType: updated.mimeType }
    );

    res.json({
      id: updated.id,
      originalName: updated.originalName,
      sizeBytes: updated.sizeBytes,
      mimeType: updated.mimeType,
      status: updated.status,
      attention: computeCredentialAttention(updated)
    });
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) safeUnlink(req.file.path);
    next(e);
  }
});

router.get('/:id/file', async (req: AuthRequest, res, next) => {
  try {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document?.storageKey) return res.status(404).json({ error: 'No file is attached to this document record' });
    await assertDocAccess(req, document.id);
    const fullPath = resolveStoredPath(document.storageKey);
    if (!fullPath) return res.status(404).json({ error: 'Stored file was not found' });

    const inline = String(req.query.inline || '').toLowerCase() === '1' || String(req.query.disposition || '') === 'inline';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (document.mimeType) res.type(document.mimeType);

    await audit(req, 'DOWNLOAD', 'documents', document.id, undefined, {
      originalName: document.originalName,
      title: document.title,
      inline
    });

    if (inline) {
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(document.originalName || document.title)}"`);
      return fs.createReadStream(fullPath).pipe(res);
    }
    res.download(fullPath, path.basename(document.originalName || document.title));
  } catch (e) { next(e); }
});

router.delete('/:id/file', async (req: AuthRequest, res, next) => {
  try {
    if (['AUDITOR', 'READ_ONLY'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot remove files' });
    }
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) return res.status(404).json({ error: 'Document record not found' });
    await assertDocAccess(req, document.id);
    if (!document.storageKey) return res.status(404).json({ error: 'No file is attached' });

    const fullPath = resolveStoredPath(document.storageKey);
    const updated = await prisma.document.update({
      where: { id: document.id },
      data: {
        storageKey: null,
        originalName: null,
        mimeType: null,
        sizeBytes: null,
        uploadedAt: null,
        status: document.required ? 'MISSING' : 'MISSING'
      }
    });
    if (fullPath) safeUnlink(fullPath);
    await audit(req, 'REMOVE_FILE', 'documents', updated.id, {
      originalName: document.originalName,
      sizeBytes: document.sizeBytes
    }, { storageKey: null });
    res.json({ id: updated.id, storageKey: null, attention: computeCredentialAttention(updated) });
  } catch (e) { next(e); }
});

router.post('/:id/extract', async (req: AuthRequest, res, next) => {
  try {
    if (['AUDITOR', 'READ_ONLY'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot run extraction' });
    }
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) return res.status(404).json({ error: 'Document record not found' });
    await assertDocAccess(req, document.id);
    if (!document.storageKey) {
      return res.status(400).json({ error: 'Upload a document before running extraction', ok: false });
    }
    const insurance = isInsuranceLiabilityType(document.type) || document.category === 'insurance';
    const banking = isBankingCredentialType(document.type) || document.category === 'banking';
    if (!insurance && !banking) {
      return res.status(400).json({ error: 'Extraction is only available for insurance or banking credentials', ok: false });
    }
    const fullPath = resolveStoredPath(document.storageKey);
    if (!fullPath) return res.status(404).json({ error: 'Stored file was not found', ok: false });

    const result = banking
      ? await extractBankingFromFile(fullPath, document.mimeType, document.type)
      : await extractInsuranceFromFile(fullPath, document.mimeType);
    await audit(req, 'EXTRACT_DOCUMENT', 'documents', document.id, undefined, {
      ok: result.ok,
      method: result.method,
      category: banking ? 'banking' : 'insurance',
      // Do not log extracted sensitive values — only presence flags
      fieldsPresent: Object.fromEntries(
        Object.entries(result.fields).map(([k, v]) => [k, v.value !== null])
      )
    });
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
