/**
 * Apply security hardening SQL to credentialing_e2e only (counts/tables; no secrets).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

function rewrite(url, name) {
  const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
  u.pathname = `/${name}`;
  return u.toString().replace(/^http:/, 'postgresql:');
}

const url = rewrite(process.env.DATABASE_URL, 'credentialing_e2e');
const name = new URL(url.replace(/^postgresql:/i, 'http:')).pathname.split('/').filter(Boolean)[0];
if (name !== 'credentialing_e2e') {
  console.error('REFUSE: not credentialing_e2e');
  process.exit(2);
}
console.log('USING_DB_NAME=' + name);
const sqlPath = path.join(process.cwd(), 'prisma/migrations/20261114010000_security_hardening_closure/migration.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(sql);
const tables = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
  [['AuthSession', 'PasswordResetToken']]
);
console.log('security_tables=' + tables.rows.map((r) => r.tablename).sort().join(','));
await client.end();
console.log('SQL_APPLIED_OK');
