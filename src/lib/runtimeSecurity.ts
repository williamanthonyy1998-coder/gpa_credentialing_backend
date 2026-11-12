/**
 * Startup and runtime security guards (C2 / C3 / SEC-12).
 * Fail closed in production — never silently disable safeguards.
 */

export type RuntimeEnv = Record<string, string | undefined>;

/** E2E login rate-limit bypass is allowed only outside production against an isolated e2e/test DB. */
export function isE2eLoginBypassAllowed(env: RuntimeEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (env.E2E_SAFE_DATABASE !== '1') return false;
  const dbUrl = String(env.DATABASE_URL || '');
  return /(_e2e|_test)([/?]|$)/i.test(dbUrl) || /\/credentialing_e2e([/?]|$)/i.test(dbUrl);
}

export function hasIntegrationMockFlags(env: RuntimeEnv = process.env): boolean {
  return env.INTEGRATION_TEST_MOCK === '1' || env.CAQH_ALLOW_MOCK_CONNECT === '1';
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
}
