import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setSupabaseAdminClientForTests,
  assertObjectStorageReady,
  createSignedGetUrl,
  deleteObject,
  describeMissingObjectStorageConfig,
  generateDocumentObjectKey,
  getObject,
  isLegacyLocalStorageKey,
  isObjectStorageConfigured,
  isSupabaseStorageConfigured,
  objectExists,
  putObject,
  resetObjectStorageClientCache,
  resolveObjectStorageDriver,
  uploadObject
} from './objectStorage';

test('resolveObjectStorageDriver: production defaults to supabase', () => {
  assert.equal(resolveObjectStorageDriver({ NODE_ENV: 'production' }), 'supabase');
  assert.equal(resolveObjectStorageDriver({ NODE_ENV: 'development' }), 'local');
  assert.equal(resolveObjectStorageDriver({ OBJECT_STORAGE_DRIVER: 's3' }), 's3');
  assert.equal(resolveObjectStorageDriver({ OBJECT_STORAGE_DRIVER: 'supabase' }), 'supabase');
});

test('isLegacyLocalStorageKey distinguishes flat vs tenant-scoped keys', () => {
  assert.equal(isLegacyLocalStorageKey('abc-123.pdf'), true);
  assert.equal(isLegacyLocalStorageKey('tenants/t1/documents/d1/file.pdf'), false);
  assert.equal(isLegacyLocalStorageKey('../evil'), false);
});

test('generateDocumentObjectKey is tenant-scoped for supabase', () => {
  const key = generateDocumentObjectKey({
    tenantId: 'tenantid01',
    documentId: 'document01',
    originalName: 'w9.pdf',
    env: { OBJECT_STORAGE_DRIVER: 'supabase' }
  });
  assert.match(key, /^tenants\/tenantid01\/documents\/document01\/[0-9a-f-]+\.pdf$/i);
});

test('generateDocumentObjectKey stays flat for local driver', () => {
  const key = generateDocumentObjectKey({
    tenantId: 'tenantid01',
    documentId: 'document01',
    originalName: 'w9.pdf',
    env: { OBJECT_STORAGE_DRIVER: 'local' }
  });
  assert.equal(key.includes('/'), false);
  assert.match(key, /\.pdf$/i);
});

test('supabase config validation reports missing vars without leaking secrets', () => {
  const detail = describeMissingObjectStorageConfig({
    NODE_ENV: 'production',
    OBJECT_STORAGE_DRIVER: 'supabase'
  });
  assert.match(detail, /SUPABASE_URL/);
  assert.match(detail, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(detail, /SUPABASE_STORAGE_BUCKET/);
  assert.equal(detail.includes('eyJ'), false);
});

test('isSupabaseStorageConfigured requires valid URL + bucket + key', () => {
  assert.equal(isSupabaseStorageConfigured({}), false);
  assert.equal(isSupabaseStorageConfigured({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_STORAGE_BUCKET: 'credentialing-docs'
  }), true);
  assert.equal(isSupabaseStorageConfigured({
    SUPABASE_URL: 'not-a-url',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_STORAGE_BUCKET: 'credentialing-docs'
  }), false);
});

test('assertObjectStorageReady fails closed for incomplete supabase production config', () => {
  assert.throws(
    () => assertObjectStorageReady({
      NODE_ENV: 'production',
      OBJECT_STORAGE_DRIVER: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co'
    }),
    /incomplete|missing/i
  );
  assert.doesNotThrow(() => assertObjectStorageReady({
    NODE_ENV: 'production',
    OBJECT_STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_STORAGE_BUCKET: 'credentialing-docs'
  }));
});

test('local put/get/delete/objectExists round-trip', async () => {
  const prevDriver = process.env.OBJECT_STORAGE_DRIVER;
  const prevDir = process.env.LOCAL_UPLOAD_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-obj-'));
  process.env.OBJECT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_UPLOAD_DIR = dir;
  try {
    const key = 'roundtrip-test.pdf';
    await uploadObject({ key, body: Buffer.from('%PDF-1.4 local'), contentType: 'application/pdf' });
    assert.equal(await objectExists(key), true);
    const got = await getObject(key);
    assert.ok(got);
    assert.equal(got!.buffer.toString('utf8'), '%PDF-1.4 local');
    assert.equal(await createSignedGetUrl(key), null);
    await deleteObject(key);
    assert.equal(await objectExists(key), false);
    assert.equal(isObjectStorageConfigured({ OBJECT_STORAGE_DRIVER: 'local', NODE_ENV: 'development' }), true);
  } finally {
    if (prevDriver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = prevDriver;
    if (prevDir === undefined) delete process.env.LOCAL_UPLOAD_DIR;
    else process.env.LOCAL_UPLOAD_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy flat keys are never treated as supabase object paths', async () => {
  const prevDriver = process.env.OBJECT_STORAGE_DRIVER;
  process.env.OBJECT_STORAGE_DRIVER = 'supabase';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'credentialing-docs';
  try {
    const got = await getObject('legacy-only.pdf');
    assert.equal(got, null);
  } finally {
    if (prevDriver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = prevDriver;
  }
});

test('mocked supabase upload/download/signedUrl/delete/objectExists', async () => {
  const store = new Map<string, Buffer>();
  const fakeClient = {
    storage: {
      from(_bucket: string) {
        return {
          async upload(key: string, body: Buffer) {
            store.set(key, Buffer.from(body));
            return { data: { path: key }, error: null };
          },
          async download(key: string) {
            const buf = store.get(key);
            if (!buf) return { data: null, error: { message: 'not found' } };
            return {
              data: {
                arrayBuffer: async () => Uint8Array.from(buf).buffer,
                type: 'application/pdf'
              },
              error: null
            };
          },
          async remove(keys: string[]) {
            for (const k of keys) store.delete(k);
            return { data: keys, error: null };
          },
          async createSignedUrl(key: string, ttl: number) {
            if (!store.has(key)) return { data: null, error: { message: 'missing' } };
            return { data: { signedUrl: `https://signed.example/${encodeURIComponent(key)}?t=${ttl}` }, error: null };
          },
          async list(folder: string, opts: { search?: string; limit?: number }) {
            const prefix = folder ? `${folder}/` : '';
            const names = [...store.keys()]
              .filter((k) => (folder ? k.startsWith(prefix) : true))
              .map((k) => (folder ? k.slice(prefix.length).split('/')[0] : k.split('/')[0]))
              .filter((n) => Boolean(n) && (!opts.search || n === opts.search))
              .map((name) => ({ name }));
            return { data: names, error: null };
          }
        };
      }
    }
  } as any;

  const prev = {
    driver: process.env.OBJECT_STORAGE_DRIVER,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.SUPABASE_STORAGE_BUCKET
  };
  process.env.OBJECT_STORAGE_DRIVER = 'supabase';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'credentialing-docs';
  __setSupabaseAdminClientForTests(fakeClient);

  try {
    const key = 'tenants/tenantid01/documents/document01/file.pdf';
    await putObject({ key, body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });
    assert.equal(await objectExists(key), true);
    const got = await getObject(key);
    assert.ok(got);
    assert.equal(got!.driver, 'supabase');
    assert.equal(got!.buffer.toString('utf8'), '%PDF-1.4');
    const signed = await createSignedGetUrl(key, 60);
    assert.match(String(signed), /^https:\/\/signed\.example\//);
    await deleteObject(key);
    assert.equal(await objectExists(key), false);
  } finally {
    __setSupabaseAdminClientForTests(null);
    resetObjectStorageClientCache();
    if (prev.driver === undefined) delete process.env.OBJECT_STORAGE_DRIVER;
    else process.env.OBJECT_STORAGE_DRIVER = prev.driver;
    if (prev.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    if (prev.bucket === undefined) delete process.env.SUPABASE_STORAGE_BUCKET;
    else process.env.SUPABASE_STORAGE_BUCKET = prev.bucket;
  }
});
