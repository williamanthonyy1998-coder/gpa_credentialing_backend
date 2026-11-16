/**
 * Durable private object storage abstraction (SEC-16).
 * Production prefers S3-compatible private buckets; local disk only for non-production
 * unless OBJECT_STORAGE_DRIVER=local is explicitly allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

export type ObjectStorageDriver = 'local' | 's3';

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

function localRoot(): string {
  return path.resolve(process.cwd(), process.env.LOCAL_UPLOAD_DIR || 'private-uploads');
}

export function resolveObjectStorageDriver(env: NodeJS.ProcessEnv = process.env): ObjectStorageDriver {
  const explicit = String(env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
  if (explicit === 's3' || explicit === 'local') return explicit as ObjectStorageDriver;
  if (env.NODE_ENV === 'production') return 's3';
  return 'local';
}

export function isObjectStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local') {
    if (env.NODE_ENV === 'production' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') return false;
    return true;
  }
  return Boolean(
    env.S3_BUCKET
    && (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE)
    && (env.AWS_REGION || env.S3_REGION)
  );
}

export function assertObjectStorageReady(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.OBJECT_STORAGE_REQUIRED === '0') return;
  const driver = resolveObjectStorageDriver(env);
  if (driver === 'local' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') {
    throw new Error(
      '[security] Refusing to start: production requires durable object storage '
      + '(set OBJECT_STORAGE_DRIVER=s3 with S3_BUCKET/AWS_REGION, or explicitly ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=1).'
    );
  }
  if (driver === 's3' && !isObjectStorageConfigured(env)) {
    throw new Error(
      '[security] Refusing to start: S3 object storage is selected but S3_BUCKET / AWS_REGION (and credentials) are incomplete.'
    );
  }
}

/** Safe object key — never trust client paths. */
export function generateObjectKey(originalName?: string | null): string {
  const ext = path.extname(String(originalName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeExt = ext && ext.length <= 10 ? ext : '';
  return `${crypto.randomUUID()}${safeExt}`;
}

export function resolveLocalPath(key: string): string | null {
  const base = path.basename(String(key || ''));
  if (!base || base !== key.replace(/\\/g, '/').split('/').pop()) return null;
  const full = path.join(localRoot(), base);
  if (!full.startsWith(localRoot())) return null;
  return full;
}

async function putLocal(input: PutObjectInput): Promise<StoredObject> {
  const root = localRoot();
  fs.mkdirSync(root, { recursive: true });
  const full = resolveLocalPath(input.key);
  if (!full) throw new Error('Invalid storage key');
  if (Buffer.isBuffer(input.body)) {
    fs.writeFileSync(full, input.body);
    return { key: path.basename(full), driver: 'local', sizeBytes: input.body.length };
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(full);
    (input.body as NodeJS.ReadableStream).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
  const stat = fs.statSync(full);
  return { key: path.basename(full), driver: 'local', sizeBytes: stat.size };
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
    ServerSideEncryption: (process.env.S3_SSE || 'AES256') as 'AES256' | 'aws:kms',
    // private by default — never set public-read
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

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function putObject(input: PutObjectInput): Promise<StoredObject> {
  const driver = resolveObjectStorageDriver();
  if (driver === 's3') return putS3(input);
  return putLocal(input);
}

export async function getObjectStream(key: string): Promise<{ stream: Readable; contentType?: string; driver: ObjectStorageDriver } | null> {
  const driver = resolveObjectStorageDriver();
  if (driver === 's3') {
    const got = await getS3Stream(key);
    return got ? { ...got, driver } : null;
  }
  const got = await getLocalStream(key);
  return got ? { ...got, driver } : null;
}

export async function deleteObject(key: string): Promise<void> {
  const driver = resolveObjectStorageDriver();
  if (driver === 's3') return deleteS3(key);
  return deleteLocal(key);
}

/** Short-lived signed GET URL — only for S3; local returns null (use authenticated proxy). */
export async function createSignedGetUrl(key: string, expiresSeconds = 60): Promise<string | null> {
  if (resolveObjectStorageDriver() !== 's3') return null;
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const region = process.env.S3_REGION || process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({ region });
  const ttl = Math.min(Math.max(Number(expiresSeconds) || 60, 15), 300);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}
