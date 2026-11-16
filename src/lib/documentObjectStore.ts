/**
 * Shared document upload/download helpers for authenticated routes.
 * Multer memory → validate → optional malware scan temp file → durable object storage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer, { type FileFilterCallback } from 'multer';
import type { Request, Response } from 'express';
import {
  deleteObject,
  generateDocumentObjectKey,
  getObject,
  getObjectStream,
  isLegacyLocalStorageKey,
  putObject,
  resolveObjectStorageDriver
} from './objectStorage';
import { validateUploadedBytes } from '../services/fileMagic';
import type { ScanResult } from '../services/documentSecurity';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function createMemoryUpload(allowedMimes: Set<string>) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
      cb(null, allowedMimes.has(file.mimetype));
    }
  });
}

export function safeUnlink(p?: string | null) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

export async function writeTempUploadFile(file: Express.Multer.File): Promise<string> {
  if (!file?.buffer?.length) throw new Error('Empty upload buffer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-doc-'));
  const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
  const dest = path.join(dir, `payload${ext || '.bin'}`);
  fs.writeFileSync(dest, file.buffer);
  return dest;
}

export function cleanupTempUploadFile(tempPath?: string | null) {
  if (!tempPath) return;
  safeUnlink(tempPath);
  try {
    const dir = path.dirname(tempPath);
    if (dir.includes(`${path.sep}cred-doc-`) || dir.includes('/cred-doc-')) {
      fs.rmdirSync(dir);
    }
  } catch { /* ignore */ }
}

export type PersistUploadResult = {
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  scan: ScanResult;
};

/**
 * Validate buffer, write temp for malware scan, upload to configured durable store, then clean temp.
 * Does not mutate Prisma — caller updates Document.storageKey.
 */
export async function persistUploadedDocumentFile(input: {
  tenantId: string;
  documentId: string;
  file: Express.Multer.File;
  allowedMimes: Set<string>;
  scanDocument: (args: { documentId: string; filePath: string }) => Promise<ScanResult>;
}): Promise<PersistUploadResult> {
  const originalName = path.basename(String(input.file.originalname || 'document'));
  if (originalName.includes('..') || /[/\\]/.test(String(input.file.originalname || ''))) {
    throw Object.assign(new Error('Invalid file name'), { status: 400 });
  }
  const validation = validateUploadedBytes({
    buffer: input.file.buffer,
    originalName,
    declaredMime: input.file.mimetype,
    allowedMimes: input.allowedMimes
  });
  if (!validation.ok) {
    throw Object.assign(new Error(validation.error), { status: 400 });
  }

  const tempPath = await writeTempUploadFile(input.file);
  try {
    const scan = await input.scanDocument({ documentId: input.documentId, filePath: tempPath });
    const storageKey = generateDocumentObjectKey({
      tenantId: input.tenantId,
      documentId: input.documentId,
      originalName
    });
    await putObject({
      key: storageKey,
      body: input.file.buffer,
      contentType: validation.mimeType,
      contentLength: input.file.size
    });
    return {
      storageKey,
      originalName,
      mimeType: validation.mimeType,
      sizeBytes: input.file.size,
      scan
    };
  } finally {
    cleanupTempUploadFile(tempPath);
  }
}

export async function materializeStorageKeyToTemp(storageKey: string): Promise<string | null> {
  const got = await getObject(storageKey);
  if (!got) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-read-'));
  const dest = path.join(dir, `object${path.extname(storageKey).slice(0, 12) || '.bin'}`);
  fs.writeFileSync(dest, got.buffer);
  return dest;
}

export async function pipeDocumentFileToResponse(
  res: Response,
  storageKey: string,
  opts: {
    mimeType?: string | null;
    downloadName: string;
    inline?: boolean;
  }
): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'LEGACY_UNAVAILABLE'; error: string }> {
  const got = await getObjectStream(storageKey);
  if (!got) {
    if (isLegacyLocalStorageKey(storageKey)) {
      return {
        ok: false,
        code: 'LEGACY_UNAVAILABLE',
        error: 'Legacy local file is no longer available on this host. Re-upload the document to durable storage.'
      };
    }
    return { ok: false, code: 'NOT_FOUND', error: 'Stored file was not found' };
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (opts.mimeType || got.contentType) res.type(opts.mimeType || got.contentType || 'application/octet-stream');
  const safeName = path.basename(opts.downloadName || 'document');
  if (opts.inline) {
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }
  got.stream.pipe(res);
  return { ok: true };
}

export async function deleteDocumentStorageObject(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey) return;
  try {
    await deleteObject(storageKey);
  } catch {
    // Object may already be gone; DB clear still proceeds.
  }
}

export function activeStorageDriverLabel(): string {
  return resolveObjectStorageDriver();
}
