import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoryVerificationStatus,
  ProfessionalHistorySection,
  Role,
  DocumentSecurityStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertDateRange,
  canVerifyHistory,
  createBoardCertification,
  createEducation,
  createEmployment,
  createMalpractice,
  createResidency,
  getHistorySummary,
  linkHistoryDocument,
  listHistorySection,
  rejectHistoryRecord,
  sanitizeHistoryRecord,
  verifyHistoryRecord
} from './professionalHistory';
import { convertIntakeProfessionalHistory } from './professionalHistoryConvert';

async function seedTenantProvider() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `PH Tenant ${suffix}`, slug: `ph-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: { firstName: 'Pat', lastName: `History${suffix}`, npi: null, status: 'ACTIVE' }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  const admin = await prisma.user.create({
    data: {
      email: `ph.admin.${suffix}@test.local`,
      name: 'PH Admin',
      role: Role.ADMIN,
      passwordHash: 'x',
      active: true
    }
  });
  return { tenant, provider, admin, suffix };
}

test('date range validation rejects end before start', () => {
  const start = new Date('2020-01-01');
  const end = new Date('2019-01-01');
  assert.throws(() => assertDateRange(start, end, 'Education'));
});

test('only authorized roles can verify history', () => {
  assert.equal(canVerifyHistory(Role.ADMIN), true);
  assert.equal(canVerifyHistory(Role.CREDENTIALING_MANAGER), true);
  assert.equal(canVerifyHistory(Role.APPROVER), true);
  assert.equal(canVerifyHistory(Role.CREDENTIALING_SPECIALIST), false);
  assert.equal(canVerifyHistory(Role.EXTERNAL_PROVIDER), false);
  assert.equal(canVerifyHistory(Role.CLIENT_USER), false);
});

test('education / residency / board / employment / malpractice CRUD + verification + isolation', async () => {
  const a = await seedTenantProvider();
  const b = await seedTenantProvider();

  const edu = await createEducation(a.tenant.id, a.provider.id, {
    institutionName: 'University of Test',
    degreeName: 'MD',
    fieldOfStudy: 'Medicine',
    startDate: '2010-09-01',
    graduationDate: '2014-06-01',
    country: 'Canada'
  }, a.admin.id);
  assert.equal(edu.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);

  await assert.rejects(
    () => createEducation(a.tenant.id, a.provider.id, {
      institutionName: 'University of Test',
      degreeName: 'MD',
      graduationDate: '2014-06-01'
    }, a.admin.id),
    (e: any) => e.code === 'DUPLICATE_HISTORY'
  );

  await assert.rejects(
    () => createEducation(a.tenant.id, a.provider.id, {
      institutionName: 'Bad Dates U',
      startDate: '2015-01-01',
      endDate: '2014-01-01'
    }, a.admin.id)
  );

  const residency = await createResidency(a.tenant.id, a.provider.id, {
    institutionName: 'General Hospital',
    programName: 'Internal Medicine',
    specialtyName: 'Internal Medicine',
    startDate: '2014-07-01',
    endDate: '2017-06-30'
  }, a.admin.id);
  assert.ok(residency.id);

  const board = await createBoardCertification(a.tenant.id, a.provider.id, {
    certifyingBoard: 'ABIM',
    specialtyName: 'Internal Medicine',
    doesNotExpire: true,
    issueDate: '2018-01-01'
  }, a.admin.id);

  const emp = await createEmployment(a.tenant.id, a.provider.id, {
    employerName: 'Clinic A',
    positionTitle: 'Physician',
    isCurrent: true,
    startDate: '2018-02-01',
    reasonForLeaving: 'SENSITIVE_REASON'
  }, a.admin.id);

  const mal = await createMalpractice(a.tenant.id, a.provider.id, {
    insuranceCarrier: 'CoverCo',
    policyNumber: 'POL-999999',
    perOccurrenceAmount: 1000000,
    aggregateAmount: 3000000,
    effectiveDate: '2024-01-01',
    expirationDate: '2025-01-01',
    isCurrent: true
  }, a.admin.id);

  const sanitizedClient = sanitizeHistoryRecord(
    ProfessionalHistorySection.EMPLOYMENT,
    emp,
    'client'
  );
  assert.equal(sanitizedClient.reasonForLeaving, undefined);

  const sanitizedMal = sanitizeHistoryRecord(
    ProfessionalHistorySection.MALPRACTICE,
    mal,
    'provider'
  );
  assert.equal(sanitizedMal.policyNumberMasked, true);
  assert.ok(String(sanitizedMal.policyNumber).includes('*'));

  // Tenant isolation: Tenant B cannot list Tenant A history via assertProviderInTenant
  await assert.rejects(
    () => listHistorySection(b.tenant.id, a.provider.id, ProfessionalHistorySection.EDUCATION, 'gpa')
  );

  const verified = await verifyHistoryRecord(
    ProfessionalHistorySection.EDUCATION,
    a.tenant.id,
    a.provider.id,
    edu.id,
    a.admin.id,
    {}
  );
  assert.equal(verified.verificationStatus, HistoryVerificationStatus.VERIFIED);

  await rejectHistoryRecord(
    ProfessionalHistorySection.BOARD_CERTIFICATION,
    a.tenant.id,
    a.provider.id,
    board.id,
    a.admin.id,
    'Incomplete board letter',
    {}
  );

  await assert.rejects(
    () => rejectHistoryRecord(
      ProfessionalHistorySection.BOARD_CERTIFICATION,
      a.tenant.id,
      a.provider.id,
      board.id,
      a.admin.id,
      '',
      {}
    )
  );

  const summary = await getHistorySummary(a.tenant.id, a.provider.id);
  assert.equal(summary.education, 1);
  assert.equal(summary.residency, 1);
  assert.equal(summary.boardCertifications, 1);
  assert.equal(summary.currentEmployment, 1);
  assert.ok(summary.currentMalpracticePolicy);
  assert.ok(summary.pendingVerification >= 1);

  // Quarantined document cannot support verification
  const qdoc = await prisma.document.create({
    data: {
      title: 'Quarantined diploma',
      type: 'SUPPORTING',
      category: 'education',
      tenantId: a.tenant.id,
      providerId: a.provider.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      status: 'RECEIVED'
    }
  });
  await linkHistoryDocument(
    ProfessionalHistorySection.RESIDENCY,
    a.tenant.id,
    a.provider.id,
    residency.id,
    qdoc.id,
    a.admin.id
  );
  await assert.rejects(
    () => verifyHistoryRecord(
      ProfessionalHistorySection.RESIDENCY,
      a.tenant.id,
      a.provider.id,
      residency.id,
      a.admin.id,
      {}
    ),
    (e: any) => e.code === 'DOCUMENT_NOT_TRUSTED'
  );
});

test('intake professional history conversion is idempotent and pending review', async () => {
  const ctx = await seedTenantProvider();
  const intake = await prisma.intakeRequest.create({
    data: {
      referenceNo: `PH-INT-${ctx.suffix}`,
      kind: 'PROVIDER',
      status: 'CONVERTED',
      tenantId: ctx.tenant.id,
      convertedProviderId: ctx.provider.id,
      payload: {},
      submittedPayload: {
        provider: {
          education: [{ school: 'State Med School', degree: 'MD', graduationYear: '2012' }],
          boardCertifications: [{ name: 'ABFM', year: '2015' }],
          employment: [{ employer: 'City Clinic', title: 'MD', current: true, startDate: '2016-01-01' }],
          affiliations: [{ facilityName: 'County Hospital', affiliationType: 'Active' }],
          malpractice: [{ carrier: 'InsureCo', policyNumber: 'X-1', current: true }]
        }
      }
    }
  });

  const first = await convertIntakeProfessionalHistory({
    tenantId: ctx.tenant.id,
    providerId: ctx.provider.id,
    intakeId: intake.id,
    actorId: ctx.admin.id,
    payload: intake.submittedPayload
  });
  assert.equal(first.idempotent, false);
  assert.ok(first.created.education >= 1);
  assert.ok(first.created.boardCertifications >= 1);

  const edu = await prisma.providerEducation.findFirst({
    where: { sourceIntakeId: intake.id }
  });
  assert.equal(edu?.verificationStatus, HistoryVerificationStatus.PENDING_REVIEW);

  const second = await convertIntakeProfessionalHistory({
    tenantId: ctx.tenant.id,
    providerId: ctx.provider.id,
    intakeId: intake.id,
    actorId: ctx.admin.id,
    payload: intake.submittedPayload
  });
  assert.equal(second.idempotent, true);
});
