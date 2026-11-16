import { Router } from 'express';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import {
  cleanupTempUploadFile,
  createMemoryUpload,
  deleteDocumentStorageObject,
  materializeStorageKeyToTemp,
  persistUploadedDocumentFile,
  pipeDocumentFileToResponse
} from '../lib/documentObjectStore';
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
  OTHER_DOCUMENTS_ALLOWED_MIME
} from '../services/fileMagic';
import { requireTenantContext } from '../services/tenantAccess';
import { assertResourceRecordAccess } from '../services/orgAccess';

const router = Router();
const upload = createMemoryUpload(GENERAL_ALLOWED_MIME);

async function assertDocAccess(req: AuthRequest, documentId: string) {
  requireTenantContext(req.tenantContext);
  await assertResourceRecordAccess(
    req.user!.id,
    req.user!.role,
    'documents',
    documentId,
    req.tenantContext
  );
}

function resolveUploadTenantId(document: { tenantId: string | null }, req: AuthRequest): string | null {
  return document.tenantId || req.tenantContext?.tenantId || null;
}

router.post('/:id/file', upload.single('file'), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG) under 20 MB.' });
    }
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) {
      return res.status(404).json({ error: 'Document record not found' });
    }
    if (['AUDITOR', 'READ_ONLY'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot upload files' });
    }
    await assertDocAccess(req, document.id);

    const tenantId = resolveUploadTenantId(document, req);
    if (!tenantId) {
      return res.status(400).json({ error: 'Document is missing tenant ownership for durable storage' });
    }

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

    const replace = String(req.query.replace || req.body?.replace || '').toLowerCase() === 'true';
    if (document.storageKey && !replace) {
      return res.status(409).json({
        error: 'A document is already attached. Confirm replace to overwrite the existing file.',
        code: 'REPLACE_REQUIRED'
      });
    }

    const previousKey = document.storageKey;
    // Phase 2C: archive prior file metadata; keep physical object for audit (do not delete).
    if (previousKey && replace) {
      const { archiveCurrentFileRevision } = await import('../services/documentSecurity');
      await archiveCurrentFileRevision({
        documentId: document.id,
        storageKey: document.storageKey,
        originalName: document.originalName,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        securityStatus: (document as any).securityStatus || 'AVAILABLE',
        createdById: req.user!.id,
        reason: 'REPLACE'
      });
    }

    const { scanOrQuarantine } = await import('../services/documentSecurity');
    let persisted;
    try {
      persisted = await persistUploadedDocumentFile({
        tenantId,
        documentId: document.id,
        file: req.file,
        allowedMimes: allowed,
        scanDocument: scanOrQuarantine
      });
    } catch (e: any) {
      if (e?.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

    const updated = await prisma.document.update({
      where: { id: document.id },
      data: {
        storageKey: persisted.storageKey,
        originalName: persisted.originalName,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.sizeBytes,
        status: 'RECEIVED',
        uploadedAt: new Date(),
        securityStatus: persisted.scan.status
      }
    });

    await audit(
      req,
      previousKey ? 'REPLACE_FILE' : 'UPLOAD_FILE',
      'documents',
      updated.id,
      { hadFile: Boolean(previousKey), originalName: document.originalName, sizeBytes: document.sizeBytes, priorKeyKept: Boolean(previousKey) },
      {
        originalName: updated.originalName,
        sizeBytes: updated.sizeBytes,
        mimeType: updated.mimeType,
        securityStatus: updated.securityStatus,
        scanReason: !persisted.scan.scanned ? persisted.scan.reason : undefined
      }
    );

    res.json({
      id: updated.id,
      originalName: updated.originalName,
      sizeBytes: updated.sizeBytes,
      mimeType: updated.mimeType,
      status: updated.status,
      securityStatus: updated.securityStatus,
      attention: computeCredentialAttention(updated)
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/file', async (req: AuthRequest, res, next) => {
  try {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document?.storageKey) return res.status(404).json({ error: 'No file is attached to this document record' });
    await assertDocAccess(req, document.id);
    if ((document as any).securityStatus === 'DELETED' || (document as any).securityStatus === 'REJECTED') {
      return res.status(404).json({ error: 'Document not found' });
    }
    const { canNormalDownload } = await import('../services/documentSecurity');
    const security = (document as any).securityStatus || 'QUARANTINED';
    // H4: quarantined files cannot be downloaded on the normal path (no role bypass / warning header)
    if (!canNormalDownload(security)) {
      return res.status(403).json({
        error: 'Document is not available for download. Quarantined files require an authorized investigative download with a recorded reason.',
        code: 'DOCUMENT_NOT_AVAILABLE',
        securityStatus: security
      });
    }

    const inline = String(req.query.inline || '').toLowerCase() === '1' || String(req.query.disposition || '') === 'inline';
    await audit(req, 'DOWNLOAD', 'documents', document.id, undefined, {
      originalName: document.originalName,
      title: document.title,
      inline
    });

    const piped = await pipeDocumentFileToResponse(res, document.storageKey, {
      mimeType: document.mimeType,
      downloadName: path.basename(document.originalName || document.title),
      inline
    });
    if (!piped.ok) {
      return res.status(404).json({ error: piped.error, code: piped.code });
    }
  } catch (e) { next(e); }
});

/** H4: Exceptional investigative download — narrow role + reason + audit. */
router.post('/:id/investigative-download', async (req: AuthRequest, res, next) => {
  try {
    const { canInvestigativeDownload } = await import('../services/documentSecurity');
    if (!canInvestigativeDownload(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for investigative download' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 12) {
      return res.status(400).json({
        error: 'Investigative download requires a reason (minimum 12 characters)',
        code: 'INVESTIGATIVE_REASON_REQUIRED'
      });
    }
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document?.storageKey) return res.status(404).json({ error: 'No file is attached to this document record' });
    await assertDocAccess(req, document.id);
    if ((document as any).securityStatus === 'DELETED') {
      return res.status(404).json({ error: 'Document not found' });
    }
    if ((document as any).securityStatus === 'REJECTED') {
      return res.status(403).json({ error: 'Rejected documents cannot be downloaded', code: 'REJECTED_NOT_DOWNLOADABLE' });
    }
    const security = (document as any).securityStatus || 'QUARANTINED';
    if (security === 'AVAILABLE') {
      return res.status(400).json({
        error: 'Document is AVAILABLE — use the normal download endpoint',
        code: 'USE_NORMAL_DOWNLOAD'
      });
    }

    await audit(req, 'INVESTIGATIVE_DOWNLOAD', 'documents', document.id, undefined, {
      originalName: document.originalName,
      title: document.title,
      securityStatus: security,
      reason,
      malwareScanned: false
    });

    res.setHeader('X-Document-Security-Warning', 'INVESTIGATIVE_QUARANTINE_ACCESS');
    const piped = await pipeDocumentFileToResponse(res, document.storageKey, {
      mimeType: document.mimeType,
      downloadName: path.basename(document.originalName || document.title),
      inline: false
    });
    if (!piped.ok) {
      return res.status(404).json({ error: piped.error, code: piped.code });
    }
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

    const priorKey = document.storageKey;
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
    await deleteDocumentStorageObject(priorKey);
    await audit(req, 'REMOVE_FILE', 'documents', updated.id, {
      originalName: document.originalName,
      sizeBytes: document.sizeBytes
    }, { storageKey: null });
    res.json({ id: updated.id, storageKey: null, attention: computeCredentialAttention(updated) });
  } catch (e) { next(e); }
});

router.post('/:id/extract', async (req: AuthRequest, res, next) => {
  let tempPath: string | null = null;
  try {
    if (['AUDITOR', 'READ_ONLY', 'CLIENT_USER', 'EXTERNAL_PROVIDER'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot run extraction' });
    }
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) return res.status(404).json({ error: 'Document record not found' });
    await assertDocAccess(req, document.id);
    if (!document.storageKey) {
      return res.status(400).json({ error: 'Upload a document before running extraction', ok: false });
    }
    // RT-05: never read quarantined / non-AVAILABLE bytes on the ordinary extract path.
    const { canNormalDownload } = await import('../services/documentSecurity');
    const security = (document as any).securityStatus || 'QUARANTINED';
    if (!canNormalDownload(security)) {
      return res.status(403).json({
        error: 'Document is not available for extraction. Quarantined files require authorized release before processing.',
        code: 'DOCUMENT_NOT_AVAILABLE',
        securityStatus: security,
        ok: false
      });
    }
    const insurance = isInsuranceLiabilityType(document.type) || document.category === 'insurance';
    const banking = isBankingCredentialType(document.type) || document.category === 'banking';
    if (!insurance && !banking) {
      return res.status(400).json({ error: 'Extraction is only available for insurance or banking credentials', ok: false });
    }
    tempPath = await materializeStorageKeyToTemp(document.storageKey);
    if (!tempPath) {
      return res.status(404).json({
        error: 'Stored file was not found',
        ok: false,
        code: 'NOT_FOUND'
      });
    }

    const result = banking
      ? await extractBankingFromFile(tempPath, document.mimeType, document.type)
      : await extractInsuranceFromFile(tempPath, document.mimeType);
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
  finally {
    cleanupTempUploadFile(tempPath);
  }
});

export default router;
