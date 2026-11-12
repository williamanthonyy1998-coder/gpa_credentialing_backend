import pg from 'pg';

const url = process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url });
await c.connect();
const r = await c.query(
  `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name LIKE '%phase3a%' OR migration_name LIKE '%2c%'`
);
console.log(r.rows);
const t = await c.query(`SELECT to_regclass('public."ProviderEducation"') AS edu`);
console.log('ProviderEducation:', t.rows[0]);
await c.end();
