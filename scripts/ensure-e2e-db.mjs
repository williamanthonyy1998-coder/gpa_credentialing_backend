import pg from 'pg';

const adminUrl = process.env.DATABASE_ADMIN_URL
  || 'postgresql://postgres:1234567890@localhost:5432/postgres';
const dbName = process.env.E2E_DATABASE_NAME || 'credentialing_e2e';

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
const r = await client.query('SELECT datname FROM pg_database WHERE datname = $1', [dbName]);
if (!r.rows.length) {
  await client.query(`CREATE DATABASE "${dbName}"`);
  console.log(`Created database ${dbName}`);
} else {
  console.log(`Database ${dbName} already exists`);
}
await client.end();
