import crypto from 'node:crypto';

const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';

function allowPlaintextTestFixtures(): boolean {
  return process.env.NODE_ENV !== 'production'
    && process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST === '1';
}

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return b64;
  } catch { /* fall through */ }
  return crypto.createHash('sha256').update(trimmed).digest();
}

function activeKeyId(): string {
  return String(process.env.FIELD_ENCRYPTION_KEY_ID || 'default').trim() || 'default';
}

function resolveActiveKey(): Buffer | null {
  return parseKeyMaterial(process.env.FIELD_ENCRYPTION_KEY || '');
}

/** Previous keys for dual-read: JSON map { "keyId": "<material>" } */
function previousKeyMap(): Record<string, Buffer> {
  const raw = String(process.env.FIELD_ENCRYPTION_PREVIOUS_KEYS || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, Buffer> = {};
    for (const [id, material] of Object.entries(parsed || {})) {
      const buf = parseKeyMaterial(material);
      if (buf) out[id] = buf;
    }
    return out;
  } catch {
    return {};
  }
}

export function isEncryptedValue(value: string | null | undefined): boolean {
  return typeof value === 'string'
    && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2));
}

function encryptWithKey(plaintext: string, key: Buffer, keyId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX_V2}${keyId}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptV1(stored: string, key: Buffer): string | null {
  const parts = stored.slice(PREFIX_V1.length).split(':');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function decryptV2(stored: string): string | null {
  const rest = stored.slice(PREFIX_V2.length);
  const parts = rest.split(':');
  if (parts.length !== 4) return null;
  const [keyId, ivB64, tagB64, dataB64] = parts;
  const active = resolveActiveKey();
  const prev = previousKeyMap();
  const candidates: Buffer[] = [];
  if (active && (keyId === activeKeyId() || !keyId)) candidates.push(active);
  if (prev[keyId]) candidates.push(prev[keyId]);
  // Also try active key even if keyId differs (misconfiguration recovery).
  if (active && !candidates.includes(active)) candidates.push(active);
  for (const key of Object.values(prev)) {
    if (!candidates.includes(key)) candidates.push(key);
  }
  for (const key of candidates) {
    try {
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Encrypt plaintext for at-rest storage (enc:v2 with key id). Returns null when input is empty. */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  // Idempotent: never double-encrypt.
  if (isEncryptedValue(plaintext)) return plaintext;
  const key = resolveActiveKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FIELD_ENCRYPTION_KEY is required to store sensitive fields in production');
    }
    if (allowPlaintextTestFixtures()) {
      return plaintext;
    }
    throw new Error(
      'FIELD_ENCRYPTION_KEY is required to encrypt sensitive fields. '
      + 'For isolated test fixtures only, set FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST=1 (non-production).'
    );
  }
  return encryptWithKey(String(plaintext), key, activeKeyId());
}

/** Decrypt an at-rest value. Supports enc:v2 (key id) and legacy enc:v1. Plaintext returned as-is. */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isEncryptedValue(stored)) return stored;
  if (stored.startsWith(PREFIX_V2)) return decryptV2(stored);
  const key = resolveActiveKey();
  if (!key) {
    // Try previous keys for v1 as well.
    for (const prev of Object.values(previousKeyMap())) {
      const got = decryptV1(stored, prev);
      if (got != null) return got;
    }
    return null;
  }
  const primary = decryptV1(stored, key);
  if (primary != null) return primary;
  for (const prev of Object.values(previousKeyMap())) {
    const got = decryptV1(stored, prev);
    if (got != null) return got;
  }
  return null;
}

export function maskLast4(value: string | null | undefined, placeholder = '••••'): string | null {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return placeholder;
  const last = digits.slice(-4);
  return `${placeholder}${last}`;
}

/** Fields that must be encrypted at rest when written through resources/credentials. */
export const SENSITIVE_ENCRYPT_FIELDS = [
  'ssn',
  'taxId',
  'bankAccountNumber',
  'bankRoutingNumber'
] as const;

export type SensitiveEncryptField = (typeof SENSITIVE_ENCRYPT_FIELDS)[number];

export function encryptSensitiveFieldsInPlace<T extends Record<string, any>>(data: T, fields: readonly string[] = SENSITIVE_ENCRYPT_FIELDS): T {
  const out: Record<string, any> = { ...data };
  for (const field of fields) {
    if (field in out && out[field] != null && out[field] !== '') {
      out[field] = encryptField(String(out[field]));
    }
  }
  return out as T;
}

export function decryptSensitiveFieldForAudience(
  stored: string | null | undefined,
  showFull: boolean
): { value: string | null; masked: string | null } {
  const decrypted = decryptField(stored);
  if (!decrypted) return { value: null, masked: null };
  const masked = maskLast4(decrypted, '••••');
  return { value: showFull ? decrypted : masked, masked };
}
