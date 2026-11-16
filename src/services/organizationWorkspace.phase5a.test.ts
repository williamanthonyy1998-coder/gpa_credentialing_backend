/**
 * Phase 5A organization workspace HTTP/authorization tests (isolated DB only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { databaseNameFromUrl, databaseUrlLooksIsolated } from '../lib/runtimeSecurity';
import { resolveTenantAuthContext } from './tenantAccess';
import { createAuthSession, revokeSessionByJti } from './authSession';
import organizationWorkspaceRoutes from '../routes/organizationWorkspace';

function assertIsolated() {
  const name = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!name || !databaseUrlLooksIsolated(process.env.DATABASE_URL) || /^credentialing_db$/i.test(name)) {
    throw new Error(`[phase5a] Refusing non-isolated DB: ${name}`);
  }
}

const dbReady = (() => {
  try { assertIsolated(); return true; } catch { return false; }
})();

function suite(name: string, fn: () => Promise<void>) {
  test(name, { skip: !dbReady }, fn);
}

test('phase5a isolated DB gate', () => {
  if (!dbReady) assert.ok(true);
  else assert.equal(databaseUrlLooksIsolated(process.env.DATABASE_URL), true);
});

suite('phase5a: org employees + payers ACL and uniqueness', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Phase5A-Test-Password!!', 4);
  const tenantA = await prisma.tenant.create({
    data: { name: `P5A A ${suffix}`, slug: `p5a-a-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `P5A B ${suffix}`, slug: `p5a-b-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const manager = await prisma.user.create({
    data: {
      email: `p5a.mgr.${suffix}@test.local`,
      name: 'Mgr',
      role: Role.CREDENTIALING_MANAGER,
      passwordHash: hash,
      department: 'Ops',
      jobTitle: 'Manager'
    }
  });
  const staff = await prisma.user.create({
    data: {
      email: `p5a.staff.${suffix}@test.local`,
      name: 'Staff',
      role: Role.CREDENTIALING_SPECIALIST,
      passwordHash: hash,
      department: 'Cred',
      jobTitle: 'Specialist'
    }
  });
  const clientA = await prisma.user.create({
    data: {
      email: `p5a.ca.${suffix}@test.local`,
      name: 'ClientA',
      role: Role.CLIENT_USER,
      passwordHash: hash
    }
  });
  await prisma.tenantMembership.create({
    data: { userId: manager.id, tenantId: tenantA.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: manager.id, tenantId: tenantB.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: clientA.id, tenantId: tenantA.id, role: TenantRole.READ_ONLY, status: 'ACTIVE' }
  });
  const orgA = await prisma.organization.create({
    data: { legalName: `OrgA ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' }
  });
  const orgB = await prisma.organization.create({
    data: { legalName: `OrgB ${suffix}`, tenantId: tenantA.id, status: 'ACTIVE' }
  });
  const orgTenantB = await prisma.organization.create({
    data: { legalName: `OrgTB ${suffix}`, tenantId: tenantB.id, status: 'ACTIVE' }
  });
  await prisma.userOrganization.create({ data: { userId: clientA.id, organizationId: orgA.id } });
  const payer = await prisma.payer.create({
    data: { name: `Payer ${suffix}`, payerType: 'COMMERCIAL', status: 'ACTIVE' }
  });

  const secret = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : 'independent-retest-jwt-secret-32chars-min!!';

  async function tokenFor(user: { id: string; email: string; role: Role }) {
    const session = await createAuthSession({
      userId: user.id,
      email: user.email,
      role: user.role
    });
    return session;
  }

  const mgrSession = await tokenFor(manager);
  const clientSession = await tokenFor(clientA);

  async function attachAuth(req: any, _res: any, next: any) {
    try {
      const header = req.headers.authorization || '';
      const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
      const payload = jwt.verify(raw, secret) as any;
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
  app.use('/api', attachAuth);
  app.use('/api/organizations/:organizationId', organizationWorkspaceRoutes);
  app.use((err: any, _req: any, res: any, _n: any) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;

  async function api(method: string, path: string, sessionToken: string, tenantId: string, body?: any) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, body: json };
  }

  // Manager assigns staff to Org A
  const assign = await api('POST', `/api/organizations/${orgA.id}/employees`, mgrSession.token, tenantA.id, {
    userId: staff.id,
    department: 'Credentialing',
    jobTitle: 'Specialist'
  });
  assert.equal(assign.status, 201, JSON.stringify(assign.body));
  const assignmentId = assign.body.id;

  // Duplicate rejected
  const dup = await api('POST', `/api/organizations/${orgA.id}/employees`, mgrSession.token, tenantA.id, {
    userId: staff.id
  });
  assert.equal(dup.status, 409);

  // Client cannot assign
  const clientAssign = await api('POST', `/api/organizations/${orgA.id}/employees`, clientSession.token, tenantA.id, {
    userId: staff.id
  });
  assert.equal(clientAssign.status, 403);

  // Client Org A cannot list Org B employees
  const crossOrg = await api('GET', `/api/organizations/${orgB.id}/employees`, clientSession.token, tenantA.id);
  assert.equal(crossOrg.status, 404);

  // Client can list Org A employees (read)
  const clientList = await api('GET', `/api/organizations/${orgA.id}/employees`, clientSession.token, tenantA.id);
  assert.equal(clientList.status, 200);
  assert.equal(clientList.body.items.length >= 1, true);

  // HR assignment did not create UserOrganization for staff
  const acl = await prisma.userOrganization.findFirst({
    where: { userId: staff.id, organizationId: orgA.id }
  });
  assert.equal(acl, null);

  // Same staff can also be assigned to Org B (multi-org)
  const assignB = await api('POST', `/api/organizations/${orgB.id}/employees`, mgrSession.token, tenantA.id, {
    userId: staff.id
  });
  assert.equal(assignB.status, 201);

  // Payer participation
  const addPayer = await api('POST', `/api/organizations/${orgA.id}/payers`, mgrSession.token, tenantA.id, {
    payerId: payer.id,
    participationStatus: 'CONTRACTING',
    contractReference: `CTR-${suffix}`
  });
  assert.equal(addPayer.status, 201, JSON.stringify(addPayer.body));
  const relId = addPayer.body.id;

  const dupPayer = await api('POST', `/api/organizations/${orgA.id}/payers`, mgrSession.token, tenantA.id, {
    payerId: payer.id
  });
  assert.equal(dupPayer.status, 409);

  // Client cannot manage payers
  const clientPayer = await api('POST', `/api/organizations/${orgA.id}/payers`, clientSession.token, tenantA.id, {
    payerId: payer.id
  });
  assert.equal(clientPayer.status, 403);

  // Client cannot manage Org B payers (read denied)
  const clientPayerB = await api('GET', `/api/organizations/${orgB.id}/payers`, clientSession.token, tenantA.id);
  assert.equal(clientPayerB.status, 404);

  // Cross-tenant: manager in tenant B context cannot see tenant A org
  const crossTenant = await api('GET', `/api/organizations/${orgA.id}/employees`, mgrSession.token, tenantB.id);
  assert.equal(crossTenant.status, 404);

  // Tenant B org is accessible under tenant B
  const tenantBOk = await api('GET', `/api/organizations/${orgTenantB.id}/workspace-summary`, mgrSession.token, tenantB.id);
  assert.equal(tenantBOk.status, 200);

  // Summary includes employee/payer counts for Org A
  const summary = await api('GET', `/api/organizations/${orgA.id}/workspace-summary`, mgrSession.token, tenantA.id);
  assert.equal(summary.status, 200);
  assert.ok(summary.body.employeesTotal >= 1);
  assert.ok(summary.body.payersTotal >= 1);

  // Cleanup sessions
  await revokeSessionByJti(mgrSession.jti);
  await revokeSessionByJti(clientSession.jti);
  server.close();

  // Touch ids to avoid unused lint in some runners
  assert.ok(assignmentId && relId);
});
