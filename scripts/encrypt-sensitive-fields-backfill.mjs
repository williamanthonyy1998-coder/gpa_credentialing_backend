/**
 * Safe sensitive-field encryption backfill (enc:v2).
 *
 * Usage:
 *   DATABASE_URL=... FIELD_ENCRYPTION_KEY=... node scripts/encrypt-sensitive-fields-backfill.mjs --dry-run
 *   DATABASE_URL=... FIELD_ENCRYPTION_KEY=... node scripts/encrypt-sensitive-fields-backfill.mjs --apply
 *
 * - Counts-only progress (never prints field values)
 * - Idempotent (skips enc:v1 / enc:v2)
 * - Refuses credentialing_db / production-like names without dual authorization
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

function dbNameFromUrl(url) {
  try {
    const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
    return (u.pathname || '').split('/').filter(Boolean)[0] || 'unknown';
  } catch {
    return 'unparsed';
  }
}

const dbName = dbNameFromUrl(process.env.DATABASE_URL);
const looksProtected =
  /^credentialing_db$/i.test(dbName)
  || /production/i.test(dbName);
if (looksProtected) {
  const ok =
    process.env.ALLOW_SENSITIVE_BACKFILL === '1'
    && process.env.CONFIRM_BACKFILL_DATABASE === dbName;
  if (!ok) {
    console.error('[backfill] Refusing protected DB without ALLOW_SENSITIVE_BACKFILL=1 and CONFIRM_BACKFILL_DATABASE=<name>');
    process.exit(1);
  }
}
if (!process.env.FIELD_ENCRYPTION_KEY || String(process.env.FIELD_ENCRYPTION_KEY).length < 32) {
  console.error('[backfill] FIELD_ENCRYPTION_KEY required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply || process.argv.includes('--dry-run');
const batchSize = Number(process.env.BACKFILL_BATCH_SIZE || 100);

function parseKey(raw) {
  const trimmed = String(raw || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return b64;
  } catch { /* ignore */ }
  return crypto.createHash('sha256').update(trimmed).digest();
}

const key = parseKey(process.env.FIELD_ENCRYPTION_KEY);
const keyId = String(process.env.FIELD_ENCRYPTION_KEY_ID || 'default');

function isEncrypted(v) {
  return typeof v === 'string' && (v.startsWith('enc:v1:') || v.startsWith('enc:v2:'));
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v2:${keyId}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

const TARGETS = [
  { model: 'document', fields: ['bankRoutingNumber'] },
  { model: 'provider', fields: ['ssn'] },
  { model: 'practiceOwner', fields: ['ssn'] },
  { model: 'organization', fields: ['taxId', 'bankAccountNumber', 'bankRoutingNumber'] },
  { model: 'practice', fields: ['taxId', 'bankAccountNumber', 'bankRoutingNumber'] },
  { model: 'billingEntity', fields: ['taxId'] }
];

const prisma = new PrismaClient();
const summary = {};

try {
  for (const target of TARGETS) {
    const delegate = prisma[target.model];
    if (!delegate) {
      summary[target.model] = { skipped: true, reason: 'model_missing' };
      continue;
    }
    let scanned = 0;
    let wouldEncrypt = 0;
    let encrypted = 0;
    let cursor = undefined;
    for (;;) {
      const rows = await delegate.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: Object.fromEntries([['id', true], ...target.fields.map((f) => [f, true])])
      });
      if (!rows.length) break;
      for (const row of rows) {
        scanned += 1;
        const data = {};
        for (const field of target.fields) {
          const val = row[field];
          if (val == null || val === '' || isEncrypted(val)) continue;
          wouldEncrypt += 1;
          data[field] = encrypt(val);
        }
        if (Object.keys(data).length && !dryRun) {
          await delegate.update({ where: { id: row.id }, data });
          encrypted += Object.keys(data).length;
        }
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }
    summary[target.model] = {
      scanned,
      plaintextFieldsFound: wouldEncrypt,
      encryptedFieldsWritten: dryRun ? 0 : encrypted,
      mode: dryRun ? 'dry-run' : 'apply'
    };
  }
  console.log(JSON.stringify({
    databaseName: dbName,
    mode: dryRun ? 'dry-run' : 'apply',
    summary,
    note: 'No sensitive values were printed.'
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
