/**
 * Apply Phase 5A migration SQL to credentialing_e2e only.
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
  console.error('REFUSE');
  process.exit(2);
}
console.log('USING_DB_NAME=' + name);
const client = new pg.Client({ connectionString: url });
await client.connect();

const existing = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
  [['OrganizationEmployee', 'OrganizationPayer']]
);
if (existing.rows.length < 2) {
  const sqlPath = path.join(process.cwd(), 'prisma/migrations/20261114020000_phase5a_organization_workspace/migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await client.query(sql);
  console.log('SQL_APPLIED');
} else {
  console.log('SQL_ALREADY_PRESENT');
}

const migName = '20261114020000_phase5a_organization_workspace';
const mig = await client.query(
  `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1::text`,
  [migName]
);
if (!mig.rowCount) {
  await client.query(
    `INSERT INTO "_prisma_migrations"
      ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
     VALUES ($1::text, $2::text, NOW(), $3::text, NULL, NULL, NOW(), 1)`,
    [`manual-phase5a-${Date.now()}`, 'manual-apply-phase5a', migName]
  );
  console.log('MIGRATION_MARKED');
}

const tables = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
  [['OrganizationEmployee', 'OrganizationPayer']]
);
console.log('tables=' + tables.rows.map((r) => r.tablename).sort().join(','));
await client.end();
console.log('PHASE5A_SQL_OK');
