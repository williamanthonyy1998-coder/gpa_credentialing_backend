import test from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertNoDuplicateActiveEnrollment,
  computeEnrollmentAttention,
  createEnrollmentFollowUp,
  markReadyForSubmission,
  recordAcknowledgment,
  recordApproval,
  recordEffective,
  recordRejection,
  recordSubmission,
  startPreparation,
  validateEnrollmentRelationships
} from './enrollmentLifecycle';
import { assertEnrollmentTransition } from './workflow';
import { generateApplicationNo } from './enrollments';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Enr Tenant ${suffix}`, slug: `enr-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Enr TenantB ${suffix}`, slug: `enr-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const org = await prisma.organization.create({
    data: { legalName: `Org ${suffix}`, tenantId: tenant.id, status: 'ACTIVE' }
  });
  const orgB = await prisma.organization.create({
    data: { legalName: `OrgB ${suffix}`, tenantId: tenantB.id, status: 'ACTIVE' }
  });
  const practice = await prisma.practice.create({
    data: { name: `Prac ${suffix}`, organizationId: org.id }
  });
  const facility = await prisma.facility.create({
    data: { name: `Fac ${suffix}`, organizationId: org.id, practiceId: practice.id, status: 'ACTIVE' }
  });
  const facilityB = await prisma.facility.create({
    data: { name: `FacB ${suffix}`, organizationId: orgB.id, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: { firstName: 'Enr', lastName: `Prov${suffix}`, status: 'ACTIVE' }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  await prisma.providerFacility.create({ data: { providerId: provider.id, facilityId: facility.id } });
  const payer = await prisma.payer.create({
    data: { name: `Payer ${suffix}`, payerCode: `P-${suffix}`, status: 'ACTIVE' }
  });
  const inactivePayer = await prisma.payer.create({
    data: { name: `Inactive Payer ${suffix}`, payerCode: `PI-${suffix}`, status: 'INACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Plan ${suffix}`, status: 'ACTIVE' }
  });
  const otherPlan = await prisma.payerPlan.create({
    data: { payerId: inactivePayer.id, name: `Other Plan ${suffix}`, status: 'ACTIVE' }
  });
  const inactivePlan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Inactive Plan ${suffix}`, status: 'INACTIVE' }
  });
  const billing = await prisma.billingEntity.create({
    data: { tenantId: tenant.id, organizationId: org.id, legalName: `Bill ${suffix}`, status: 'ACTIVE' }
  });
  const billingB = await prisma.billingEntity.create({
    data: { tenantId: tenantB.id, organizationId: orgB.id, legalName: `BillB ${suffix}`, status: 'ACTIVE' }
  });
  const admin = await prisma.user.create({
    data: {
      email: `enr.admin.${suffix}@test.local`,
      name: 'Enr Admin',
      role: Role.ADMIN,
      passwordHash: 'x',
      active: true
    }
  });
  const specialist = await prisma.user.create({
    data: {
      email: `enr.spec.${suffix}@test.local`,
      name: 'Enr Spec',
      role: Role.ENROLLMENT_SPECIALIST,
      passwordHash: 'x',
      active: true
    }
  });
  return {
    suffix, tenant, tenantB, org, orgB, practice, facility, facilityB, provider,
    payer, plan, otherPlan, inactivePlan, inactivePayer, billing, billingB, admin, specialist
  };
}

async function createDraft(ctx: Awaited<ReturnType<typeof seed>>) {
  const applicationNo = await generateApplicationNo();
  return prisma.enrollmentApplication.create({
    data: {
      applicationNo,
      tenantId: ctx.tenant.id,
      providerId: ctx.provider.id,
      organizationId: ctx.org.id,
      practiceId: ctx.practice.id,
      facilityId: ctx.facility.id,
      billingEntityId: ctx.billing.id,
      payerPlanId: ctx.plan.id,
      enrollmentType: 'INDIVIDUAL',
      status: EnrollmentStatus.NOT_STARTED
    }
  });
}

test('attention: future effective is not currently effective; overdue follow-up', () => {
  const future = new Date(Date.now() + 10 * 86400000);
  assert.equal(computeEnrollmentAttention({
    status: EnrollmentStatus.EFFECTIVE,
    effectiveAt: future,
    facilityId: 'f',
    payerPlanId: 'p'
  }), 'APPROVED_NOT_EFFECTIVE');
  assert.equal(computeEnrollmentAttention({
    status: EnrollmentStatus.APPROVED,
    effectiveAt: null,
    facilityId: 'f',
    payerPlanId: 'p'
  }), 'APPROVED_NOT_EFFECTIVE');
  assert.equal(computeEnrollmentAttention({
    status: EnrollmentStatus.SUBMITTED,
    nextFollowUpAt: new Date(Date.now() - 86400000),
    facilityId: 'f',
    payerPlanId: 'p'
  }), 'OVERDUE_FOLLOW_UP');
  assert.equal(computeEnrollmentAttention({
    status: EnrollmentStatus.DENIED,
    facilityId: 'f',
    payerPlanId: 'p'
  }), 'REJECTED');
});

test('lifecycle happy path with history; invalid jumps rejected; specialist cannot approve', async () => {
  const ctx = await seed();
  const draft = await createDraft(ctx);

  assert.throws(
    () => assertEnrollmentTransition(EnrollmentStatus.NOT_STARTED, EnrollmentStatus.APPROVED, Role.ADMIN),
    /not allowed/i
  );

  let row = await startPreparation(ctx.tenant.id, draft.id, ctx.admin.id, Role.ADMIN);
  assert.equal(row.status, EnrollmentStatus.PREPARING);
  row = await markReadyForSubmission(ctx.tenant.id, draft.id, ctx.admin.id, Role.ADMIN);
  assert.equal(row.status, EnrollmentStatus.READY_TO_SUBMIT);

  row = await recordSubmission({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.specialist.id,
    role: Role.ENROLLMENT_SPECIALIST,
    referenceNo: 'REF-1',
    notes: 'Packet mailed'
  });
  assert.equal(row.status, EnrollmentStatus.SUBMITTED);
  assert.ok(row.submittedAt);

  row = await recordAcknowledgment({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.admin.id,
    role: Role.ADMIN,
    referenceNo: 'ACK-1'
  });
  assert.equal(row.status, EnrollmentStatus.ACKNOWLEDGED);

  await assert.rejects(
    () => recordApproval({
      tenantId: ctx.tenant.id,
      enrollmentId: draft.id,
      actorId: ctx.specialist.id,
      role: Role.ENROLLMENT_SPECIALIST,
      notes: 'Nope'
    }),
    (e: any) => e.status === 403
  );

  row = await recordApproval({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.admin.id,
    role: Role.ADMIN,
    notes: 'Approved by payer letter',
    payerEnrollmentId: 'PAY-99'
  });
  assert.equal(row.status, EnrollmentStatus.APPROVED);

  const future = new Date(Date.now() + 30 * 86400000);
  row = await recordEffective({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.admin.id,
    role: Role.ADMIN,
    effectiveAt: future
  });
  assert.equal(row.status, EnrollmentStatus.EFFECTIVE);
  assert.equal(computeEnrollmentAttention(row), 'APPROVED_NOT_EFFECTIVE');

  const history = await prisma.statusHistory.findMany({
    where: { enrollmentId: draft.id },
    orderBy: { createdAt: 'asc' }
  });
  assert.ok(history.length >= 4);
  assert.ok(history.some((h) => h.eventType === 'APPLICATION_SUBMITTED'));

  await assert.rejects(
    () => recordRejection({
      tenantId: ctx.tenant.id,
      enrollmentId: draft.id,
      actorId: ctx.admin.id,
      role: Role.ADMIN,
      reason: ''
    }),
    /reason/i
  );
});

test('validation rejects inactive plan, wrong payer plan, cross-tenant org/facility/billing, duplicates', async () => {
  const ctx = await seed();

  await assert.rejects(
    () => validateEnrollmentRelationships({
      tenantId: ctx.tenant.id,
      payerPlanId: ctx.inactivePlan.id,
      facilityId: ctx.facility.id
    }),
    /inactive/i
  );

  await assert.rejects(
    () => validateEnrollmentRelationships({
      tenantId: ctx.tenant.id,
      payerPlanId: ctx.plan.id,
      payerId: ctx.inactivePayer.id,
      facilityId: ctx.facility.id
    }),
    /does not belong/i
  );

  await assert.rejects(
    () => validateEnrollmentRelationships({
      tenantId: ctx.tenant.id,
      payerPlanId: ctx.plan.id,
      organizationId: ctx.orgB.id
    }),
    (e: any) => e.status === 404
  );

  await assert.rejects(
    () => validateEnrollmentRelationships({
      tenantId: ctx.tenant.id,
      payerPlanId: ctx.plan.id,
      facilityId: ctx.facilityB.id
    }),
    (e: any) => e.status === 404
  );

  await assert.rejects(
    () => validateEnrollmentRelationships({
      tenantId: ctx.tenant.id,
      payerPlanId: ctx.plan.id,
      billingEntityId: ctx.billingB.id
    }),
    (e: any) => e.status === 404
  );

  const first = await createDraft(ctx);
  await assert.rejects(
    () => assertNoDuplicateActiveEnrollment({
      tenantId: ctx.tenant.id,
      providerId: ctx.provider.id,
      payerPlanId: ctx.plan.id,
      facilityId: ctx.facility.id
    }),
    (e: any) => e.code === 'DUPLICATE_ENROLLMENT'
  );
  void first;
});

test('follow-up task links to enrollment and dedupes; client cannot mark effective', async () => {
  const ctx = await seed();
  const draft = await createDraft(ctx);
  await startPreparation(ctx.tenant.id, draft.id, ctx.admin.id, Role.ADMIN);

  const due = new Date(Date.now() + 3 * 86400000);
  const t1 = await createEnrollmentFollowUp({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.admin.id,
    role: Role.ADMIN,
    dueAt: due,
    reason: 'Call payer portal'
  });
  const t2 = await createEnrollmentFollowUp({
    tenantId: ctx.tenant.id,
    enrollmentId: draft.id,
    actorId: ctx.admin.id,
    role: Role.ADMIN,
    dueAt: due,
    reason: 'Call payer portal'
  });
  assert.equal(t1.id, t2.id);
  assert.equal(t1.enrollmentId, draft.id);
  assert.equal(t1.source, 'ENROLLMENT_FOLLOWUP');

  await assert.rejects(
    () => recordEffective({
      tenantId: ctx.tenant.id,
      enrollmentId: draft.id,
      actorId: ctx.admin.id,
      role: Role.CLIENT_USER,
      effectiveAt: new Date()
    }),
    (e: any) => e.status === 403
  );

  await assert.rejects(
    () => recordEffective({
      tenantId: ctx.tenant.id,
      enrollmentId: draft.id,
      actorId: ctx.admin.id,
      role: Role.EXTERNAL_PROVIDER,
      effectiveAt: new Date()
    }),
    (e: any) => e.status === 403
  );
});
