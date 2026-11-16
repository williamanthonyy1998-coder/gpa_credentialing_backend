/**
 * Startup and runtime security guards (C2 / C3 / SEC-12 / H6 / CORS / DB).
 * Fail closed in production — never silently disable safeguards.
 */

export type RuntimeEnv = Record<string, string | undefined>;

const DEV_WEB_ORIGINS = 'http://localhost:5173,http://localhost:5174';

/**
 * Vercel sets `VERCEL=1` even if someone mistakenly copied NODE_ENV=development
 * into project env vars. Use for cookies, error sanitization, and E2E bypass — not for
 * storage/scanner hard-fail (those stay on NODE_ENV===production so ops can remediate).
 */
export function isProductionRuntime(env: RuntimeEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.VERCEL === '1' || Boolean(env.VERCEL);
}

/**
 * Express `trust proxy` for reverse proxies (Vercel).
 * Never return bare `true` — express-rate-limit rejects that as ERR_ERL_PERMISSIVE_TRUST_PROXY.
 * Prefer a hop count so client-supplied X-Forwarded-For cannot trivially spoof rate-limit keys.
 */
export function resolveTrustProxySetting(env: RuntimeEnv = process.env): false | number | string {
  const raw = String(env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return 1;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops > 0 ? hops : false;
  }
  if (raw) return raw; // subnet / IP list (advanced)
  if (env.VERCEL || env.SERVERLESS === '1') return 1;
  return false;
}

/** E2E login rate-limit bypass is allowed only outside production against an isolated e2e/test DB. */
export function isE2eLoginBypassAllowed(env: RuntimeEnv = process.env): boolean {
  if (isProductionRuntime(env)) return false;
  if (env.E2E_SAFE_DATABASE !== '1') return false;
  const dbUrl = String(env.DATABASE_URL || '');
  return databaseUrlLooksIsolated(dbUrl);
}

export function hasIntegrationMockFlags(env: RuntimeEnv = process.env): boolean {
  return env.INTEGRATION_TEST_MOCK === '1' || env.CAQH_ALLOW_MOCK_CONNECT === '1';
}

/** Database name only — never log the full URL (may contain credentials). */
export function databaseNameFromUrl(dbUrl: string | undefined | null): string | null {
  const raw = String(dbUrl || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:');
    const u = new URL(normalized);
    const name = (u.pathname || '').split('/').filter(Boolean)[0] || '';
    return name.replace(/\/$/, '') || null;
  } catch {
    const pathPart = raw.replace(/^[^/]+:\/\//, '').split('/').slice(1).join('/');
    const name = (pathPart.split('?')[0] || '').replace(/\/$/, '');
    return name || null;
  }
}

export function databaseUrlLooksIsolated(dbUrl: string | undefined | null): boolean {
  const name = databaseNameFromUrl(dbUrl);
  if (!name) return false;
  return /(_e2e|_test)$/i.test(name) || /^credentialing_e2e$/i.test(name);
}

export function databaseUrlLooksProductionLike(dbUrl: string | undefined | null): boolean {
  const name = databaseNameFromUrl(dbUrl);
  if (!name) return false;
  if (/production/i.test(name)) return true;
  if (/^credentialing_db$/i.test(name)) return true;
  return false;
}

/**
 * Validate FIELD_ENCRYPTION_KEY strength without returning key material.
 * Accepts 64-hex (32 bytes), base64 of 32 bytes, or a strong secret string (≥32 chars).
 */
export function isFieldEncryptionKeyValid(raw: string | undefined | null): boolean {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return false;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return true;
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return true;
  } catch { /* fall through */ }
  return trimmed.length >= 32;
}

/** Strip trailing slashes so `https://app.example.com/` matches browser Origin. */
export function normalizeOrigin(origin: string): string {
  return String(origin || '').trim().replace(/\/+$/, '');
}

export function parseWebOrigins(env: RuntimeEnv = process.env): string[] {
  const raw = String(env.WEB_ORIGIN || '').trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') return [];
    return DEV_WEB_ORIGINS.split(',').map((x) => normalizeOrigin(x)).filter(Boolean);
  }
  return raw.split(',').map((x) => normalizeOrigin(x)).filter(Boolean);
}

function assertValidOriginList(origins: string[], env: RuntimeEnv): void {
  if (!origins.length) {
    throw new Error('[security] Refusing to start: WEB_ORIGIN is required when NODE_ENV=production');
  }
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('[security] Refusing to start: wildcard WEB_ORIGIN is forbidden');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('[security] Refusing to start: WEB_ORIGIN contains an invalid origin');
    }
    if (env.NODE_ENV === 'production') {
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        throw new Error(
          '[security] Refusing to start: localhost WEB_ORIGIN is forbidden when NODE_ENV=production'
        );
      }
    }
  }
}

/**
 * Refuse unsafe production configuration before the HTTP server listens.
 * Throws Error with a clear message — callers should not catch and continue.
 */
export function assertSafeRuntimeConfig(env: RuntimeEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.E2E_SAFE_DATABASE === '1') {
    throw new Error(
      '[security] Refusing to start: E2E_SAFE_DATABASE=1 is forbidden when NODE_ENV=production'
    );
  }
  if (env.NODE_ENV === 'production' && hasIntegrationMockFlags(env)) {
    throw new Error(
      '[security] Refusing to start: INTEGRATION_TEST_MOCK / CAQH_ALLOW_MOCK_CONNECT are forbidden in production'
    );
  }
  if (env.NODE_ENV === 'production' && env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST === '1') {
    throw new Error(
      '[security] Refusing to start: FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST=1 is forbidden when NODE_ENV=production'
    );
  }
  if (env.NODE_ENV === 'production') {
    if (!isFieldEncryptionKeyValid(env.FIELD_ENCRYPTION_KEY)) {
      throw new Error(
        '[security] Refusing to start: FIELD_ENCRYPTION_KEY is missing or too weak for production '
        + '(require 32-byte hex/base64 or a secret ≥32 characters). Never derive from JWT_SECRET.'
      );
    }
    const origins = parseWebOrigins(env);
    assertValidOriginList(origins, env);

    const dbUrl = env.DATABASE_URL;
    if (!dbUrl || !String(dbUrl).trim()) {
      throw new Error('[security] Refusing to start: DATABASE_URL is required in production');
    }
    if (databaseUrlLooksIsolated(dbUrl)) {
      throw new Error(
        '[security] Refusing to start: DATABASE_URL must not target an *_e2e / *_test database in production'
      );
    }
  }

  // Non-production: refuse pairing E2E_SAFE_DATABASE with a production-like DB name.
  if (env.NODE_ENV !== 'production' && env.E2E_SAFE_DATABASE === '1') {
    if (databaseUrlLooksProductionLike(env.DATABASE_URL)) {
      throw new Error(
        '[security] Refusing to start: E2E_SAFE_DATABASE=1 cannot use a production-like database name'
      );
    }
  }

  // SEC-16 / storage: deferred to assertSafeRuntimeConfigExtended to avoid circular imports in unit tests.
  // Callers that boot the server invoke assertProductionSecurityIntegrations().
}

/** Production storage + malware scanner gates (optional deps). */
export function assertProductionSecurityIntegrations(env: RuntimeEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  // Keep in sync with objectStorage.resolveObjectStorageDriver (production default: supabase).
  const raw = String(env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
  const driver = raw === 's3' || raw === 'local' || raw === 'supabase'
    ? raw
    : 'supabase';

  if (driver === 'local' && env.ALLOW_LOCAL_UPLOADS_IN_PRODUCTION !== '1') {
    throw new Error(
      '[security] Refusing to start: production requires durable object storage '
      + '(OBJECT_STORAGE_DRIVER=supabase with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET, '
      + 'or OBJECT_STORAGE_DRIVER=s3 with S3_BUCKET/AWS_REGION, or ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=1).'
    );
  }

  if (driver === 'supabase') {
    const missing: string[] = [];
    if (!String(env.SUPABASE_URL || '').trim()) missing.push('SUPABASE_URL');
    if (!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!String(env.SUPABASE_STORAGE_BUCKET || '').trim()) missing.push('SUPABASE_STORAGE_BUCKET');
    if (missing.length) {
      throw new Error(
        '[security] Refusing to start: Supabase object storage selected but configuration is incomplete '
        + `(missing ${missing.join(', ')}).`
      );
    }
    try {
      const parsed = new URL(String(env.SUPABASE_URL).trim());
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error(
        '[security] Refusing to start: SUPABASE_URL is not a valid http(s) URL.'
      );
    }
    const bucket = String(env.SUPABASE_STORAGE_BUCKET).trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/i.test(bucket)) {
      throw new Error(
        '[security] Refusing to start: SUPABASE_STORAGE_BUCKET name is invalid.'
      );
    }
  }

  if (driver === 's3') {
    const hasBucket = Boolean(env.S3_BUCKET && (env.AWS_REGION || env.S3_REGION));
    if (!hasBucket) {
      throw new Error(
        '[security] Refusing to start: S3 object storage selected but S3_BUCKET / AWS_REGION are incomplete.'
      );
    }
  }

  // Explicit waiver: MALWARE_SCAN_REQUIRED=0 allows boot without a scanner.
  // This disables malware scanning only — it does not weaken auth, ACL, MIME/magic validation, or storage privacy.
  if (env.MALWARE_SCAN_REQUIRED === '0') {
    // Documented risk acceptance: no scanner URL/host required.
  } else {
    const scannerOk = Boolean(env.MALWARE_SCANNER_URL || env.CLAMAV_HOST || env.MALWARE_SCANNER_ENABLED === '1');
    if (!scannerOk) {
      throw new Error(
        '[security] Refusing to start: configure MALWARE_SCANNER_URL or CLAMAV_HOST, '
        + 'or set MALWARE_SCAN_REQUIRED=0 with documented risk acceptance '
        + '(files will not be malware-scanned; see docs/MALWARE_SCANNING.md).'
      );
    }
  }
}

export function resolveCorsOrigins(env: RuntimeEnv = process.env): string[] {
  const origins = parseWebOrigins(env);
  if (env.NODE_ENV === 'production') {
    assertValidOriginList(origins, env);
  }
  return origins.length
    ? origins
    : DEV_WEB_ORIGINS.split(',').map((x) => normalizeOrigin(x)).filter(Boolean);
}

/** True when browser Origin is explicitly allowed (never reflects arbitrary Origin). */
export function isCorsOriginAllowed(requestOrigin: string | undefined, env: RuntimeEnv = process.env): boolean {
  if (!requestOrigin) return false;
  const normalized = normalizeOrigin(requestOrigin);
  return resolveCorsOrigins(env).some((allowed) => normalizeOrigin(allowed) === normalized);
}
