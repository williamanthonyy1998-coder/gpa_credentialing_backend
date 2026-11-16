/**
 * Final comprehensive security hardening validation (isolated DB only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  DocumentSecurityStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { databaseNameFromUrl, databaseUrlLooksIsolated, assertSafeRuntimeConfig, assertProductionSecurityIntegrations } from '../lib/runtimeSecurity';
import { encryptField, decryptField, isEncryptedValue } from '../lib/fieldCrypto';
import resourcesRoutes from '../routes/resources';
import enrollmentPacketRoutes from '../routes/enrollmentPacket';
import enrollmentSubmissionRoutes from '../routes/enrollmentSubmission';
import { enrollmentRevalidationRoutes } from '../routes/enrollmentRevalidation';
import intakeRoutes from '../routes/intake';
import { resolveTenantAuthContext } from './tenantAccess';
import { createAuthSession, assertSessionActive, revokeSessionByJti } from './authSession';
import { hashResetToken } from './authSession';

function assertIsolated() {
  const name = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!name || !databaseUrlLooksIsolated(process.env.DATABASE_URL) || /^credentialing_db$/i.test(name)) {
    throw new Error(`[closure] Refusing non-isolated DB: ${name}`);
  }
}

const dbReady = (() => {
  try { assertIsolated(); return true; } catch { return false; }
})();

function suite(name: string, fn: () => Promise<void> | void) {
  test(name, { skip: !dbReady }, fn);
}

test('closure: isolated DB gate reports status', () => {
  if (!dbReady) {
    assert.ok(true, 'DB suites skipped — not isolated');
  } else {
    assert.equal(databaseUrlLooksIsolated(process.env.DATABASE_URL), true);
  }
});

test('production config refuses missing storage/scanner integrations', () => {
  assert.throws(
    () => assertProductionSecurityIntegrations({
      NODE_ENV: 'production',
      OBJECT_STORAGE_DRIVER: 's3'
    }),
    /S3/
  );
  assert.throws(
    () => assertProductionSecurityIntegrations({
      NODE_ENV: 'production',
      OBJECT_STORAGE_DRIVER: 'local'
    }),
    /durable object storage/
  );
  assert.throws(
    () => assertProductionSecurityIntegrations({
      NODE_ENV: 'production',
      OBJECT_STORAGE_DRIVER: 'supabase'
    }),
    /SUPABASE_URL|incomplete/
  );
  // Production default (unset driver) is supabase — must not require S3 vars.
  assert.throws(
    () => assertProductionSecurityIntegrations({
      NODE_ENV: 'production'
    }),
    /SUPABASE_/
  );
  assert.doesNotThrow(() => assertProductionSecurityIntegrations({
    NODE_ENV: 'production',
    OBJECT_STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_STORAGE_BUCKET: 'credentialing-docs',
    MALWARE_SCANNER_URL: 'https://scanner.example/scan'
  }));
  // Explicit waiver: production boots without scanner URL/host when MALWARE_SCAN_REQUIRED=0.
  assert.doesNotThrow(() => assertProductionSecurityIntegrations({
    NODE_ENV: 'production',
    OBJECT_STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_STORAGE_BUCKET: 'credentialing-docs',
    MALWARE_SCAN_REQUIRED: '0'
  }));
  assert.throws(
    () => assertProductionSecurityIntegrations({
      NODE_ENV: 'production',
      OBJECT_STORAGE_DRIVER: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
      SUPABASE_STORAGE_BUCKET: 'credentialing-docs'
      // no scanner and no MALWARE_SCAN_REQUIRED=0
    }),
    /MALWARE_SCAN_REQUIRED=0|MALWARE_SCANNER_URL|CLAMAV_HOST/
  );
  assert.doesNotThrow(() => assertProductionSecurityIntegrations({
    NODE_ENV: 'production',
    OBJECT_STORAGE_DRIVER: 's3',
    S3_BUCKET: 'private-bucket',
    AWS_REGION: 'us-east-1',
    MALWARE_SCANNER_URL: 'https://scanner.example/scan'
  }));
  assert.doesNotThrow(() => assertSafeRuntimeConfig({
    NODE_ENV: 'production',
    FIELD_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    WEB_ORIGIN: 'https://app.example.com',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/credentialing_prod'
  }));
});

test('enc:v2 round-trip and no double encrypt', () => {
  const prev = process.env.FIELD_ENCRYPTION_KEY;
  const prevAllow = process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  process.env.FIELD_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  delete process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
  const enc = encryptField('021000021');
  assert.ok(enc && enc.startsWith('enc:v2:'));
  assert.equal(decryptField(enc), '021000021');
  assert.equal(encryptField(enc), enc);
  assert.equal(isEncryptedValue(enc), true);
  if (prev !== undefined) process.env.FIELD_ENCRYPTION_KEY = prev; else delete process.env.FIELD_ENCRYPTION_KEY;
  if (prevAllow !== undefined) process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST = prevAllow;
  else delete process.env.FIELD_ENCRYPTION_ALLOW_PLAINTEXT_TEST;
});

suite('closure HTTP: RT-06 nested enrollment org ACL deny', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Closure-Test-Password!!', 4);
  const tenantA = await prisma.tenant.create({ data: { name: `CL A ${suffix}`, slug: `cl-a-${suffix}`, status: TenantStatus.ACTIVE } });
  const clientA = await prisma.user.create({ data: { email: `cl.ca.${suffix}@test.local`, name: 'CA', role: Role.CLIENT_USER, passwordHash: hash } });
  await prisma.tenantMembership.create({ data: { userId: clientA.id, tenantId: tenantA.id, role: TenantRole.READ_ONLY, status: 'ACTIVE' } });
  const orgA = await prisma.organization.create({ data: { legalName: `OA ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' } });
  const orgB = await prisma.organization.create({ data: { legalName: `OB ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' } });
  await prisma.userOrganization.create({ data: { userId: clientA.id, organizationId: orgA.id } });
  const provider = await prisma.provider.create({ data: { firstName: 'P', lastName: `CL${suffix}`, npi: `${Date.now()}`.slice(-10).padStart(10, '1') } });
  await prisma.tenantProvider.create({ data: { tenantId: tenantA.id, providerId: provider.id } });
  const payer = await prisma.payer.create({ data: { name: `Pay ${suffix}`, status: 'ACTIVE' } });
  const plan = await prisma.payerPlan.create({ data: { payerId: payer.id, name: `Plan ${suffix}`, status: 'ACTIVE' } });
  const enrollB = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `CLB-${suffix}`,
      tenantId: tenantA.id,
      organizationId: orgB.id,
      providerId: provider.id,
      payerPlanId: plan.id,
      status: 'PREPARING'
    }
  });

  const secret = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : 'independent-retest-jwt-secret-32chars-min!!';
  const session = await createAuthSession({
    userId: clientA.id,
    email: clientA.email,
    role: clientA.role
  });

  async function attachAuth(req: any, _res: any, next: any) {
    try {
      const payload = jwt.verify(session.token, secret) as any;
      await assertSessionActive(payload.jti);
      req.user = payload;
      req.tenantContext = await resolveTenantAuthContext({
        userId: payload.id,
        platformRole: payload.role,
        requestedTenantId: req.headers['x-tenant-id'] || null
      });
      next();
    } catch (e: any) {
      next(Object.assign(new Error(e.message || 'auth'), { status: 401 }));
    }
  }

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', attachAuth);
  app.use('/api/enrollments/:id', enrollmentPacketRoutes);
  app.use('/api/enrollments/:id', enrollmentSubmissionRoutes);
  app.use('/api/enrollments/:id', enrollmentRevalidationRoutes);
  app.use('/api/intake', intakeRoutes);
  app.use('/api', resourcesRoutes);
  app.use((err: any, _req: any, res: any, _n: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  async function get(path: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${session.token}`, 'X-Tenant-Id': tenantA.id }
    });
    return res.status;
  }

  assert.equal(await get(`/api/enrollments/${enrollB.id}/packet`), 404);
  assert.equal(await get(`/api/enrollments/${enrollB.id}/submissions`), 404);
  assert.equal(await get(`/api/enrollments/${enrollB.id}/revalidations`), 404);

  server.close();
  await revokeSessionByJti(session.jti);
});

suite('closure: session revoke invalidates jti', async () => {
  const hash = await bcrypt.hash('Closure-Test-Password!!', 4);
  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `cl.sess.${suffix}@test.local`, name: 'S', role: Role.ADMIN, passwordHash: hash }
  });
  const session = await createAuthSession({ userId: user.id, email: user.email, role: user.role });
  await assertSessionActive(session.jti);
  await revokeSessionByJti(session.jti);
  await assert.rejects(() => assertSessionActive(session.jti));
});

suite('closure: password reset token hash stored only', async () => {
  const hash = await bcrypt.hash('Closure-Test-Password!!', 4);
  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `cl.reset.${suffix}@test.local`, name: 'R', role: Role.CLIENT_USER, passwordHash: hash }
  });
  const raw = 'test-reset-token-value-not-logged';
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + 3600_000)
    }
  });
  const row = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
  assert.ok(row);
  assert.notEqual(row!.tokenHash, raw);
  assert.equal(row!.tokenHash, hashResetToken(raw));
});

test('closure skipped notice when DB not isolated', { skip: dbReady }, () => {
  assert.ok(true);
});
