/**
 * Phase 5C — calendar, preferences, terminal follow-up cancel, portal SLA, ops.
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
  TenantStatus,
  TaskStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { databaseNameFromUrl, databaseUrlLooksIsolated } from '../lib/runtimeSecurity';
import automationRoutes from '../routes/automation';
import notificationsRoutes from '../routes/notifications';
import portalRoutes from '../routes/portal';
import {
  cancelFollowUpsOnClosingStatus,
  FOLLOW_UP_CLOSING_STATUSES,
  ENROLLMENT_FOLLOWUP_SOURCE,
  transitionEnrollment
} from './enrollmentLifecycle';
import {
  getEffectivePreferences,
  upsertPreferences,
  mapNotificationTypeToCategory,
  MANDATORY_IN_APP_CATEGORIES
} from './notificationPreferences';
import { getCredentialExpirationCalendar } from './credentialExpirationCalendar';
import { getPortalWorkflowSummary } from './portalWorkflowSummary';
import { getAutomationOpsVisibility } from './automationOps';
import { deliverAutomationNotification } from './automationNotifications';

function assertIsolated() {
  const name = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!name || !databaseUrlLooksIsolated(process.env.DATABASE_URL) || /^credentialing_db$/i.test(name)) {
    throw new Error(`[phase5c] Refusing non-isolated DB: ${name}`);
  }
}

const dbReady = (() => {
  try { assertIsolated(); return true; } catch { return false; }
})();

function suite(name: string, fn: () => Promise<void>) {
  test(name, { skip: !dbReady }, fn);
}

test('phase5c isolated DB gate', () => {
  if (!dbReady) assert.ok(true);
  else assert.equal(databaseUrlLooksIsolated(process.env.DATABASE_URL), true);
});

test('phase5c preference category mapping + mandatory system', () => {
  assert.equal(mapNotificationTypeToCategory('FOLLOW_UP_DUE'), 'FOLLOW_UP');
  assert.equal(mapNotificationTypeToCategory('ESCALATION'), 'ESCALATION');
  assert.ok(MANDATORY_IN_APP_CATEGORIES.includes('SYSTEM'));
  assert.ok(FOLLOW_UP_CLOSING_STATUSES.includes(EnrollmentStatus.APPROVED));
  assert.ok(FOLLOW_UP_CLOSING_STATUSES.includes(EnrollmentStatus.DENIED));
});

suite('phase5c: preferences cannot modify another user; mandatory in-app', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Phase5C-Prefs!!', 4);
  const a = await prisma.user.create({
    data: { email: `p5c.a.${suffix}@test.local`, name: 'A', role: Role.CREDENTIALING_SPECIALIST, passwordHash: hash }
  });
  const b = await prisma.user.create({
    data: { email: `p5c.b.${suffix}@test.local`, name: 'B', role: Role.CREDENTIALING_SPECIALIST, passwordHash: hash }
  });

  await assert.rejects(
    () => upsertPreferences({
      userId: b.id,
      actorId: a.id,
      items: [{ category: 'FOLLOW_UP', channelEmail: false }]
    }),
    (e: any) => e.status === 403
  );

  const items = await upsertPreferences({
    userId: a.id,
    actorId: a.id,
    items: [{ category: 'SYSTEM', channelInApp: false, channelEmail: false }]
  });
  const system = items.find((i) => i.category === 'SYSTEM')!;
  assert.equal(system.channelInApp, true);
  assert.equal(system.channelEmail, false);

  const eff = await getEffectivePreferences(a.id);
  assert.ok(eff.length >= 8);
});

suite('phase5c: terminal transition cancels follow-ups for all closing statuses', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Phase5C-Term!!', 4);
  const tenant = await prisma.tenant.create({
    data: { name: `P5C T ${suffix}`, slug: `p5c-t-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const manager = await prisma.user.create({
    data: {
      email: `p5c.mgr.${suffix}@test.local`,
      name: 'Mgr',
      role: Role.CREDENTIALING_MANAGER,
      passwordHash: hash
    }
  });
  await prisma.tenantMembership.create({
    data: { userId: manager.id, tenantId: tenant.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  const org = await prisma.organization.create({
    data: { tenantId: tenant.id, legalName: `Org ${suffix}`, status: 'ACTIVE' }
  });
  const payer = await prisma.payer.create({
    data: { name: `Payer ${suffix}`, payerCode: `C${suffix}`, payerType: 'COMMERCIAL', status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Plan ${suffix}`, status: 'ACTIVE' }
  });

  const closing = [
    EnrollmentStatus.DENIED,
    EnrollmentStatus.WITHDRAWN,
    EnrollmentStatus.TERMINATED,
    EnrollmentStatus.CLOSED,
    EnrollmentStatus.APPROVED,
    EnrollmentStatus.EFFECTIVE
  ];

  for (const toStatus of closing) {
    const enr = await prisma.enrollmentApplication.create({
      data: {
        applicationNo: `P5C-${toStatus}-${suffix}-${Math.random().toString(36).slice(2, 5)}`,
        tenantId: tenant.id,
        organizationId: org.id,
        payerPlanId: plan.id,
        status: EnrollmentStatus.PAYER_REVIEW,
        submittedAt: new Date(Date.now() - 10 * 86400000),
        nextFollowUpAt: new Date(Date.now() + 86400000),
        followUpStatus: 'ACTIVE'
      }
    });
    const manual = await prisma.task.create({
      data: {
        title: `Manual ${toStatus}`,
        status: TaskStatus.OPEN,
        tenantId: tenant.id,
        enrollmentId: enr.id,
        organizationId: org.id,
        source: 'MANUAL'
      }
    });
    const auto = await prisma.task.create({
      data: {
        title: `Auto FU ${toStatus}`,
        status: TaskStatus.OPEN,
        tenantId: tenant.id,
        enrollmentId: enr.id,
        organizationId: org.id,
        source: ENROLLMENT_FOLLOWUP_SOURCE,
        fingerprint: `enr-followup-auto:${enr.id}:test`
      }
    });

    // Direct cancel path (covers statuses that may need intermediate transitions in FSM)
    const result = await cancelFollowUpsOnClosingStatus({
      tenantId: tenant.id,
      enrollmentId: enr.id,
      actorId: manager.id,
      actorRole: Role.CREDENTIALING_MANAGER,
      toStatus,
      reason: `test ${toStatus}`
    });
    assert.equal(result.cancelled, 1);

    const autoAfter = await prisma.task.findUnique({ where: { id: auto.id } });
    const manualAfter = await prisma.task.findUnique({ where: { id: manual.id } });
    const enrAfter = await prisma.enrollmentApplication.findUnique({ where: { id: enr.id } });
    assert.equal(autoAfter!.status, TaskStatus.CANCELLED);
    assert.equal(manualAfter!.status, TaskStatus.OPEN);
    assert.equal(enrAfter!.followUpStatus, 'CANCELLED');
    assert.equal(enrAfter!.nextFollowUpAt, null);
  }

  // transitionEnrollment DENIED path
  const enr2 = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `P5C-TX-${suffix}`,
      tenantId: tenant.id,
      organizationId: org.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.PAYER_REVIEW,
      submittedAt: new Date(Date.now() - 5 * 86400000)
    }
  });
  await prisma.task.create({
    data: {
      title: 'TX follow-up',
      status: TaskStatus.OPEN,
      tenantId: tenant.id,
      enrollmentId: enr2.id,
      source: ENROLLMENT_FOLLOWUP_SOURCE,
      fingerprint: `enr-followup-auto:${enr2.id}:tx`
    }
  });
  const tx = await transitionEnrollment({
    tenantId: tenant.id,
    enrollmentId: enr2.id,
    toStatus: EnrollmentStatus.DENIED,
    actorId: manager.id,
    role: Role.CREDENTIALING_MANAGER,
    eventType: 'DENIED',
    reason: 'phase5c test'
  });
  assert.equal(tx.status, EnrollmentStatus.DENIED);
  assert.ok((tx.followUpCancellation?.cancelled ?? 0) >= 1);
});

suite('phase5c: portal SLA isolation + calendar + ops + HTTP', async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const hash = await bcrypt.hash('Phase5C-Portal!!', 4);
  const tenant = await prisma.tenant.create({
    data: { name: `P5C P ${suffix}`, slug: `p5c-p-${suffix}`, status: TenantStatus.ACTIVE }
  });
  const manager = await prisma.user.create({
    data: {
      email: `p5c.pm.${suffix}@test.local`,
      name: 'PM',
      role: Role.CREDENTIALING_MANAGER,
      passwordHash: hash
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `p5c.pc.${suffix}@test.local`,
      name: 'PC',
      role: Role.CLIENT_USER,
      passwordHash: hash
    }
  });
  await prisma.tenantMembership.create({
    data: { userId: manager.id, tenantId: tenant.id, role: TenantRole.TENANT_ADMIN, status: 'ACTIVE' }
  });
  await prisma.tenantMembership.create({
    data: { userId: client.id, tenantId: tenant.id, role: TenantRole.READ_ONLY, status: 'ACTIVE' }
  });
  const orgA = await prisma.organization.create({
    data: { tenantId: tenant.id, legalName: `OrgA ${suffix}`, status: 'ACTIVE' }
  });
  const orgB = await prisma.organization.create({
    data: { tenantId: tenant.id, legalName: `OrgB ${suffix}`, status: 'ACTIVE' }
  });
  await prisma.userOrganization.create({ data: { userId: client.id, organizationId: orgA.id } });

  const payer = await prisma.payer.create({
    data: { name: `Pay ${suffix}`, payerCode: `PC${suffix}`, payerType: 'COMMERCIAL', status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Pl ${suffix}`, status: 'ACTIVE' }
  });
  const enrA = await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `P5C-A-${suffix}`,
      tenantId: tenant.id,
      organizationId: orgA.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.SUBMITTED,
      submittedAt: new Date(Date.now() - 3 * 86400000),
      nextFollowUpAt: new Date(Date.now() + 2 * 86400000)
    }
  });
  await prisma.enrollmentApplication.create({
    data: {
      applicationNo: `P5C-B-${suffix}`,
      tenantId: tenant.id,
      organizationId: orgB.id,
      payerPlanId: plan.id,
      status: EnrollmentStatus.SUBMITTED,
      submittedAt: new Date()
    }
  });
  await prisma.workflowSlaRecord.create({
    data: {
      tenantId: tenant.id,
      organizationId: orgA.id,
      entityType: 'enrollment',
      entityId: enrA.id,
      slaStatus: 'WITHIN_SLA',
      expectedCompletionAt: new Date(Date.now() + 20 * 86400000)
    }
  });

  const summary = await getPortalWorkflowSummary({
    userId: client.id,
    role: Role.CLIENT_USER,
    tenantCtx: { tenantId: tenant.id, tenantRole: TenantRole.READ_ONLY } as any
  });
  assert.ok(summary.items.every((i) => i.organizationId === orgA.id));
  assert.ok(!summary.items.some((i) => i.organizationId === orgB.id));
  assert.ok(summary.counts.activeEnrollments >= 1);

  await assert.rejects(
    () => getPortalWorkflowSummary({
      userId: client.id,
      role: Role.CLIENT_USER,
      tenantCtx: { tenantId: tenant.id } as any,
      organizationId: orgB.id
    }),
    (e: any) => e.status === 403
  );

  const cal = await getCredentialExpirationCalendar({
    tenantId: tenant.id,
    view: 'upcoming',
    organizationIds: [orgA.id]
  });
  assert.ok(Array.isArray(cal.events));

  const ops = await getAutomationOpsVisibility({ tenantId: tenant.id });
  assert.ok(ops.scheduler);
  assert.ok(typeof ops.counts.failedJobRuns === 'number');

  // Preference-honoring delivery: disable email for FOLLOW_UP
  await upsertPreferences({
    userId: manager.id,
    actorId: manager.id,
    items: [{ category: 'FOLLOW_UP', channelInApp: true, channelEmail: false }]
  });
  await deliverAutomationNotification({
    tenantId: tenant.id,
    userId: manager.id,
    title: 'Follow-up due test',
    body: 'Test body',
    type: 'FOLLOW_UP_DUE',
    entityType: 'enrollment',
    entityId: enrA.id,
    href: `/enrollments?id=${enrA.id}`,
    dedupeKey: `p5c-pref-${suffix}`,
    organizationId: orgA.id
  });
  const emailDelivery = await prisma.notificationDelivery.findUnique({
    where: { dedupeKey: `p5c-pref-${suffix}:email` }
  });
  assert.equal(emailDelivery, null);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const auth = req.headers.authorization || '';
    if (auth.includes('mgr')) {
      req.user = { id: manager.id, role: Role.CREDENTIALING_MANAGER, email: manager.email };
      req.tenantContext = { tenantId: tenant.id };
    } else if (auth.includes('client')) {
      req.user = { id: client.id, role: Role.CLIENT_USER, email: client.email };
      req.tenantContext = { tenantId: tenant.id };
    }
    next();
  });
  app.use('/api/automation', automationRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/portal', portalRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  async function req(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token || 'mgr'}`
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* */ }
    return { status: res.status, data };
  }

  const calHttp = await req('/api/automation/calendar?view=upcoming', { token: 'mgr' });
  assert.equal(calHttp.status, 200);

  const clientCal = await req('/api/automation/calendar', { token: 'client' });
  assert.equal(clientCal.status, 403);

  const clientOps = await req('/api/automation/ops', { token: 'client' });
  assert.equal(clientOps.status, 403);

  const opsHttp = await req('/api/automation/ops', { token: 'mgr' });
  assert.equal(opsHttp.status, 200);

  const portal = await req('/api/portal/workflow-summary', { token: 'client' });
  assert.equal(portal.status, 200);
  assert.ok((portal.data.items || []).every((i: any) => i.organizationId === orgA.id));

  const prefsOther = await req('/api/notifications/preferences', {
    method: 'PUT',
    token: 'client',
    body: { items: [{ category: 'FOLLOW_UP', channelEmail: false }] }
  });
  assert.equal(prefsOther.status, 200);

  server.close();
});
