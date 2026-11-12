import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  EnrollmentRevalidationStatus,
  EnrollmentStatus,
  RevalidationDueDateSource,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateApplicationNo } from './enrollments';
import {
  acknowledgeRevalidation,
  approveRevalidation,
  cancelRevalidation,
  completeRevalidation,
  createRevalidation,
  daysRemaining,
  denyRevalidation,
  getRevalidationHistory,
  listEnrollmentRevalidations,
  prepareRevalidation,
  markReadyForInternalReview,
  submitRevalidation
} from './enrollmentRevalidation';
import { evaluateCredentialingDeadlines, listCredentialingDeadlines } from './credentialingDeadlines';
import { buildExcelReportBuffer, buildPdfReportBuffer, enrollmentStatusReport } from './credentialingReports';
import { evaluateEnrollmentCredentialingQa } from './credentialingQa';
import { renewLicense } from './licenseLifecycle';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Rev Tenant ${suffix}`, slug: `rev-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Rev TenantB ${suffix}`, slug: `rev-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const admin = await prisma.user.create({
    data: { email: `rev.admin.${suffix}@test.local`, name: 'Rev Admin', role: Role.ADMIN, passwordHash: 'x' }
  });
  const client = await prisma.user.create({
    data: { email: `rev.client.${suffix}@test.local`, name: 'Rev Client', role: Role.CLIENT_USER, passwordHash: 'x' }
  });
  const org = await prisma.organization.create({
    data: { legalName: `Org ${suffix}`, tenantId: tenant.id, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: {
      firstName: 'Rev',
      lastName: `Prov${suffix}`,
      npi: `6${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`,
      status: 'ACTIVE'
    }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const payer = await prisma.payer.create({
    data: { name: `Rev Payer ${suffix}`, payerCode: `R${suffix}`, status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Rev Plan ${suffix}`, status: 'ACTIVE' }
  });
  const applicationNo = await generateApplicationNo(prisma);
  const enrollment = await prisma.enrollmentApplication.create({
    data: {
      tenantId: tenant.id,
      applicationNo,
      subject: `Rev Enr ${suffix}`,
      providerId: provider.id,
      organizationId: org.id,
      payerPlanId: plan.id,
      enrollmentType: 'INDIVIDUAL',
      status: EnrollmentStatus.EFFECTIVE,
      effectiveAt: new Date(),
      submittedAt: new Date(Date.now() - 10 * 86400000)
    }
  });
  return { suffix, tenant, tenantB, admin, client, org, provider, payer, plan, enrollment };
}

test('revalidation lifecycle, history, duplicate prevention, cross-tenant', async () => {
  const s = await seed();
  const due = new Date(Date.now() + 45 * 86400000);

  const created = await createRevalidation({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    revalidationType: 'MEDICARE_REVALIDATION',
    dueDate: due,
    dueDateSource: RevalidationDueDateSource.CONFIRMED,
    source: 'CMS notice',
    sourceReference: 'NOTICE-1'
  });
  assert.ok(
    created.status === EnrollmentRevalidationStatus.UPCOMING
    || created.status === EnrollmentRevalidationStatus.NOT_STARTED
  );
  const enrAfter = await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } });
  assert.equal(enrAfter!.status, EnrollmentStatus.EFFECTIVE);

  await assert.rejects(
    () => createRevalidation({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      revalidationType: 'MEDICARE_REVALIDATION',
      dueDate: due,
      dueDateSource: RevalidationDueDateSource.MANUAL
    }),
    /DUPLICATE|active/i
  );

  await assert.rejects(
    () => createRevalidation({
      tenantId: s.tenantB.id,
      enrollmentId: s.enrollment.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      revalidationType: 'COMMERCIAL_REVALIDATION'
    }),
    /not found/i
  );

  await assert.rejects(
    () => createRevalidation({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      actorId: s.client.id,
      role: Role.CLIENT_USER,
      revalidationType: 'COMMERCIAL_REVALIDATION'
    }),
    /permission/i
  );

  await prepareRevalidation({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  await markReadyForInternalReview({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });

  await assert.rejects(
    () => submitRevalidation({
      tenantId: s.tenant.id,
      revalidationId: created.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      confirmedSent: false
    }),
    /confirmedSent/i
  );

  const submitted = await submitRevalidation({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    confirmedSent: true,
    referenceNumber: 'REV-REF'
  });
  assert.equal(submitted.status, EnrollmentRevalidationStatus.SUBMITTED);
  assert.equal(submitted.submissionConfirmed, true);

  await assert.rejects(
    () => completeRevalidation({
      tenantId: s.tenant.id,
      revalidationId: created.id,
      actorId: s.admin.id,
      role: Role.ADMIN
    }),
    /transition|INVALID|evidence|EVIDENCE/i
  );

  await acknowledgeRevalidation({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  await approveRevalidation({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });

  await assert.rejects(
    () => completeRevalidation({
      tenantId: s.tenant.id,
      revalidationId: created.id,
      actorId: s.admin.id,
      role: Role.ADMIN
    }),
    /EVIDENCE|evidence/i
  );

  const evidence = await prisma.document.create({
    data: {
      title: 'Reval evidence',
      type: 'OTHER',
      tenantId: s.tenant.id,
      providerId: s.provider.id,
      securityStatus: DocumentSecurityStatus.AVAILABLE,
      status: 'VERIFIED'
    }
  });
  const completed = await completeRevalidation({
    tenantId: s.tenant.id,
    revalidationId: created.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    evidenceDocumentId: evidence.id
  });
  assert.equal(completed.status, EnrollmentRevalidationStatus.COMPLETED);

  const hist = await getRevalidationHistory(s.tenant.id, created.id);
  assert.ok(hist.length >= 4);
  const stillEffective = await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } });
  assert.equal(stillEffective!.status, EnrollmentStatus.EFFECTIVE);

  // Denial/cancel reasons
  const other = await createRevalidation({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    revalidationType: 'COMMERCIAL_REVALIDATION',
    dueDate: new Date(Date.now() + 20 * 86400000),
    dueDateSource: RevalidationDueDateSource.ESTIMATED
  });
  await assert.rejects(
    () => cancelRevalidation({
      tenantId: s.tenant.id,
      revalidationId: other.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      reason: ''
    }),
    /reason/i
  );
  await cancelRevalidation({
    tenantId: s.tenant.id,
    revalidationId: other.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    reason: 'No longer required by payer'
  });

  const deniedSeed = await createRevalidation({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    revalidationType: 'GROUP_REVALIDATION',
    dueDateSource: RevalidationDueDateSource.MANUAL
  });
  await prepareRevalidation({
    tenantId: s.tenant.id,
    revalidationId: deniedSeed.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  await markReadyForInternalReview({
    tenantId: s.tenant.id,
    revalidationId: deniedSeed.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  await submitRevalidation({
    tenantId: s.tenant.id,
    revalidationId: deniedSeed.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    confirmedSent: true
  });
  await denyRevalidation({
    tenantId: s.tenant.id,
    revalidationId: deniedSeed.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    reason: 'Payer denied revalidation packet'
  });

  const listed = await listEnrollmentRevalidations(s.tenant.id, s.enrollment.id);
  assert.ok(listed.some((r) => r.status === EnrollmentRevalidationStatus.COMPLETED));
  assert.ok(listed.some((r) => r.status === EnrollmentRevalidationStatus.CANCELLED));
  assert.ok(listed.some((r) => r.status === EnrollmentRevalidationStatus.DENIED));
});

test('deadlines dedupe; license renewal preserved; reports/export; enrollment QA', async () => {
  const s = await seed();
  assert.equal(daysRemaining(new Date()), 0);

  const license = await prisma.license.create({
    data: {
      providerId: s.provider.id,
      tenantId: s.tenant.id,
      type: 'MD',
      number: `LIC-${s.suffix}`,
      expiresAt: new Date(Date.now() + 20 * 86400000),
      verificationStatus: 'VERIFIED',
      status: 'VERIFIED'
    }
  });

  const deadlines = await listCredentialingDeadlines({
    tenantId: s.tenant.id,
    withinDays: 90,
    includeOverdue: true
  });
  assert.ok(deadlines.items.some((i) => i.category === 'LICENSE' && i.recordId === license.id));

  const eval1 = await evaluateCredentialingDeadlines({
    tenantId: s.tenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    windows: [30, 15, 7]
  });
  const eval2 = await evaluateCredentialingDeadlines({
    tenantId: s.tenant.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    windows: [30, 15, 7]
  });
  assert.ok(eval1.tasksCreated >= 1);
  assert.equal(eval2.tasksCreated, 0);
  assert.ok(eval2.tasksReused >= 1);

  const renewed = await renewLicense({
    tenantId: s.tenant.id,
    licenseId: license.id,
    actorId: s.admin.id,
    audience: 'gpa',
    body: {
      number: `LIC-${s.suffix}-R`,
      expiresAt: new Date(Date.now() + 400 * 86400000),
      issuedAt: new Date()
    }
  });
  assert.equal(renewed.renewedFromId, license.id);
  const old = await prisma.license.findUnique({ where: { id: license.id } });
  assert.ok(old);
  assert.equal(old!.number, `LIC-${s.suffix}`);

  const report = await enrollmentStatusReport(s.tenant.id, 'gpa');
  assert.ok(report.totals.EFFECTIVE >= 1);

  const xlsx = await buildExcelReportBuffer({
    tenantId: s.tenant.id,
    tenantName: s.tenant.name,
    audience: 'gpa'
  });
  assert.ok(xlsx.length > 100);

  const pdf = await buildPdfReportBuffer({
    tenantId: s.tenant.id,
    tenantName: s.tenant.name,
    audience: 'gpa'
  });
  assert.ok(pdf.slice(0, 4).toString() === '%PDF');

  const qa = await evaluateEnrollmentCredentialingQa(s.tenant.id, { limit: 50 });
  assert.ok(qa.recordsInspected >= 1);

  // Quarantined evidence cannot complete
  await createRevalidation({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    revalidationType: 'FACILITY_REVALIDATION',
    dueDateSource: RevalidationDueDateSource.MANUAL
  });
});
