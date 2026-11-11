import path from 'node:path';
import fs from 'node:fs';

export const INSURANCE_ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/** Banking credentials (Bank Letter / Voided Check) — PDF and images only. */
export const BANKING_ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/** Other Documents category — secure PDF / JPG / JPEG / PNG only. */
export const OTHER_DOCUMENTS_ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/** Agreements & Contracts — secure PDF / JPG / JPEG / PNG only. */
export const AGREEMENTS_ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/** IRS Documents (W-9 Form, EIN Letter) — secure PDF / JPG / JPEG / PNG only. */
export const IRS_ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const GENERAL_ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const SECURE_IMAGE_PDF_ONLY = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const EXT_BY_MIME: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
};

export function extensionAllowedForMime(originalName: string, mimeType: string): boolean {
  const ext = path.extname(originalName || '').toLowerCase();
  const allowed = EXT_BY_MIME[mimeType] || [];
  return allowed.includes(ext);
}

export function sniffMimeFromBuffer(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // ZIP-based office docs
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'application/zip';
  return null;
}

export function validateUploadedFile(opts: {
  filePath: string;
  originalName: string;
  declaredMime: string;
  allowedMimes: Set<string>;
}): { ok: true; mimeType: string } | { ok: false; error: string } {
  const { filePath, originalName, declaredMime, allowedMimes } = opts;
  if (!allowedMimes.has(declaredMime)) {
    const imagePdfOnly = [...allowedMimes].every((m) => SECURE_IMAGE_PDF_ONLY.has(m));
    return {
      ok: false,
      error: imagePdfOnly
        ? 'Unsupported file type. Allowed: PDF, JPG, JPEG, PNG (max 20 MB).'
        : 'Unsupported file type. Allowed: PDF, JPG, JPEG, PNG (and DOC/DOCX/XLSX for general credentials).'
    };
  }
  if (!extensionAllowedForMime(originalName, declaredMime)) {
    return { ok: false, error: 'File extension does not match the declared MIME type.' };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    const sniffed = sniffMimeFromBuffer(header);
    if (declaredMime === 'application/pdf' && sniffed !== 'application/pdf') {
      return { ok: false, error: 'File content is not a valid PDF.' };
    }
    if (declaredMime === 'image/jpeg' && sniffed !== 'image/jpeg') {
      return { ok: false, error: 'File content is not a valid JPEG image.' };
    }
    if (declaredMime === 'image/png' && sniffed !== 'image/png') {
      return { ok: false, error: 'File content is not a valid PNG image.' };
    }
    // Reject obvious executables by extension/name even if somehow declared as allowed
    if (/\.(exe|bat|cmd|ps1|sh|js|msi|dll|com|scr)$/i.test(originalName)) {
      return { ok: false, error: 'Executable files are not allowed.' };
    }
    return { ok: true, mimeType: declaredMime };
  } finally {
    fs.closeSync(fd);
  }
}
