/**
 * Durable private object storage abstraction (SEC-16).
 *
 * Drivers:
 * - local  — development / explicit ALLOW_LOCAL_UPLOADS_IN_PRODUCTION only
 * - supabase — production default (private Supabase Storage bucket)
 * - s3 — optional AWS S3 / S3-compatible (kept for multi-provider; not required when supabase is selected)
 *
 * Live routes must call these APIs (or documentObjectStore helpers). Never trust client-supplied keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ObjectStorageDriver = 'local' | 's3' | 'supabase';

export type PutObjectInput = {
  key: string;
  body: Buffer | NodeJS.ReadableStream;
  contentType?: string | null;
  contentLength?: number | null;
};

export type StoredObject = {
  key: string;
  driver: ObjectStorageDriver;
  sizeBytes?: number;
};

export type ObjectStreamResult = {
  stream: Readable;
  contentType?: string;
  driver: ObjectStorageDriver | 'legacy-local';
};

let supabaseAdminClient: SupabaseClient | null = null;
let supabaseAdminClientKey = '';

function localRoot(): string {
  return path.resolve(process.cwd(), process.env.LOCAL_UPLOAD_DIR || 'private-uploads');
}

export function resetObjectStorageClientCache(): void {
  supabaseAdminClient = null;
  supabaseAdminClientKey = '';
}

/** Test-only: inject a fake Supabase admin client (never use in production code paths). */
export function __setSupabaseAdminClientForTests(client: SupabaseClient | null): void {
  supabaseAdminClient = client;
  supabaseAdminClientKey = client ? '__test__' : '';
}

export function resolveObjectStorageDriver(env: NodeJS.ProcessEnv = process.env): ObjectStorageDriver {
  const explicit = String(env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
  if (explicit === 's3' || explicit === 'local' || explicit === 'supabase') {
    return explicit as ObjectStorageDriver;
  }
  if (env.NODE_ENV === 'production') return 'supabase';
  return 'local';
}

/** Flat basename keys are treated as pre-Supabase local-disk legacy references. */
export function isLegacyLocalStorageKey(key: string): boolean {
  const normalized = String(key || '').replace(/\\/g, '/').trim();
  if (!normalized) return false;
  if (normalized.includes('..')) return false;
  return !normalized.includes('/');
}

export function isSupabaseStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = String(env.SUPABASE_URL || '').trim();
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = String(env.SUPABASE_STORAGE_BUCKET || '').trim();
  if (!url || !key || !bucket) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (!parsed.hostname) return false;
  } catch {
    return false;
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/i.test(bucket)) return false;
  return true;
}

export function isS3StorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.S3_BUCKET
    && (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE)
    && (env.AWS_REGION || env.S3_REGION)
  );
}

export function isObjectStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local') {
    if (env.NODE_ENV === 'production' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') return false;
    return true;
  }
  if (driver === 'supabase') return isSupabaseStorageConfigured(env);
  return isS3StorageConfigured(env);
}

export function describeMissingObjectStorageConfig(env: NodeJS.ProcessEnv = process.env): string {
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local') {
    if (env.NODE_ENV === 'production' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') {
      return 'OBJECT_STORAGE_DRIVER=local requires ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=1 in production (not recommended on Vercel).';
    }
    return '';
  }
  if (driver === 'supabase') {
    const missing: string[] = [];
    if (!String(env.SUPABASE_URL || '').trim()) missing.push('SUPABASE_URL');
    if (!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!String(env.SUPABASE_STORAGE_BUCKET || '').trim()) missing.push('SUPABASE_STORAGE_BUCKET');
    if (missing.length) return `missing ${missing.join(', ')}`;
    if (!isSupabaseStorageConfigured(env)) {
      return 'SUPABASE_URL / SUPABASE_STORAGE_BUCKET are invalid (check URL and bucket name format)';
    }
    return '';
  }
  const missing: string[] = [];
  if (!env.S3_BUCKET) missing.push('S3_BUCKET');
  if (!(env.AWS_REGION || env.S3_REGION)) missing.push('AWS_REGION (or S3_REGION)');
  if (!(env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE)) {
    missing.push('AWS credentials (AWS_ACCESS_KEY_ID or instance role)');
  }
  return missing.length ? `missing ${missing.join(', ')}` : '';
}

export function assertObjectStorageReady(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.OBJECT_STORAGE_REQUIRED === '0') return;
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') {
    throw new Error(
      '[security] Refusing to start: production requires durable object storage '
      + '(set OBJECT_STORAGE_DRIVER=supabase with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET, '
      + 'or OBJECT_STORAGE_DRIVER=s3 with S3_BUCKET/AWS_REGION, or explicitly ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=1).'
    );
  }
  if (!isObjectStorageConfigured(env)) {
    const detail = describeMissingObjectStorageConfig(env) || 'incomplete configuration';
    throw new Error(
      `[security] Refusing to start: ${driver} object storage selected but configuration is incomplete (${detail}).`
    );
  }
}

/** Safe object key segment — never trust client paths. */
export function generateObjectKey(originalName?: string | null): string {
  const ext = path.extname(String(originalName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeExt = ext && ext.length <= 10 ? ext : '';
  return `${crypto.randomUUID()}${safeExt}`;
}

/**
 * Tenant-scoped object key for durable drivers.
 * Local driver keeps flat UUID names for legacy compatibility.
 */
export function generateDocumentObjectKey(input: {
  tenantId: string;
  documentId: string;
  originalName?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  const unique = generateObjectKey(input.originalName);
  const driver = resolveObjectStorageDriver(input.env || process.env);
  if (driver === 'local') return unique;
  const tenantId = String(input.tenantId || '').trim();
  const documentId = String(input.documentId || '').trim();
  if (!tenantId || !documentId) {
    throw new Error('tenantId and documentId are required for durable object keys');
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(tenantId) || !/^[a-zA-Z0-9_-]{8,128}$/.test(documentId)) {
    throw new Error('Invalid tenantId or documentId for object key');
  }
  return `tenants/${tenantId}/documents/${documentId}/${unique}`;
}

export function resolveLocalPath(key: string): string | null {
  const normalized = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) return null;
  const root = localRoot();
  const full = path.resolve(root, normalized);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export function getSupabaseAdminClient(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  // Test injection short-circuit (never set outside unit tests).
  if (supabaseAdminClient && supabaseAdminClientKey === '__test__') return supabaseAdminClient;
  if (!isSupabaseStorageConfigured(env)) {
    throw new Error(
      '[storage] Supabase Storage is not configured (need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET)'
    );
  }
  const url = String(env.SUPABASE_URL).trim();
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
  const cacheKey = `${url}::${key.slice(0, 8)}`;
  if (supabaseAdminClient && supabaseAdminClientKey === cacheKey) return supabaseAdminClient;
  supabaseAdminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  supabaseAdminClientKey = cacheKey;
  return supabaseAdminClient;
}

function supabaseBucket(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.SUPABASE_STORAGE_BUCKET || '').trim();
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function putLocal(input: PutObjectInput): Promise<StoredObject> {
  const full = resolveLocalPath(input.key);
  if (!full) throw new Error('Invalid storage key');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (Buffer.isBuffer(input.body)) {
    fs.writeFileSync(full, input.body);
    return { key: input.key, driver: 'local', sizeBytes: input.body.length };
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(full);
    (input.body as NodeJS.ReadableStream).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
  const stat = fs.statSync(full);
  return { key: input.key, driver: 'local', sizeBytes: stat.size };
}

async function getLocalStream(key: string): Promise<{ stream: Readable; contentType?: string } | null> {
  const full = resolveLocalPath(key);
  if (!full || !fs.existsSync(full)) return null;
  return { stream: fs.createReadStream(full) };
}

async function deleteLocal(key: string): Promise<void> {
  const full = resolveLocalPath(key);
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
}

async function localExists(key: string): Promise<boolean> {
  const full = resolveLocalPath(key);
  return Boolean(full && fs.existsSync(full));
}

async function putSupabase(input: PutObjectInput): Promise<StoredObject> {
  const client = getSupabaseAdminClient();
  const bucket = supabaseBucket();
  const body = Buffer.isBuffer(input.body)
    ? input.body
    : await streamToBuffer(input.body as NodeJS.ReadableStream);
  const { error } = await client.storage.from(bucket).upload(input.key, body, {
    contentType: input.contentType || 'application/octet-stream',
    upsert: false
  });
  if (error) {
    throw new Error(`[storage] Supabase upload failed: ${error.message}`);
  }
  return { key: input.key, driver: 'supabase', sizeBytes: body.length };
}

async function getSupabaseObject(key: string): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const client = getSupabaseAdminClient();
  const bucket = supabaseBucket();
  const { data, error } = await client.storage.from(bucket).download(key);
  if (error || !data) return null;
  const ab = await data.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    contentType: data.type || undefined
  };
}

async function getSupabaseStream(key: string): Promise<{ stream: Readable; contentType?: string } | null> {
  const got = await getSupabaseObject(key);
  if (!got) return null;
  return { stream: Readable.from(got.buffer), contentType: got.contentType };
}

async function deleteSupabase(key: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const bucket = supabaseBucket();
  const { error } = await client.storage.from(bucket).remove([key]);
  if (error) {
    throw new Error(`[storage] Supabase delete failed: ${error.message}`);
  }
}

async function supabaseExists(key: string): Promise<boolean> {
  const client = getSupabaseAdminClient();
  const bucket = supabaseBucket();
  const parts = key.replace(/\\/g, '/').split('/');
  const name = parts.pop();
  if (!name) return false;
  const folder = parts.join('/');
  const { data, error } = await client.storage.from(bucket).list(folder || '', {
    search: name,
    limit: 100
  });
  if (error || !data) return false;
  return data.some((row) => row.name === name);
}

async function putS3(input: PutObjectInput): Promise<StoredObject> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  const body = Buffer.isBuffer(input.body)
    ? input.body
    : await streamToBuffer(input.body as NodeJS.ReadableStream);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    Body: body,
    ContentType: input.contentType || undefined,
    ServerSideEncryption: (process.env.S3_SSE || 'AES256') as 'AES256' | 'aws:kms'
  }));
  return { key: input.key, driver: 's3', sizeBytes: body.length };
}

async function getS3Stream(key: string): Promise<{ stream: Readable; contentType?: string } | null> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) return null;
    return {
      stream: out.Body as Readable,
      contentType: out.ContentType || undefined
    };
  } catch {
    return null;
  }
}

async function deleteS3(key: string): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function s3Exists(key: string): Promise<boolean> {
  const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Primary upload API (alias: uploadObject). */
export async function putObject(input: PutObjectInput): Promise<StoredObject> {
  const driver = resolveObjectStorageDriver();
  if (driver === 'supabase') return putSupabase(input);
  if (driver === 's3') return putS3(input);
  return putLocal(input);
}

export const uploadObject = putObject;

export async function getObject(key: string): Promise<{ buffer: Buffer; contentType?: string; driver: ObjectStorageDriver | 'legacy-local' } | null> {
  if (isLegacyLocalStorageKey(key)) {
    const full = resolveLocalPath(key);
    if (!full || !fs.existsSync(full)) return null;
    return { buffer: fs.readFileSync(full), driver: 'legacy-local' };
  }
  const driver = resolveObjectStorageDriver();
  if (driver === 'supabase') {
    const got = await getSupabaseObject(key);
    return got ? { ...got, driver } : null;
  }
  if (driver === 's3') {
    const got = await getS3Stream(key);
    if (!got) return null;
    const buffer = await streamToBuffer(got.stream);
    return { buffer, contentType: got.contentType, driver };
  }
  const full = resolveLocalPath(key);
  if (!full || !fs.existsSync(full)) return null;
  return { buffer: fs.readFileSync(full), driver: 'local' };
}

export async function getObjectStream(key: string): Promise<ObjectStreamResult | null> {
  if (isLegacyLocalStorageKey(key)) {
    const got = await getLocalStream(key);
    return got ? { ...got, driver: 'legacy-local' } : null;
  }
  const driver = resolveObjectStorageDriver();
  if (driver === 'supabase') {
    const got = await getSupabaseStream(key);
    return got ? { ...got, driver } : null;
  }
  if (driver === 's3') {
    const got = await getS3Stream(key);
    return got ? { ...got, driver } : null;
  }
  const got = await getLocalStream(key);
  return got ? { ...got, driver: 'local' } : null;
}

export async function deleteObject(key: string): Promise<void> {
  if (isLegacyLocalStorageKey(key)) {
    await deleteLocal(key);
    return;
  }
  const driver = resolveObjectStorageDriver();
  if (driver === 'supabase') return deleteSupabase(key);
  if (driver === 's3') return deleteS3(key);
  return deleteLocal(key);
}

export async function objectExists(key: string): Promise<boolean> {
  if (isLegacyLocalStorageKey(key)) return localExists(key);
  const driver = resolveObjectStorageDriver();
  if (driver === 'supabase') return supabaseExists(key);
  if (driver === 's3') return s3Exists(key);
  return localExists(key);
}

/** Short-lived signed GET URL — Supabase/S3 only; local returns null (use authenticated proxy). */
export async function createSignedGetUrl(key: string, expiresSeconds = 60): Promise<string | null> {
  if (isLegacyLocalStorageKey(key)) return null;
  const driver = resolveObjectStorageDriver();
  const ttl = Math.min(Math.max(Number(expiresSeconds) || 60, 15), 300);
  if (driver === 'supabase') {
    const client = getSupabaseAdminClient();
    const bucket = supabaseBucket();
    const { data, error } = await client.storage.from(bucket).createSignedUrl(key, ttl);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }
  if (driver !== 's3') return null;
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}

/**
 * Optional live probe: list the configured private bucket (service role).
 * Sync startup validation covers env; this confirms network/ACL when called.
 */
export async function assertObjectStorageReachable(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  if (env.OBJECT_STORAGE_REQUIRED === '0') return;
  if (env.OBJECT_STORAGE_PROBE_ON_BOOT === '0') return;
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local') return;
  if (driver === 'supabase') {
    const client = getSupabaseAdminClient(env);
    const bucket = supabaseBucket(env);
    const { error } = await client.storage.from(bucket).list('', { limit: 1 });
    if (error) {
      throw new Error(
        `[security] Refusing to start: Supabase Storage bucket is not accessible (${error.message}). `
        + 'Verify SUPABASE_STORAGE_BUCKET exists and the service-role key can access it.'
      );
    }
    return;
  }
  // S3: HeadBucket is sufficient when credentials resolve.
  const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
  const region = env.S3_REGION || env.AWS_REGION;
  const bucket = env.S3_BUCKET!;
  const client = new S3Client({ region });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (e: any) {
    throw new Error(
      `[security] Refusing to start: S3 bucket is not accessible (${e?.message || 'head failed'}).`
    );
  }
}
