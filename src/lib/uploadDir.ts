/**
 * Resolve a writable upload directory.
 * On Vercel the deployment FS is read-only except /tmp — never write to project-root private-uploads there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveUploadDir(): string {
  const explicit = String(process.env.LOCAL_UPLOAD_DIR || '').trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  }
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'credentialing-uploads');
  }
  return path.resolve(process.cwd(), 'private-uploads');
}

export function ensureUploadDir(): string {
  const dir = resolveUploadDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
