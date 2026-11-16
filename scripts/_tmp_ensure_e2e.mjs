import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(root, '..');
const env = fs.readFileSync(path.join(backend, '.env'), 'utf8');
const m = env.match(/DATABASE_URL="?([^"\r\n]+)"?/);
if (!m) throw new Error('DATABASE_URL missing');
const u = new URL(m[1]);
process.env.DATABASE_ADMIN_URL = `postgresql://${u.username}:${decodeURIComponent(u.password)}@${u.host}/postgres`;
execSync('node scripts/ensure-e2e-db.mjs', { env: process.env, stdio: 'inherit', cwd: backend });
