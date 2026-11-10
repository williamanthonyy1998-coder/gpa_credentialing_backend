/**
 * Local smoke checks against a running API (default http://localhost:4000).
 * Usage: npx tsx scripts/smoke-api.ts
 */
import 'dotenv/config';

const base = process.env.SMOKE_API_URL || 'http://localhost:4000';
const email = process.env.SMOKE_EMAIL || 'admin@example.com';
const password = process.env.SEED_DEFAULT_PASSWORD || 'LocalDemo-ChangeThis-2026!';

async function req(path: string, opts: RequestInit = {}, token?: string) {
  const headers: any = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  const failures: string[] = [];
  const health = await req('/health');
  if (health.status !== 200 || health.body?.database !== 'connected') failures.push('health');

  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (login.status !== 200 || !login.body?.token) {
    console.error('Login failed', login.status, login.body);
    process.exit(1);
  }
  const token = login.body.token as string;

  const checks: Array<[string, number]> = [
    ['/api/dashboard', 200],
    ['/api/enrollments/summary', 200],
    ['/api/enrollments?page=1&pageSize=10', 200],
    ['/api/intake/summary', 200],
    ['/api/leave/types', 200],
    ['/api/attendance?mine=1', 200],
    ['/api/notifications', 200],
    ['/api/search?q=Demo', 200],
    ['/api/organizations?page=1&pageSize=5', 200]
  ];

  for (const [path, expected] of checks) {
    const res = await req(path, {}, token);
    if (res.status !== expected) {
      failures.push(`${path} -> ${res.status}`);
      console.error('FAIL', path, res.status, res.body);
    } else {
      console.log('OK', path);
    }
  }

  // Unauthorized without token
  const unauth = await req('/api/dashboard');
  if (unauth.status !== 401) failures.push('unauthenticated dashboard should be 401');

  if (failures.length) {
    console.error('Smoke failures:', failures);
    process.exit(1);
  }
  console.log('Smoke checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
