import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';

const router = Router();
const uploadDir = path.resolve(process.cwd(), 'private-uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const allowed = new Set(['application/pdf','image/jpeg','image/png','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, allowed.has(file.mimetype)) });
router.post('/:id/file', upload.single('file'), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG, DOC, DOCX or XLSX) under 20 MB.' });
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Document record not found' }); }
    if ([ 'AUDITOR', 'READ_ONLY' ].includes(req.user!.role)) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Your role cannot upload files' }); }
    const updated = await prisma.document.update({ where: { id: document.id }, data: { storageKey: req.file.filename, originalName: path.basename(req.file.originalname), mimeType: req.file.mimetype, sizeBytes: req.file.size, status: 'RECEIVED' } });
    await audit(req, 'UPLOAD_FILE', 'documents', updated.id, { storageKey: document.storageKey }, { storageKey: updated.storageKey, originalName: updated.originalName, sizeBytes: updated.sizeBytes });
    res.json({ id: updated.id, originalName: updated.originalName, sizeBytes: updated.sizeBytes, status: updated.status });
  } catch (e) { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); next(e); }
});
router.get('/:id/file', async (req: AuthRequest, res, next) => {
  try {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document?.storageKey) return res.status(404).json({ error: 'No file is attached to this document record' });
    const safeName = path.basename(document.storageKey);
    const fullPath = path.resolve(uploadDir, safeName);
    if (!fullPath.startsWith(uploadDir + path.sep) || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'Stored file was not found' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await audit(req, 'DOWNLOAD', 'documents', document.id, undefined, { originalName: document.originalName, title: document.title });
    res.download(fullPath, path.basename(document.originalName || document.title));
  } catch (e) { next(e); }
});
export default router;
