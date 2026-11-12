import pg from 'pg';
import crypto from 'node:crypto';

const dbs = [
  'postgresql://postgres:1234567890@localhost:5432/credentialing_db?schema=public',
  'postgresql://postgres:1234567890@localhost:5432/credentialing_e2e?schema=public'
];
const name = '20261112260000_phase3b_license_lifecycle';

for (const connectionString of dbs) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='License' AND column_name = ANY($1)`,
    [['tenantId', 'verificationStatus', 'renewedFromId']]
  );
  console.log(connectionString.split('/').pop(), cols.rows.map((r) => r.column_name));
  const existing = await c.query('SELECT 1 FROM _prisma_migrations WHERE migration_name = $1', [name]);
  if (!existing.rowCount) {
    await c.query(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1,$2,NOW(),$3,NULL,NULL,NOW(),1)`,
      [crypto.randomUUID(), 'manual-phase3b', name]
    );
    console.log('inserted migration row');
  } else {
    console.log('migration row exists');
  }
  await c.end();
}
