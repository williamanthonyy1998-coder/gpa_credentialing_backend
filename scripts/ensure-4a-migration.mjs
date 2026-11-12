import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(
  path.join(__dirname, '../prisma/migrations/20261112290000_phase4a_enrollment_lifecycle/migration.sql'),
  'utf8'
);
const name = '20261112290000_phase4a_enrollment_lifecycle';
const dbs = [
  'postgresql://postgres:1234567890@localhost:5432/credentialing_db?schema=public',
  'postgresql://postgres:1234567890@localhost:5432/credentialing_e2e?schema=public'
];

for (const connectionString of dbs) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  console.log('applying', connectionString.split('/').pop());
  await c.query(sql);
  const existing = await c.query('SELECT 1 FROM _prisma_migrations WHERE migration_name = $1', [name]);
  if (!existing.rowCount) {
    await c.query(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1,$2,NOW(),$3,NULL,NULL,NOW(),1)`,
      [crypto.randomUUID(), 'manual-phase4a', name]
    );
    console.log('inserted migration row');
  } else console.log('migration row exists');
  await c.end();
}
