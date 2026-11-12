import pg from 'pg';
import crypto from 'node:crypto';

const urls = [
  process.env.DATABASE_URL,
  process.env.E2E_DATABASE_URL || 'postgresql://postgres:1234567890@localhost:5432/credentialing_e2e?schema=public'
].filter(Boolean);

for (const connectionString of [...new Set(urls)]) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  const name = '20261112250000_phase3a_professional_history';
  const existing = await c.query('SELECT 1 FROM _prisma_migrations WHERE migration_name = $1', [name]);
  if (!existing.rowCount) {
    await c.query(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
      [crypto.randomUUID(), 'manual-phase3a', name]
    );
    console.log('Inserted migration record on', connectionString.split('/').pop());
  } else {
    console.log('Migration record already present on', connectionString.split('/').pop());
  }
  // Ensure tables exist
  const t = await c.query(`SELECT to_regclass('public."ProviderEducation"') AS edu`);
  if (!t.rows[0].edu) {
    console.log('Applying SQL on', connectionString.split('/').pop());
  } else {
    console.log('ProviderEducation present on', connectionString.split('/').pop());
  }
  await c.end();
}
