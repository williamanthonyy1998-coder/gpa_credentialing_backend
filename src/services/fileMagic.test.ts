import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sniffMimeFromBuffer,
  validateUploadedFile,
  AGREEMENTS_ALLOWED_MIME,
  INSURANCE_ALLOWED_MIME
} from './fileMagic';

test('sniffs PDF JPEG PNG magic bytes', () => {
  assert.equal(sniffMimeFromBuffer(Buffer.from('%PDF-1.4')), 'application/pdf');
  assert.equal(sniffMimeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMimeFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
});

test('rejects mismatched extension and executable names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-upload-'));
  const filePath = path.join(dir, 'payload.pdf');
  fs.writeFileSync(filePath, Buffer.from('%PDF-1.4\n'));
  const ok = validateUploadedFile({
    filePath,
    originalName: 'policy.pdf',
    declaredMime: 'application/pdf',
    allowedMimes: INSURANCE_ALLOWED_MIME
  });
  assert.equal(ok.ok, true);

  const badExt = validateUploadedFile({
    filePath,
    originalName: 'policy.exe',
    declaredMime: 'application/pdf',
    allowedMimes: INSURANCE_ALLOWED_MIME
  });
  assert.equal(badExt.ok, false);
});

test('agreements allowlist rejects DOC with clear PDF/image error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-agree-'));
  const filePath = path.join(dir, 'contract.doc');
  fs.writeFileSync(filePath, Buffer.from('PK\u0003\u0004'));
  const bad = validateUploadedFile({
    filePath,
    originalName: 'contract.doc',
    declaredMime: 'application/msword',
    allowedMimes: AGREEMENTS_ALLOWED_MIME
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /PDF, JPG, JPEG, PNG/i);
});
