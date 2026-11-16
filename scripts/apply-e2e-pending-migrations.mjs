/**
 * Apply pending Prisma migrations to credentialing_e2e only.
 * Never targets credentialing_db.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

function rewrite(url, name) {
  const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
  u.pathname = `/${name}`;
  return u.toString().replace(/^http:/, 'postgresql:');
}

const source = process.env.DATABASE_URL;
if (!source) {
  console.error('DATABASE_URL required');
  process.exit(1);
}
const url = rewrite(source, 'credentialing_e2e');
process.env.DATABASE_URL = url;
console.log('USING_DB_NAME=credentialing_e2e');

const deploy = spawnSync('npx prisma migrate deploy', {
  env: process.env,
  stdio: 'inherit',
  shell: true
});
if (deploy.status) process.exit(deploy.status);

const client = new pg.Client({ connectionString: url });
await client.connect();
const count = await client.query('SELECT COUNT(*)::int AS n FROM "_prisma_migrations"');
console.log('applied_migrations=' + count.rows[0].n);
const recent = await client.query(
  `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE $1`,
  ['20261114%']
);
console.log('applied_20261114=' + JSON.stringify(recent.rows.map((r) => r.migration_name)));
const tables = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`,
  [['AuthSession', 'PasswordResetToken']]
);
console.log('security_tables=' + JSON.stringify(tables.rows.map((r) => r.tablename)));
await client.end();
