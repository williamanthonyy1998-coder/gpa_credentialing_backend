import {
  HistoryRecordStatus,
  HistoryVerificationStatus,
  ProfessionalHistorySection,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { isTrustedForConversion } from './documentSecurity';

export type HistoryAudience = 'gpa' | 'client' | 'provider';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function parseDate(v: any): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) deny('Invalid date value');
  return d;
}

export function assertDateRange(start: Date | null, end: Date | null, label = 'Date range') {
  if (start && end && end.getTime() < start.getTime()) {
    deny(`${label}: end date must not be before start date`);
  }
}

export function canVerifyHistory(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

export function canReviewHistory(role: Role) {
  return (
    canVerifyHistory(role)
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canWriteHistoryAsStaff(role: Role) {
  return canReviewHistory(role);
}

export function canWriteHistoryAsClient(tenantRole: string | null | undefined) {
  return tenantRole === 'TENANT_ADMIN' || tenantRole === 'CREDENTIALING_MANAGER';
}

const SECTION_DELEGATE: Record<ProfessionalHistorySection, keyof typeof prisma> = {
  EDUCATION: 'providerEducation',
  RESIDENCY: 'providerResidency',
  FELLOWSHIP: 'providerFellowship',
  BOARD_CERTIFICATION: 'providerBoardCertification',
  PROFESSIONAL_CERTIFICATION: 'providerProfessionalCertification',
  EMPLOYMENT: 'providerEmployment',
  HOSPITAL_AFFILIATION: 'providerHospitalAffiliation',
  MALPRACTICE: 'providerMalpracticePolicy'
};

export function sectionDelegate(section: ProfessionalHistorySection) {
  return (prisma as any)[SECTION_DELEGATE[section]];
}

export async function assertHistoryAccess(tenantId: string, providerId: string) {
  await assertProviderInTenant(tenantId, providerId);
}

function maskPolicyNumber(value: string | null | undefined) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}

/** Sanitize record for audience. GPA sees internals; client/provider do not. */
export function sanitizeHistoryRecord(section: ProfessionalHistorySection, row: any, audience: HistoryAudience) {
  if (!row) return row;
  const out = { ...row };
  if (audience !== 'gpa') {
    delete out.reviewerNotes;
    delete out.verifiedById;
    if (section === ProfessionalHistorySection.EMPLOYMENT) delete out.reasonForLeaving;
  }
  if (audience === 'provider' || audience === 'client') {
    if (section === ProfessionalHistorySection.MALPRACTICE) {
      out.policyNumber = maskPolicyNumber(out.policyNumber);
      out.policyNumberMasked = true;
    }
  }
  return out;
}

async function recordVerificationEvent(input: {
  tenantId: string;
  providerId: string;
  section: ProfessionalHistorySection;
  recordId: string;
  action: string;
  fromStatus?: HistoryVerificationStatus | null;
  toStatus: HistoryVerificationStatus;
  reason?: string | null;
  actorId?: string | null;
  detail?: any;
}) {
  await prisma.professionalHistoryVerificationEvent.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      section: input.section,
      recordId: input.recordId,
      action: input.action,
      fromStatus: input.fromStatus || null,
      toStatus: input.toStatus,
      reason: input.reason || null,
      actorId: input.actorId || null,
      detail: input.detail || undefined
    }
  });
}

async function assertDocumentLinkable(tenantId: string, providerId: string, documentId: string | null | undefined) {
  if (!documentId) return null;
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.tenantId !== tenantId) deny('Document not found', 404);
  if (doc.providerId && doc.providerId !== providerId) deny('Document is not linked to this provider', 403);
  return doc;
}

function normalizeCommon(body: any) {
  return {
    notes: body.notes != null ? String(body.notes) : undefined,
    documentId: body.documentId || null,
    country: body.country != null ? String(body.country) : undefined,
    state: body.state != null ? String(body.state) : undefined,
    city: body.city != null ? String(body.city) : undefined
  };
}

export async function listHistorySection(
  tenantId: string,
  providerId: string,
  section: ProfessionalHistorySection,
  audience: HistoryAudience
) {
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const usesRecordStatus: ProfessionalHistorySection[] = [
    ProfessionalHistorySection.EDUCATION,
    ProfessionalHistorySection.RESIDENCY,
    ProfessionalHistorySection.FELLOWSHIP,
    ProfessionalHistorySection.EMPLOYMENT
  ];
  const filterArchived = usesRecordStatus.includes(section);
  const rows = await delegate.findMany({
    where: {
      tenantId,
      providerId,
      ...(filterArchived
        ? { recordStatus: { not: HistoryRecordStatus.ARCHIVED } }
        : { status: { not: HistoryRecordStatus.ARCHIVED } })
    },
    orderBy: { createdAt: 'desc' }
  });
  return rows.map((r: any) => sanitizeHistoryRecord(section, r, audience));
}

export async function getHistorySummary(tenantId: string, providerId: string) {
  await assertHistoryAccess(tenantId, providerId);
  const now = new Date();
  const [
    education,
    residency,
    fellowship,
    board,
    professional,
    employment,
    hospital,
    malpractice,
    pendingBuckets
  ] = await Promise.all([
    prisma.providerEducation.count({ where: { tenantId, providerId, recordStatus: { not: 'ARCHIVED' } } }),
    prisma.providerResidency.count({ where: { tenantId, providerId, recordStatus: { not: 'ARCHIVED' } } }),
    prisma.providerFellowship.count({ where: { tenantId, providerId, recordStatus: { not: 'ARCHIVED' } } }),
    prisma.providerBoardCertification.count({ where: { tenantId, providerId, status: { not: 'ARCHIVED' } } }),
    prisma.providerProfessionalCertification.count({ where: { tenantId, providerId, status: { not: 'ARCHIVED' } } }),
    prisma.providerEmployment.count({ where: { tenantId, providerId, isCurrent: true, recordStatus: { not: 'ARCHIVED' } } }),
    prisma.providerHospitalAffiliation.count({
      where: { tenantId, providerId, status: { in: ['ACTIVE', 'CURRENT'] } }
    }),
    prisma.providerMalpracticePolicy.findFirst({
      where: { tenantId, providerId, isCurrent: true, status: { not: 'ARCHIVED' } },
      select: { id: true, insuranceCarrier: true, expirationDate: true, verificationStatus: true }
    }),
    Promise.all([
      prisma.providerEducation.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerResidency.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerFellowship.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerBoardCertification.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerProfessionalCertification.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerEmployment.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerHospitalAffiliation.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerMalpracticePolicy.count({ where: { tenantId, providerId, verificationStatus: 'PENDING_REVIEW' } })
    ])
  ]);

  const expiredBoard = await prisma.providerBoardCertification.count({
    where: {
      tenantId,
      providerId,
      doesNotExpire: false,
      expirationDate: { lt: now },
      status: { not: 'ARCHIVED' }
    }
  });
  const expiredMalpractice = await prisma.providerMalpracticePolicy.count({
    where: { tenantId, providerId, expirationDate: { lt: now }, status: { not: 'ARCHIVED' } }
  });
  const expiredHospital = await prisma.providerHospitalAffiliation.count({
    where: { tenantId, providerId, expirationDate: { lt: now }, status: { not: 'ARCHIVED' } }
  });
  const expiredProfessional = await prisma.providerProfessionalCertification.count({
    where: { tenantId, providerId, expirationDate: { lt: now }, status: { not: 'ARCHIVED' } }
  });

  const pendingVerification = pendingBuckets.reduce((a, b) => a + b, 0);

  return {
    education,
    residency,
    fellowship,
    boardCertifications: board,
    professionalCertifications: professional,
    currentEmployment: employment,
    activeHospitalAffiliations: hospital,
    currentMalpracticePolicy: malpractice
      ? {
          id: malpractice.id,
          insuranceCarrier: malpractice.insuranceCarrier,
          expirationDate: malpractice.expirationDate,
          verificationStatus: malpractice.verificationStatus
        }
      : null,
    pendingVerification,
    expiredRecords: expiredBoard + expiredMalpractice + expiredHospital + expiredProfessional
  };
}

export async function createEducation(
  tenantId: string,
  providerId: string,
  body: any,
  actorId: string,
  opts?: { initialStatus?: HistoryVerificationStatus; sourceIntakeId?: string | null }
) {
  await assertHistoryAccess(tenantId, providerId);
  const institutionName = String(body.institutionName || '').trim();
  if (!institutionName) deny('Institution name is required');
  const startDate = parseDate(body.startDate);
  const endDate = parseDate(body.endDate);
  const graduationDate = parseDate(body.graduationDate);
  assertDateRange(startDate, endDate, 'Education');
  if (graduationDate && startDate && graduationDate.getTime() < startDate.getTime()) {
    deny('Graduation date must not be before start date');
  }
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const common = normalizeCommon(body);
  const duplicate = await prisma.providerEducation.findFirst({
    where: {
      tenantId,
      providerId,
      institutionName: { equals: institutionName, mode: 'insensitive' },
      degreeName: body.degreeName ? { equals: String(body.degreeName), mode: 'insensitive' } : undefined,
      graduationDate: graduationDate || undefined,
      recordStatus: { not: 'ARCHIVED' }
    }
  });
  if (duplicate) deny('A similar education record already exists', 409, 'DUPLICATE_HISTORY');

  const row = await prisma.providerEducation.create({
    data: {
      tenantId,
      providerId,
      institutionName,
      degreeTypeId: body.degreeTypeId || null,
      degreeName: body.degreeName ? String(body.degreeName) : null,
      fieldOfStudy: body.fieldOfStudy ? String(body.fieldOfStudy) : null,
      startDate,
      endDate,
      graduationDate,
      country: common.country || null,
      state: common.state || null,
      city: common.city || null,
      notes: common.notes || null,
      documentId: common.documentId,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId,
    providerId,
    section: ProfessionalHistorySection.EDUCATION,
    recordId: row.id,
    action: 'CREATED',
    toStatus: row.verificationStatus,
    actorId
  });
  return row;
}

export async function createResidency(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const institutionName = String(body.institutionName || '').trim();
  if (!institutionName) deny('Institution name is required');
  const startDate = parseDate(body.startDate);
  const endDate = parseDate(body.endDate);
  assertDateRange(startDate, endDate, 'Residency');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerResidency.create({
    data: {
      tenantId,
      providerId,
      institutionName,
      programName: body.programName ? String(body.programName) : null,
      specialtyId: body.specialtyId || null,
      specialtyName: body.specialtyName ? String(body.specialtyName) : null,
      startDate,
      endDate,
      completionStatus: body.completionStatus || 'COMPLETED',
      country: body.country || null,
      state: body.state || null,
      city: body.city || null,
      programDirector: body.programDirector || null,
      contactInfo: body.contactInfo || null,
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.RESIDENCY, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createFellowship(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const institutionName = String(body.institutionName || '').trim();
  if (!institutionName) deny('Institution name is required');
  const startDate = parseDate(body.startDate);
  const endDate = parseDate(body.endDate);
  assertDateRange(startDate, endDate, 'Fellowship');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerFellowship.create({
    data: {
      tenantId,
      providerId,
      institutionName,
      programName: body.programName ? String(body.programName) : null,
      specialtyId: body.specialtyId || null,
      specialtyName: body.specialtyName ? String(body.specialtyName) : null,
      startDate,
      endDate,
      completionStatus: body.completionStatus || 'COMPLETED',
      country: body.country || null,
      state: body.state || null,
      city: body.city || null,
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.FELLOWSHIP, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createBoardCertification(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const certifyingBoard = String(body.certifyingBoard || body.name || '').trim();
  if (!certifyingBoard) deny('Certifying board name is required');
  const issueDate = parseDate(body.issueDate);
  const expirationDate = body.doesNotExpire ? null : parseDate(body.expirationDate);
  assertDateRange(issueDate, expirationDate, 'Board certification');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerBoardCertification.create({
    data: {
      tenantId,
      providerId,
      categoryId: body.categoryId || null,
      certifyingBoard,
      specialtyId: body.specialtyId || null,
      specialtyName: body.specialtyName || null,
      certificationNumber: body.certificationNumber || null,
      issueDate,
      expirationDate,
      doesNotExpire: Boolean(body.doesNotExpire),
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.BOARD_CERTIFICATION, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createProfessionalCertification(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const certificationName = String(body.certificationName || body.name || '').trim();
  if (!certificationName) deny('Certification name is required');
  const issueDate = parseDate(body.issueDate);
  const expirationDate = parseDate(body.expirationDate);
  assertDateRange(issueDate, expirationDate, 'Professional certification');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerProfessionalCertification.create({
    data: {
      tenantId,
      providerId,
      certificationName,
      certificationTypeId: body.certificationTypeId || null,
      certificationTypeName: body.certificationTypeName || body.type || null,
      issuingOrganization: body.issuingOrganization || null,
      certificateNumber: body.certificateNumber || null,
      issueDate,
      expirationDate,
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.PROFESSIONAL_CERTIFICATION, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createEmployment(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const employerName = String(body.employerName || '').trim();
  if (!employerName) deny('Employer name is required');
  const startDate = parseDate(body.startDate);
  const endDate = body.isCurrent ? null : parseDate(body.endDate);
  assertDateRange(startDate, endDate, 'Employment');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerEmployment.create({
    data: {
      tenantId,
      providerId,
      employerName,
      employerType: body.employerType || null,
      positionTitle: body.positionTitle || null,
      specialtyOrDept: body.specialtyOrDept || null,
      startDate,
      endDate,
      isCurrent: Boolean(body.isCurrent),
      country: body.country || null,
      state: body.state || null,
      city: body.city || null,
      locationText: body.locationText || null,
      supervisorName: body.supervisorName || null,
      contactInfo: body.contactInfo || null,
      reasonForLeaving: body.reasonForLeaving || null,
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.EMPLOYMENT, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createHospitalAffiliation(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const facilityId = body.facilityId || null;
  let hospitalName = body.hospitalName ? String(body.hospitalName).trim() : null;
  if (facilityId) {
    const facility = await prisma.facility.findUnique({
      where: { id: facilityId },
      include: { organization: { select: { tenantId: true } }, practice: { include: { organization: { select: { tenantId: true } } } } }
    });
    if (!facility) deny('Facility not found', 404);
    const facilityTenant =
      facility.organization?.tenantId
      || facility.practice?.organization?.tenantId
      || null;
    // Facilities without tenant mapping are treated as external name links only when hospitalName provided.
    if (facilityTenant && facilityTenant !== tenantId) {
      deny('Cannot link a facility owned by another tenant', 403, 'CROSS_TENANT_FACILITY');
    }
    if (!hospitalName) hospitalName = facility.name;
  }
  if (!facilityId && !hospitalName) deny('Hospital name or facility is required');
  const effectiveDate = parseDate(body.effectiveDate);
  const expirationDate = parseDate(body.expirationDate);
  assertDateRange(effectiveDate, expirationDate, 'Hospital affiliation');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerHospitalAffiliation.create({
    data: {
      tenantId,
      providerId,
      facilityId,
      hospitalName,
      affiliationType: body.affiliationType || null,
      department: body.department || null,
      effectiveDate,
      expirationDate,
      privilegeStatus: body.privilegeStatus || null,
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.HOSPITAL_AFFILIATION, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function createMalpractice(tenantId: string, providerId: string, body: any, actorId: string, opts?: any) {
  await assertHistoryAccess(tenantId, providerId);
  const insuranceCarrier = String(body.insuranceCarrier || '').trim();
  if (!insuranceCarrier) deny('Insurance carrier is required');
  const effectiveDate = parseDate(body.effectiveDate);
  const expirationDate = parseDate(body.expirationDate);
  assertDateRange(effectiveDate, expirationDate, 'Malpractice policy');
  const perOccurrence = body.perOccurrenceAmount != null ? Number(body.perOccurrenceAmount) : null;
  const aggregate = body.aggregateAmount != null ? Number(body.aggregateAmount) : null;
  if (perOccurrence != null && (Number.isNaN(perOccurrence) || perOccurrence < 0)) deny('Invalid per-occurrence amount');
  if (aggregate != null && (Number.isNaN(aggregate) || aggregate < 0)) deny('Invalid aggregate amount');
  await assertDocumentLinkable(tenantId, providerId, body.documentId);
  const row = await prisma.providerMalpracticePolicy.create({
    data: {
      tenantId,
      providerId,
      insuranceCarrier,
      policyNumber: body.policyNumber || null,
      coverageType: body.coverageType || null,
      perOccurrenceAmount: perOccurrence,
      aggregateAmount: aggregate,
      effectiveDate,
      expirationDate,
      retroactiveDate: parseDate(body.retroactiveDate),
      hasTailCoverage: body.hasTailCoverage == null ? null : Boolean(body.hasTailCoverage),
      tailCoverageNotes: body.tailCoverageNotes || null,
      isCurrent: Boolean(body.isCurrent),
      notes: body.notes || null,
      documentId: body.documentId || null,
      verificationStatus: opts?.initialStatus || HistoryVerificationStatus.PENDING_REVIEW,
      sourceIntakeId: opts?.sourceIntakeId || null
    }
  });
  await recordVerificationEvent({
    tenantId, providerId, section: ProfessionalHistorySection.MALPRACTICE, recordId: row.id,
    action: 'CREATED', toStatus: row.verificationStatus, actorId
  });
  return row;
}

export async function updateHistoryRecord(
  section: ProfessionalHistorySection,
  tenantId: string,
  providerId: string,
  recordId: string,
  body: any,
  actorId: string,
  audience: HistoryAudience
) {
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const before = await delegate.findFirst({ where: { id: recordId, tenantId, providerId } });
  if (!before) deny('History record not found', 404);

  // Providers/clients cannot set verification fields
  if (audience !== 'gpa') {
    delete body.verificationStatus;
    delete body.verifiedAt;
    delete body.verifiedById;
    delete body.reviewerNotes;
    delete body.rejectionReason;
  }
  if (audience === 'provider' || audience === 'client') {
    delete body.reasonForLeaving;
  }

  const wasVerified = before.verificationStatus === HistoryVerificationStatus.VERIFIED;
  const data: any = { ...body };
  // Strip unknown / relation keys
  delete data.id;
  delete data.tenantId;
  delete data.providerId;
  delete data.createdAt;
  delete data.updatedAt;

  for (const key of Object.keys(data)) {
    if (/(Date|At)$/.test(key) && data[key] !== undefined) {
      data[key] = parseDate(data[key]);
    }
  }
  if (data.startDate !== undefined || data.endDate !== undefined) {
    assertDateRange(
      data.startDate !== undefined ? data.startDate : before.startDate,
      data.endDate !== undefined ? data.endDate : before.endDate,
      section
    );
  }
  if (data.effectiveDate !== undefined || data.expirationDate !== undefined) {
    assertDateRange(
      data.effectiveDate !== undefined ? data.effectiveDate : before.effectiveDate,
      data.expirationDate !== undefined ? data.expirationDate : before.expirationDate,
      section
    );
  }

  if (wasVerified && audience !== 'gpa') {
    data.verificationStatus = HistoryVerificationStatus.PENDING_REVIEW;
    data.verifiedAt = null;
    data.verifiedById = null;
  } else if (wasVerified && audience === 'gpa' && body.reverify !== false) {
    // Material edits by staff on verified records require re-review unless explicitly verifying in same call
    const materialKeys = Object.keys(data).filter((k) => !['notes', 'reviewerNotes'].includes(k));
    if (materialKeys.length && data.verificationStatus !== HistoryVerificationStatus.VERIFIED) {
      data.verificationStatus = HistoryVerificationStatus.PENDING_REVIEW;
      data.verifiedAt = null;
      data.verifiedById = null;
    }
  }

  const row = await delegate.update({ where: { id: recordId }, data });
  if (wasVerified && row.verificationStatus === HistoryVerificationStatus.PENDING_REVIEW) {
    await recordVerificationEvent({
      tenantId,
      providerId,
      section,
      recordId,
      action: 'REQUIRES_RE_REVIEW',
      fromStatus: HistoryVerificationStatus.VERIFIED,
      toStatus: HistoryVerificationStatus.PENDING_REVIEW,
      actorId
    });
  }
  return sanitizeHistoryRecord(section, row, audience);
}

export async function archiveHistoryRecord(
  section: ProfessionalHistorySection,
  tenantId: string,
  providerId: string,
  recordId: string,
  actorId: string
) {
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const before = await delegate.findFirst({ where: { id: recordId, tenantId, providerId } });
  if (!before) deny('History record not found', 404);
  const usesRecordStatus = 'recordStatus' in before;
  const row = await delegate.update({
    where: { id: recordId },
    data: usesRecordStatus
      ? { recordStatus: HistoryRecordStatus.ARCHIVED }
      : { status: HistoryRecordStatus.ARCHIVED }
  });
  await recordVerificationEvent({
    tenantId,
    providerId,
    section,
    recordId,
    action: 'ARCHIVED',
    fromStatus: before.verificationStatus,
    toStatus: before.verificationStatus,
    actorId
  });
  return row;
}

export async function verifyHistoryRecord(
  section: ProfessionalHistorySection,
  tenantId: string,
  providerId: string,
  recordId: string,
  actorId: string,
  opts: { reviewerNotes?: string | null }
) {
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const before = await delegate.findFirst({ where: { id: recordId, tenantId, providerId } });
  if (!before) deny('History record not found', 404);

  if (before.documentId) {
    const doc = await prisma.document.findUnique({ where: { id: before.documentId } });
    if (doc && !isTrustedForConversion(doc.securityStatus)) {
      deny(
        'Supporting document is not AVAILABLE. Quarantined/rejected documents cannot be treated as verified evidence.',
        409,
        'DOCUMENT_NOT_TRUSTED'
      );
    }
  }

  const row = await delegate.update({
    where: { id: recordId },
    data: {
      verificationStatus: HistoryVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
      verifiedById: actorId,
      rejectionReason: null,
      reviewerNotes: opts.reviewerNotes !== undefined ? opts.reviewerNotes : before.reviewerNotes
    }
  });
  await recordVerificationEvent({
    tenantId,
    providerId,
    section,
    recordId,
    action: 'VERIFIED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.VERIFIED,
    actorId,
    detail: { note: 'Document upload alone does not verify; explicit reviewer action required' }
  });
  return row;
}

export async function rejectHistoryRecord(
  section: ProfessionalHistorySection,
  tenantId: string,
  providerId: string,
  recordId: string,
  actorId: string,
  reason: string,
  opts: { reviewerNotes?: string | null }
) {
  if (!String(reason || '').trim()) deny('Rejection reason is required');
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const before = await delegate.findFirst({ where: { id: recordId, tenantId, providerId } });
  if (!before) deny('History record not found', 404);
  const row = await delegate.update({
    where: { id: recordId },
    data: {
      verificationStatus: HistoryVerificationStatus.REJECTED,
      verifiedAt: new Date(),
      verifiedById: actorId,
      rejectionReason: reason,
      reviewerNotes: opts.reviewerNotes !== undefined ? opts.reviewerNotes : before.reviewerNotes
    }
  });
  await recordVerificationEvent({
    tenantId,
    providerId,
    section,
    recordId,
    action: 'REJECTED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.REJECTED,
    reason,
    actorId
  });
  return row;
}

export async function linkHistoryDocument(
  section: ProfessionalHistorySection,
  tenantId: string,
  providerId: string,
  recordId: string,
  documentId: string,
  actorId: string
) {
  await assertHistoryAccess(tenantId, providerId);
  const delegate = sectionDelegate(section);
  const before = await delegate.findFirst({ where: { id: recordId, tenantId, providerId } });
  if (!before) deny('History record not found', 404);
  const doc = await assertDocumentLinkable(tenantId, providerId, documentId);
  if (!doc) deny('Document required');

  await prisma.professionalHistoryDocument.upsert({
    where: { section_recordId_documentId: { section, recordId, documentId } },
    create: { tenantId, providerId, section, recordId, documentId },
    update: {}
  });
  const row = await delegate.update({
    where: { id: recordId },
    data: {
      documentId,
      ...(before.verificationStatus === HistoryVerificationStatus.VERIFIED
        ? { verificationStatus: HistoryVerificationStatus.PENDING_REVIEW, verifiedAt: null, verifiedById: null }
        : {})
    }
  });
  await recordVerificationEvent({
    tenantId,
    providerId,
    section,
    recordId,
    action: 'DOCUMENT_LINKED',
    fromStatus: before.verificationStatus,
    toStatus: row.verificationStatus,
    actorId,
    detail: { documentId, securityStatus: doc.securityStatus }
  });
  return row;
}

export async function assertProviderOwnsConvertedProvider(userId: string, providerId: string, tenantId?: string | null) {
  const intake = await prisma.intakeRequest.findFirst({
    where: {
      providerUserId: userId,
      convertedProviderId: providerId,
      ...(tenantId ? { tenantId } : {})
    },
    select: { id: true, tenantId: true }
  });
  if (!intake) deny('Provider history not found', 404);
  return intake;
}
