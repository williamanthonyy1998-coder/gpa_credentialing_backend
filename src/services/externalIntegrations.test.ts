import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  ExternalIntegrationStatus,
  ExternalIntegrationType,
  ExternalOperationStatus,
  ProviderIntegrationAuthStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  configureIntegrationCredentials,
  createTenantIntegration,
  ensurePlatformIntegrationCatalog,
  getIntegration,
  grantProviderAuthorization,
  listIntegrations,
  recordManualIntegrationAction,
  revokeProviderAuthorization,
  runUnsupportedExternalOperation,
  testIntegrationConnection
} from './externalIntegrations';
import { generateApplicationNo } from './enrollments';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Int Tenant ${suffix}`, slug: `int-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Int TenantB ${suffix}`, slug: `int-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const admin = await prisma.user.create({
    data: {
      email: `int.admin.${suffix}@test.local`,
      name: 'Int Admin',
      role: Role.ADMIN,
      passwordHash: 'x'
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `int.client.${suffix}@test.local`,
      name: 'Int Client',
      role: Role.CLIENT_USER,
      passwordHash: 'x'
    }
  });
  const providerUser = await prisma.user.create({
    data: {
      email: `int.ext.${suffix}@test.local`,
      name: 'Int Ext',
      role: Role.EXTERNAL_PROVIDER,
      passwordHash: 'x'
    }
  });
  const org = await prisma.organization.create({
    data: { legalName: `Org ${suffix}`, tenantId: tenant.id, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: {
      firstName: 'Int',
      lastName: `Prov${suffix}`,
      npi: `7${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`,
      status: 'ACTIVE'
    }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const payer = await prisma.payer.create({
    data: { name: `Int Payer ${suffix}`, payerCode: `I${suffix}`, status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Int Plan ${suffix}`, status: 'ACTIVE' }
  });
  const applicationNo = await generateApplicationNo(prisma);
  const enrollment = await prisma.enrollmentApplication.create({
    data: {
      tenantId: tenant.id,
      applicationNo,
      subject: `Int Enr ${suffix}`,
      providerId: provider.id,
      organizationId: org.id,
      payerPlanId: plan.id,
      enrollmentType: 'INDIVIDUAL',
      status: 'READY_TO_SUBMIT'
    }
  });
  return { suffix, tenant, tenantB, admin, client, providerUser, org, provider, enrollment, payer, plan };
}

test('platform catalog seeds; secrets never in responses; CONNECTED not faked', async () => {
  const s = await seed();
  await ensurePlatformIntegrationCatalog();
  const items = await listIntegrations({
    tenantId: s.tenant.id,
    role: Role.ADMIN,
    audience: 'gpa'
  });
  assert.ok(items.some((i) => i.integrationType === 'CAQH'));
  assert.ok(items.some((i) => i.integrationType === 'PECOS' && i.status === 'MANUAL_ONLY'));
  for (const i of items) {
    assert.equal((i as any).credentialSecretRef, undefined);
    assert.ok(!JSON.stringify(i).toLowerCase().includes('password'));
  }

  const tenantCaqh = await createTenantIntegration({
    tenantId: s.tenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    integrationType: ExternalIntegrationType.CAQH,
    displayName: 'Tenant CAQH',
    systemName: `CAQH-${s.suffix}`,
    cloneFromPlatformId: items.find((i) => i.integrationType === 'CAQH' && !i.tenantId)?.id
  });
  assert.notEqual(tenantCaqh.status, ExternalIntegrationStatus.CONNECTED);

  await assert.rejects(
    () => createTenantIntegration({
      tenantId: s.tenant.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      integrationType: ExternalIntegrationType.CAQH,
      displayName: 'Bad',
      systemName: 'bad',
      status: ExternalIntegrationStatus.CONNECTED
    }),
    /CONNECTED|connection test/i
  );

  await assert.rejects(
    () => configureIntegrationCredentials({
      tenantId: s.tenant.id,
      integrationId: tenantCaqh.id,
      actorId: s.client.id,
      role: Role.CLIENT_USER,
      envVarName: 'CAQH_TEST_SECRET'
    }),
    /permission/i
  );

  await assert.rejects(
    () => configureIntegrationCredentials({
      tenantId: s.tenant.id,
      integrationId: tenantCaqh.id,
      actorId: s.providerUser.id,
      role: Role.EXTERNAL_PROVIDER,
      envVarName: 'CAQH_TEST_SECRET'
    }),
    /permission/i
  );

  const configured = await configureIntegrationCredentials({
    tenantId: s.tenant.id,
    integrationId: tenantCaqh.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    envVarName: `CAQH_SECRET_${s.suffix.replace(/-/g, '_').toUpperCase()}`,
    localSecretValue: 'not-a-real-caqh-password'
  });
  assert.equal(configured.credentialConfigured, true);
  assert.equal((configured as any).credentialSecretRef, undefined);
  assert.ok(!JSON.stringify(configured).includes('not-a-real-caqh-password'));

  const tested = await testIntegrationConnection({
    tenantId: s.tenant.id,
    integrationId: tenantCaqh.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  // Without authorized live CAQH access, must NOT become CONNECTED
  assert.equal(tested.ok, false);
  assert.notEqual(tested.integration.status, ExternalIntegrationStatus.CONNECTED);

  const pecosPlatform = items.find((i) => i.integrationType === 'PECOS');
  assert.ok(pecosPlatform);
  const pecosTenant = await createTenantIntegration({
    tenantId: s.tenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    integrationType: ExternalIntegrationType.PECOS,
    displayName: 'Tenant PECOS',
    systemName: `PECOS-${s.suffix}`,
    cloneFromPlatformId: pecosPlatform!.id
  });
  const pecosTest = await testIntegrationConnection({
    tenantId: s.tenant.id,
    integrationId: pecosTenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  assert.equal(pecosTest.integration.status, ExternalIntegrationStatus.MANUAL_ONLY);
  assert.notEqual(pecosTest.integration.status, ExternalIntegrationStatus.CONNECTED);
});

test('authorization revoke/expire blocks ops; cross-tenant deny; manual action does not submit', async () => {
  const s = await seed();
  await ensurePlatformIntegrationCatalog();
  const platform = (await listIntegrations({
    tenantId: s.tenant.id,
    role: Role.ADMIN,
    audience: 'gpa'
  })).find((i) => i.integrationType === 'PAYER_PORTAL');
  assert.ok(platform);

  const integration = await createTenantIntegration({
    tenantId: s.tenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    integrationType: ExternalIntegrationType.PAYER_PORTAL,
    displayName: 'Manual payer',
    systemName: `PORTAL-${s.suffix}`,
    cloneFromPlatformId: platform!.id
  });

  const quarantined = await prisma.document.create({
    data: {
      title: 'Bad auth evidence',
      type: 'OTHER',
      tenantId: s.tenant.id,
      providerId: s.provider.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      status: 'RECEIVED'
    }
  });
  await assert.rejects(
    () => grantProviderAuthorization({
      tenantId: s.tenant.id,
      providerId: s.provider.id,
      integrationId: integration.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      evidenceDocumentId: quarantined.id
    }),
    /trust|quarantine|AVAILABLE/i
  );

  const auth = await grantProviderAuthorization({
    tenantId: s.tenant.id,
    providerId: s.provider.id,
    integrationId: integration.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    notes: 'Signed delegation on file'
  });
  assert.equal(auth.status, ProviderIntegrationAuthStatus.GRANTED);

  const before = await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } });
  const manual = await recordManualIntegrationAction({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    integrationId: integration.id,
    actionType: 'PORTAL_STATUS_CHECK',
    summary: 'Checked payer portal status manually',
    externalReference: 'REF-123',
    idempotencyKey: `manual-${s.suffix}-1`
  });
  assert.equal(manual.enrollmentStatus, before!.status);
  assert.equal(manual.operation.operationStatus, ExternalOperationStatus.REQUIRES_MANUAL_ACTION);
  assert.ok(!JSON.stringify(manual).toLowerCase().includes('"connected":true'));

  const replay = await recordManualIntegrationAction({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    integrationId: integration.id,
    actionType: 'PORTAL_STATUS_CHECK',
    summary: 'Checked again',
    idempotencyKey: `manual-${s.suffix}-1`
  });
  assert.equal(replay.operation.id, manual.operation.id);

  await revokeProviderAuthorization({
    tenantId: s.tenant.id,
    providerId: s.provider.id,
    authorizationId: auth.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    reason: 'Provider withdrew consent'
  });

  await assert.rejects(
    () => recordManualIntegrationAction({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      integrationId: integration.id,
      actionType: 'PORTAL_STATUS_CHECK',
      summary: 'Should fail after revoke'
    }),
    /revoked|AUTH_/i
  );

  // Expired authorization
  const auth2 = await grantProviderAuthorization({
    tenantId: s.tenant.id,
    providerId: s.provider.id,
    integrationId: integration.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    expiresAt: new Date(Date.now() - 60_000)
  });
  assert.equal(auth2.status, ProviderIntegrationAuthStatus.GRANTED);
  await assert.rejects(
    () => recordManualIntegrationAction({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      integrationId: integration.id,
      actionType: 'X',
      summary: 'expired'
    }),
    /expired|AUTH_/i
  );

  // Cross-tenant
  await assert.rejects(
    () => getIntegration({
      tenantId: s.tenantB.id,
      integrationId: integration.id,
      role: Role.ADMIN,
      audience: 'gpa'
    }),
    /not found/i
  );

  await assert.rejects(
    () => grantProviderAuthorization({
      tenantId: s.tenantB.id,
      providerId: s.provider.id,
      integrationId: integration.id,
      actorId: s.admin.id,
      role: Role.ADMIN
    }),
    /not found|tenant|provider/i
  );

  // Unsupported op does not change enrollment
  await grantProviderAuthorization({
    tenantId: s.tenant.id,
    providerId: s.provider.id,
    integrationId: integration.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    expiresAt: new Date(Date.now() + 86400000)
  });
  const statusBefore = (await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } }))!.status;
  const op = await runUnsupportedExternalOperation({
    tenantId: s.tenant.id,
    integrationId: integration.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    providerId: s.provider.id,
    enrollmentId: s.enrollment.id,
    operationType: 'SUBMIT_APPLICATION',
    idempotencyKey: `op-${s.suffix}`
  });
  assert.ok(
    op.operationStatus === ExternalOperationStatus.NOT_SUPPORTED
    || op.operationStatus === ExternalOperationStatus.REQUIRES_MANUAL_ACTION
  );
  const statusAfter = (await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } }))!.status;
  assert.equal(statusAfter, statusBefore);

  const dup = await runUnsupportedExternalOperation({
    tenantId: s.tenant.id,
    integrationId: integration.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    providerId: s.provider.id,
    enrollmentId: s.enrollment.id,
    operationType: 'SUBMIT_APPLICATION',
    idempotencyKey: `op-${s.suffix}`
  });
  assert.equal(dup.id, op.id);

  // Client sanitized list — no secret refs / feasibility internals optional
  const clientView = await listIntegrations({
    tenantId: s.tenant.id,
    role: Role.CLIENT_USER,
    audience: 'client'
  });
  for (const i of clientView) {
    assert.equal((i as any).credentialSecretRef, undefined);
    assert.equal(i.feasibilityNotes, null);
  }
});
