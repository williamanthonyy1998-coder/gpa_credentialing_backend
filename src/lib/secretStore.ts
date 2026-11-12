/**
 * Phase 4D — secret reference store (security-hardened H5).
 * Stores only opaque references in the DB. Never returns secrets through API layers.
 *
 * Production preference: AWS Secrets Manager when configured.
 * Local/test: tenant-scoped in-memory map (never process-global process.env for tenant secrets).
 * At-rest encryption via FIELD_ENCRYPTION_KEY for local encrypted refs (encref:...).
 *
 * This module does NOT invent credentials. Missing configuration → null / PENDING_CREDENTIALS.
 */

import { encryptField, decryptField } from './fieldCrypto';

export type SecretBackend = 'env' | 'aws' | 'encref' | 'mem' | 'unavailable';

/** Tenant-scoped local/test secrets — never written to process.env. */
const tenantSecretMap = new Map<string, string>();

function memKey(tenantId: string, secretId: string): string {
  return `${tenantId}::${secretId}`;
}

/** Test helper — clear in-memory secrets between suites. */
export function clearTenantSecretMapForTests(): void {
  tenantSecretMap.clear();
}

export function parseSecretRef(ref: string | null | undefined): { backend: SecretBackend; key: string } | null {
  if (!ref || !String(ref).trim()) return null;
  const s = String(ref).trim();
  if (s.startsWith('env:')) return { backend: 'env', key: s.slice(4) };
  if (s.startsWith('aws:')) return { backend: 'aws', key: s.slice(4) };
  if (s.startsWith('encref:')) return { backend: 'encref', key: s.slice(7) };
  if (s.startsWith('mem:')) return { backend: 'mem', key: s.slice(4) };
  return { backend: 'unavailable', key: s };
}

export function awsSecretsManagerConfigured(): boolean {
  return Boolean(
    process.env.AWS_SECRETS_MANAGER_ENABLED === '1'
    && (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION)
  );
}

/** Build a DB-safe secret reference. Never store raw secret in Prisma text columns. */
export function buildEnvSecretRef(envVarName: string): string {
  const name = String(envVarName || '').trim();
  if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(name)) {
    throw Object.assign(new Error('Invalid secret environment variable name'), { status: 400 });
  }
  return `env:${name}`;
}

export function buildEncryptedLocalRef(ciphertextMarker: string): string {
  return `encref:${ciphertextMarker}`;
}

export function buildMemSecretRef(tenantId: string, secretId: string): string {
  const tid = String(tenantId || '').trim();
  const sid = String(secretId || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'secret';
  if (!tid) throw Object.assign(new Error('tenantId required for mem secret ref'), { status: 400 });
  return `mem:${tid}::${sid}`;
}

/**
 * Resolve a secret value from a reference. Returns null when unavailable.
 * Callers must never log the return value.
 * For mem: refs, expectedTenantId must match or resolution returns null (cross-tenant deny).
 */
export async function resolveSecret(
  ref: string | null | undefined,
  options?: { expectedTenantId?: string | null }
): Promise<string | null> {
  const parsed = parseSecretRef(ref);
  if (!parsed) return null;

  if (parsed.backend === 'env') {
    // Platform/shared env vars only — not for tenant-specific credential injection.
    const v = process.env[parsed.key];
    return v && String(v).trim() ? String(v) : null;
  }

  if (parsed.backend === 'mem') {
    const [tenantId, secretId] = parsed.key.split('::');
    if (!tenantId || !secretId) return null;
    if (options?.expectedTenantId && options.expectedTenantId !== tenantId) return null;
    const v = tenantSecretMap.get(memKey(tenantId, secretId));
    return v && String(v).trim() ? String(v) : null;
  }

  if (parsed.backend === 'encref') {
    // Ciphertext stored in tenant-scoped memory map under INTEGRATION_SECRET_* style id
    const enc = tenantSecretMap.get(`encref::${parsed.key}`) || null;
    if (!enc) return null;
    return decryptField(enc.startsWith('enc:v1:') ? enc : null);
  }

  if (parsed.backend === 'aws') {
    if (!awsSecretsManagerConfigured()) return null;
    try {
      const importAws = new Function('return import("@aws-sdk/client-secrets-manager")') as () => Promise<any>;
      const mod = await importAws().catch(() => null);
      if (!mod?.SecretsManagerClient || !mod?.GetSecretValueCommand) return null;
      const client = new mod.SecretsManagerClient({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
      });
      const out = await client.send(new mod.GetSecretValueCommand({ SecretId: parsed.key }));
      return out.SecretString || null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Configure a tenant-scoped local/test secret into the in-memory map.
 * Does NOT write to process.env (H5).
 */
export function configureTenantMemSecret(
  tenantId: string,
  secretId: string,
  plaintext: string | null | undefined
): { secretRef: string; configured: boolean } {
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('Local in-memory secrets are not permitted in production — use AWS Secrets Manager'),
      { status: 409, code: 'LOCAL_SECRET_FORBIDDEN_IN_PRODUCTION' }
    );
  }
  const secretRef = buildMemSecretRef(tenantId, secretId);
  const key = memKey(tenantId, String(secretId).replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'secret');
  if (plaintext == null || plaintext === '') {
    tenantSecretMap.delete(key);
    return { secretRef, configured: false };
  }
  tenantSecretMap.set(key, String(plaintext));
  return { secretRef, configured: true };
}

/**
 * @deprecated Prefer configureTenantMemSecret. Kept for callers that only need a ref to an existing platform env var
 * without writing tenant plaintext into process.env.
 */
export function configureEnvSecret(envVarName: string, plaintext: string | null | undefined): {
  secretRef: string;
  configured: boolean;
} {
  const secretRef = buildEnvSecretRef(envVarName);
  // H5: never write tenant plaintext into process.env
  if (plaintext != null && String(plaintext) !== '') {
    throw Object.assign(
      new Error(
        'Writing tenant secrets into process.env is forbidden. Use configureTenantMemSecret (local/test) or AWS Secrets Manager (production).'
      ),
      { status: 400, code: 'PROCESS_ENV_SECRET_WRITE_FORBIDDEN' }
    );
  }
  const existing = process.env[String(envVarName).trim()];
  return { secretRef, configured: Boolean(existing && String(existing).trim()) };
}

/** Encrypt plaintext for local storage as encref — still never put raw secret in DB column. */
export function configureLocalEncryptedSecret(secretId: string, plaintext: string): {
  secretRef: string;
  configured: boolean;
} {
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('Local encrypted secrets are not permitted in production — use AWS Secrets Manager'),
      { status: 409, code: 'LOCAL_SECRET_FORBIDDEN_IN_PRODUCTION' }
    );
  }
  const enc = encryptField(plaintext);
  if (!enc) return { secretRef: '', configured: false };
  const id = String(secretId).replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'secret';
  tenantSecretMap.set(`encref::${id}`, enc);
  return { secretRef: buildEncryptedLocalRef(id), configured: true };
}

export function redactSecretsFromText(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

export function publicSecretStatus(ref: string | null | undefined): {
  configured: boolean;
  backend: SecretBackend | null;
  refPresent: boolean;
} {
  const parsed = parseSecretRef(ref);
  return {
    configured: Boolean(parsed),
    backend: parsed?.backend || null,
    refPresent: Boolean(parsed)
  };
}
