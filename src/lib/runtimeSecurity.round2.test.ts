import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeRuntimeConfig,
  databaseNameFromUrl,
  databaseUrlLooksIsolated,
  isE2eLoginBypassAllowed,
  isFieldEncryptionKeyValid,
  parseWebOrigins,
  resolveCorsOrigins
} from './runtimeSecurity';

const PROD_OK = {
  NODE_ENV: 'production',
  FIELD_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  WEB_ORIGIN: 'https://app.example.com',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/credentialing_prod'
};

test('H6: production refuses missing encryption key at startup', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ ...PROD_OK, FIELD_ENCRYPTION_KEY: undefined }),
    /FIELD_ENCRYPTION_KEY/
  );
});

test('H6: production refuses plaintext encryption flag at startup', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ ...PROD_OK, FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST: '1' }),
    /FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST/
  );
});

test('CORS: production refuses missing WEB_ORIGIN', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ ...PROD_OK, WEB_ORIGIN: undefined }),
    /WEB_ORIGIN/
  );
});

test('CORS: production refuses localhost WEB_ORIGIN', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ ...PROD_OK, WEB_ORIGIN: 'http://localhost:5173' }),
    /localhost/
  );
});

test('CORS: production refuses wildcard origin', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({ ...PROD_OK, WEB_ORIGIN: '*' }),
    /wildcard/
  );
});

test('CORS: non-production defaults to localhost when WEB_ORIGIN unset', () => {
  const origins = parseWebOrigins({ NODE_ENV: 'development' });
  assert.ok(origins.some((o) => o.includes('localhost')));
  assert.deepEqual(
    resolveCorsOrigins({ NODE_ENV: 'development' }).slice(0, 1)[0].includes('localhost'),
    true
  );
});

test('DB: production refuses e2e database name', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({
      ...PROD_OK,
      DATABASE_URL: 'postgresql://u:p@localhost:5432/credentialing_e2e'
    }),
    /e2e|_test/
  );
});

test('DB: E2E_SAFE_DATABASE cannot pair with credentialing_db', () => {
  assert.throws(
    () => assertSafeRuntimeConfig({
      NODE_ENV: 'development',
      E2E_SAFE_DATABASE: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/credentialing_db'
    }),
    /production-like/
  );
});

test('helpers: isolated db name detection does not leak credentials', () => {
  assert.equal(databaseNameFromUrl('postgresql://user:secret@localhost:5432/credentialing_e2e'), 'credentialing_e2e');
  assert.equal(databaseUrlLooksIsolated('postgresql://user:secret@localhost:5432/credentialing_e2e'), true);
  assert.equal(isFieldEncryptionKeyValid('short'), false);
  assert.equal(isFieldEncryptionKeyValid(PROD_OK.FIELD_ENCRYPTION_KEY), true);
  assert.equal(
    isE2eLoginBypassAllowed({
      NODE_ENV: 'production',
      E2E_SAFE_DATABASE: '1',
      DATABASE_URL: PROD_OK.DATABASE_URL.replace('credentialing_prod', 'credentialing_e2e')
    }),
    false
  );
});

test('production happy path with required vars', () => {
  assert.doesNotThrow(() => assertSafeRuntimeConfig(PROD_OK));
});
