import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function allowPlaintextTestFixtures(): boolean {
  return process.env.NODE_ENV !== 'production'
    && process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST === '1';
}

function resolveKey(): Buffer | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY || '';
  if (raw.trim()) {
    // Accept 32-byte key as base64 or hex, or derive from arbitrary secret string
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
    try {
      const b64 = Buffer.from(trimmed, 'base64');
      if (b64.length === 32) return b64;
    } catch { /* fall through */ }
    return crypto.createHash('sha256').update(trimmed).digest();
  }
  // H6: never silently derive a production-like key from JWT_SECRET
  return null;
}

export function isEncryptedValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt plaintext for at-rest storage. Returns null when input is empty. */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = resolveKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FIELD_ENCRYPTION_KEY is required to store sensitive banking fields in production');
    }
    if (allowPlaintextTestFixtures()) {
      // Explicit test-only escape hatch — never silent
      return plaintext;
    }
    throw new Error(
      'FIELD_ENCRYPTION_KEY is required to encrypt sensitive fields. '
      + 'For isolated test fixtures only, set FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST=1 (non-production).'
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypt an at-rest value. Plaintext (legacy/unencrypted) is returned as-is. */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isEncryptedValue(stored)) return stored;
  const key = resolveKey();
  if (!key) return null;
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

export function maskLast4(value: string | null | undefined, placeholder = '••••'): string | null {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return placeholder;
  const last = digits.slice(-4);
  return `${placeholder}${last}`;
}
