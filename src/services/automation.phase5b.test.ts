/**
 * Phase 5B workflow automation — HTTP + isolated DB tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import {
  EnrollmentStatus,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { databaseNameFromUrl, databaseUrlLooksIsolated } from '../lib/runtimeSecurity';
import automationRoutes from '../routes/automation';
import {
  acquireJobLock,
  releaseJobLock,
  runTenantAutomationSweep,
  sweepFollowUps,
  sweepEscalations,
  refreshEnrollmentSla
} from './automationEngine';
import { validatePolicyConfig } from './automationPolicies';
import { AutomationPolicyKind } from '@prisma/client';
import { sanitizeNotificationText } from './automationNotifications';

function assertIsolated() {
  const name = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!name || !databaseUrlLooksIsolated(process.env.DATABASE_URL) || /^credentialing_db$/i.test(name)) {
    throw new Error(`[phase5b] Refusing non-isolated DB: ${name}`);
  }
}

const dbReady = (() => {
  try { assertIsolated(); return true; } catch { return false; }
})();

function suite(name: string, fn: () => Promise<void>) {
  test(name, { skip: !dbReady }, fn);
}

test('phase5b isolated DB gate', () => {
  if (!dbReady) assert.ok(true);
  else assert.equal(databaseUrlLooksIsolated(process.env.DATABASE_URL), true);
});

test('phase5b policy config validation', () => {
  assert.throws(() => validatePolicyConfig(AutomationPolicyKind.FOLLOW_UP_INTERVAL, { defaultIntervalDays: -1 }));
  const ok = validatePolicyConfig(AutomationPolicyKind.ESCALATION, { thresholdsDays: [7, 14, 30] });
  assert.deepEqual(ok.thresholdsDays, [7, 14, 30]);
});

test('phase5b notification sanitization strips SSN patterns', () => {
  const out = sanitizeNotificationText('Patient SSN 123-45-6789 tax id leak');
  assert.ok(!out.includes('123-45-6789'));
});

suite('phase5b: lock concurrency', async () => {
  const key = `test-lock-${Date.now()}`;
  const a = await acquireJobLock(key, 60_000);
  assert.ok(a);
  const b = await acquireJobLock(key, 60_000);
  assert.equal(b, null);
  await releaseJobLock(key, a!.ownerId);
  const c = await acquireJobLock(key, 60_000);
  assert.ok(c);
  await releaseJobLock(key, c!.ownerId);
});

suite('phase5b: follow-up, escalation, SLA, HTTP auth', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Phase5B-Test-Password!!', 4);

  const tenantA = await prisma.tenant.create({
    data: { name: `P5B A ${suffix}`, slug: `p5b-a-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `P5B B ${suffix}`, slug: `p5b-b-${suffix}`, status: TenantStatus.ACTIVE }
  });

  const manager = await prisma.user.create({
    data: {
      email: `p5b.mgr.${suffix}@test.local`,
      name: 'Mgr',
      role: Role.CREDENTIALING_MANAGER,
      passwordHash: hash
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `p5b.client.${suffix}@test.local`,
      name: 'Client',
      role: Role.CLIENT_USER,
      passwordHash: hash
    }
  });

  await prisma.tenantMembership.create({
    data: { userId: manager.id, tenantId: tenantA.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: client.id, tenantId: tenantA.id, role: TenantRole.READ_ONLY, status: 'ACTIVE' }
  });

  const org = await prisma.organization.create({
    data: {
      tenantId: tenantA.id,
      legalName: `Org ${suffix}`,
      status: 'ACTIVE'
    }
  });
  const orgB = await prisma.organization.create({
    data: {
      tenantId: tenantB.id,
      legalName: `OrgB ${suffix}`,
      status: 'ACTIVE'
    }
  });

  const payer = await prisma.payer.create({
    data: { name: `Payer ${suffix}`, payerCode: `P5B${suffix}`, payerType: 'COMMERCIAL', status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Plan ${suffix}`, status: 'ACTIVE' }
  });

  const pending = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `P5B-ENR-${suffix}`,
      tenantId: tenantA.id,
      organizationId: org.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.SUBMITTED,
      submittedAt: new Date(Date.now() - 20 * 86400000),
      nextFollowUpAt: new Date(Date.now() - 86400000)
    }
  });

  const closed = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `P5B-CLOSED-${suffix}`,
      tenantId: tenantA.id,
      organizationId: org.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.DENIED,
      submittedAt: new Date(Date.now() - 40 * 86400000),
      nextFollowUpAt: new Date(Date.now() - 86400000),
      decisionAt: new Date()
    }
  });

  // Follow-up sweep schedules open pending, not closed
  const fu = await sweepFollowUps(tenantA.id);
  assert.ok(fu.scheduled >= 1);
  const openTask = await prisma.task.findFirst({
    where: { tenantId: tenantA.id, enrollmentId: pending.id, source: 'ENROLLMENT_FOLLOWUP', status: 'OPEN' }
  });
  assert.ok(openTask);
  const closedTask = await prisma.task.findFirst({
    where: { tenantId: tenantA.id, enrollmentId: closed.id, source: 'ENROLLMENT_FOLLOWUP', status: 'OPEN' }
  });
  assert.equal(closedTask, null);

  // Idempotent: second sweep should not duplicate open fingerprint tasks for same due day
  const beforeCount = await prisma.task.count({
    where: { tenantId: tenantA.id, enrollmentId: pending.id, source: 'ENROLLMENT_FOLLOWUP' }
  });
  await sweepFollowUps(tenantA.id);
  const afterCount = await prisma.task.count({
    where: { tenantId: tenantA.id, enrollmentId: pending.id, source: 'ENROLLMENT_FOLLOWUP' }
  });
  assert.equal(afterCount, beforeCount);

  // Escalation + dedupe
  const esc1 = await sweepEscalations(tenantA.id);
  assert.ok(esc1.created >= 1);
  const esc2 = await sweepEscalations(tenantA.id);
  assert.equal(esc2.created, 0);
  assert.ok(esc2.skipped >= 1);

  const statusBefore = (await prisma.enrollmentApplication.findUnique({ where: { id: pending.id } }))!.status;
  assert.equal(statusBefore, EnrollmentStatus.SUBMITTED);

  // SLA refresh
  const sla = await refreshEnrollmentSla(tenantA.id);
  assert.ok(sla.upserted >= 1);
  const slaRow = await prisma.workflowSlaRecord.findUnique({
    where: { entityType_entityId: { entityType: 'enrollment', entityId: pending.id } }
  });
  assert.ok(slaRow);
  assert.ok(['OVERDUE', 'AT_RISK', 'DUE_SOON', 'WITHIN_SLA'].includes(slaRow!.slaStatus));

  // Full sweep job
  const run = await runTenantAutomationSweep(tenantA.id, manager.id);
  assert.ok(['SUCCEEDED', 'SKIPPED'].includes(run.status));

  // HTTP app
  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token.startsWith('mgr:')) {
      req.user = { id: manager.id, role: Role.CREDENTIALING_MANAGER, email: manager.email };
      req.tenantContext = { tenantId: tenantA.id };
    } else if (token.startsWith('client:')) {
      req.user = { id: client.id, role: Role.CLIENT_USER, email: client.email };
      req.tenantContext = { tenantId: tenantA.id };
    } else if (token.startsWith('cross:')) {
      req.user = { id: manager.id, role: Role.CREDENTIALING_MANAGER, email: manager.email };
      req.tenantContext = { tenantId: tenantB.id };
    }
    next();
  });
  app.use('/api/automation', automationRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  async function req(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  const dash = await req('/api/automation/dashboard', { token: 'mgr:1' });
  assert.equal(dash.status, 200);
  assert.ok(typeof dash.data.openEscalations === 'number');

  const clientDenied = await req('/api/automation/dashboard', { token: 'client:1' });
  assert.equal(clientDenied.status, 403);

  const policyDenied = await req('/api/automation/policies', {
    method: 'POST',
    token: 'client:1',
    body: { kind: 'SLA', name: 'hack', config: { slaTargetDays: 10 } }
  });
  assert.equal(policyDenied.status, 403);

  const policyOk = await req('/api/automation/policies', {
    method: 'POST',
    token: 'mgr:1',
    body: {
      kind: 'FOLLOW_UP_INTERVAL',
      name: `Custom interval ${suffix}`,
      organizationId: org.id,
      config: { defaultIntervalDays: 5, intervalsDays: [5, 10] }
    }
  });
  assert.ok([200, 201].includes(policyOk.status));

  // Cross-tenant: manager acting as tenant B cannot see tenant A escalation by id via queue scoped to B
  const escA = await prisma.escalationRecord.findFirst({
    where: { tenantId: tenantA.id, entityId: pending.id }
  });
  assert.ok(escA);
  const crossQueue = await req('/api/automation/queues/escalated', { token: 'cross:1' });
  assert.equal(crossQueue.status, 200);
  assert.ok(!(crossQueue.data.items || []).some((i: any) => i.id === escA!.id));

  // Org B (tenant B) reminder isolation via org filter on tenant A manager is not applicable;
  // ensure tenant B org has no A escalations.
  const leak = await prisma.escalationRecord.count({
    where: { tenantId: tenantB.id, entityId: pending.id }
  });
  assert.equal(leak, 0);
  assert.ok(orgB.id);

  assert.ok(orgB.id);
  server.close();
});
