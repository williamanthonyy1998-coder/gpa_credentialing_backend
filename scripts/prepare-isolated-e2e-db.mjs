/**
 * Create / migrate an isolated credentialing_e2e database using DATABASE_URL credentials.
 * Never prints the connection string or password.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

function dbNameFromUrl(url) {
  try {
    const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
    return (u.pathname || '').split('/').filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

function rewriteDbName(url, newName) {
  const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
  u.pathname = `/${newName}`;
  return u.toString().replace(/^http:/, 'postgresql:');
}

const source = process.env.DATABASE_URL;
if (!source) {
  console.error('[prepare-e2e] DATABASE_URL is required');
  process.exit(1);
}
const sourceName = dbNameFromUrl(source);
if (!sourceName) {
  console.error('[prepare-e2e] Could not parse database name from DATABASE_URL');
  process.exit(1);
}

const e2eName = process.env.E2E_DATABASE_NAME || 'credentialing_e2e';
if (/^credentialing_db$/i.test(e2eName) || /production/i.test(e2eName)) {
  console.error('[prepare-e2e] Refusing unsafe E2E_DATABASE_NAME');
  process.exit(1);
}

const alreadyIsolated = /(_e2e|_test)$/i.test(sourceName) || /^credentialing_e2e$/i.test(sourceName);
const e2eUrl = alreadyIsolated ? source : rewriteDbName(source, e2eName);

if (!alreadyIsolated) {
  const adminUrl = rewriteDbName(source, 'postgres');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [e2eName]);
  if (!existing.rowCount) {
    await client.query(`CREATE DATABASE "${e2eName}"`);
    console.log(`[prepare-e2e] Created isolated database "${e2eName}"`);
  } else {
    console.log(`[prepare-e2e] Isolated database "${e2eName}" already exists`);
  }
  await client.end();
} else {
  console.log(`[prepare-e2e] DATABASE_URL already targets isolated database "${sourceName}"`);
}

const migrate = spawnSync(
  'npx',
  ['prisma', 'migrate', 'deploy'],
  {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: e2eUrl },
    encoding: 'utf8',
    shell: true
  }
);
if (migrate.status !== 0) {
  console.error('[prepare-e2e] migrate deploy failed');
  console.error(migrate.stderr || migrate.stdout);
  process.exit(migrate.status || 1);
}
console.log(`[prepare-e2e] Migrations applied to "${alreadyIsolated ? sourceName : e2eName}"`);
