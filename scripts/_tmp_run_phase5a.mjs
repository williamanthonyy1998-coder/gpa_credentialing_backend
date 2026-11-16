import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const backend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envText = fs.readFileSync(path.join(backend, '.env'), 'utf8');
const m = envText.match(/DATABASE_URL="?([^"\r\n]+)"?/);
if (!m) throw new Error('DATABASE_URL missing');
const u = new URL(m[1]);
const e2eUrl = `postgresql://${u.username}:${decodeURIComponent(u.password)}@${u.host}/credentialing_e2e?schema=public`;

const env = {
  ...process.env,
  DATABASE_URL: e2eUrl,
  E2E_SAFE_DATABASE: '1',
  FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST: '1'
};

function run(cmd) {
  console.log(`\n>>> ${cmd}`);
  execSync(cmd, { env, stdio: 'inherit', cwd: backend });
}

run('npx prisma validate');
run('npx prisma migrate deploy');
run('npx tsc --noEmit -p tsconfig.json');
run('npx tsx --test src/services/organizationWorkspace.phase5a.test.ts src/services/tenantAccess.unit.test.ts src/services/securityRemediation.round2.test.ts');
