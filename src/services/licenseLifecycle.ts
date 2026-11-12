import {
  DocumentStatus,
  DocumentSecurityStatus,
  HistoryVerificationStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { normalizeLicenseFields } from './directoryIntegration';
import { isTrustedForConversion } from './documentSecurity';

export type LicenseAudience = 'gpa' | 'client' | 'provider';

/** Computed display / attention — not stored (except EXPIRED sync on verify paths). */
export type LicenseAttention =
  | 'INCOMPLETE'
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'ACTIVE'
  | 'EXPIRING_30'
  | 'EXPIRING_60'
  | 'EXPIRING_90'
  | 'EXPIRED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'ARCHIVED';

export const DEFAULT_LICENSE_WARNING_DAYS = 90;

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysUntil(expiresAt: Date, now: Date) {
  const exp = startOfUtcDay(expiresAt).getTime();
  const n = startOfUtcDay(now).getTime();
  return Math.ceil((exp - n) / 86400000);
}

export function canVerifyLicense(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

export function canReviewLicense(role: Role) {
  return (
    canVerifyLicense(role)
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canWriteLicenseAsStaff(role: Role) {
  return canReviewLicense(role);
}

export function canWriteLicenseAsClient(tenantRole: string | null | undefined) {
  return tenantRole === 'TENANT_ADMIN' || tenantRole === 'CREDENTIALING_MANAGER';
}

export function maskLicenseNumber(value: string | null | undefined) {
  if (!value) return value;
  const s = String(value).trim();
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}

export function normalizeLicenseNumberKey(value: string | null | undefined) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Centralized license attention from dates + verification + flags.
 * Warning windows: 30 / 60 / 90 days (default horizon 90).
 */
export function computeLicenseAttention(
  lic: {
    archived?: boolean | null;
    suspended?: boolean | null;
    verificationStatus?: string | null;
    status?: string | null;
    number?: string | null;
    type?: string | null;
    licenseTypeId?: string | null;
    expiresAt?: Date | string | null;
    issuedAt?: Date | string | null;
  },
  now = new Date()
): LicenseAttention {
  if (lic.archived) return 'ARCHIVED';
  if (lic.suspended) return 'SUSPENDED';
  if (lic.verificationStatus === HistoryVerificationStatus.REJECTED || lic.status === DocumentStatus.REJECTED) {
    return 'REJECTED';
  }

  const hasType = Boolean(lic.licenseTypeId || String(lic.type || '').trim());
  const hasNumber = Boolean(String(lic.number || '').trim());
  if (!hasType || !hasNumber) return 'INCOMPLETE';

  // Date-based EXPIRED always visible (even for pending/draft) — never treat as current.
  if (lic.expiresAt) {
    const exp = new Date(lic.expiresAt);
    if (!Number.isNaN(exp.getTime()) && daysUntil(exp, now) < 0) return 'EXPIRED';
  }

  const vs = lic.verificationStatus || HistoryVerificationStatus.NOT_SUBMITTED;
  if (vs === HistoryVerificationStatus.PENDING_REVIEW || lic.status === DocumentStatus.UNDER_REVIEW) {
    return 'PENDING_REVIEW';
  }

  if (vs === HistoryVerificationStatus.VERIFIED) {
    if (lic.expiresAt) {
      const exp = new Date(lic.expiresAt);
      if (!Number.isNaN(exp.getTime())) {
        const d = daysUntil(exp, now);
        if (d <= 30) return 'EXPIRING_30';
        if (d <= 60) return 'EXPIRING_60';
        if (d <= 90) return 'EXPIRING_90';
      }
    }
    return 'ACTIVE';
  }

  return 'DRAFT';
}

export function annotateLicense(lic: any, audience: LicenseAudience = 'gpa') {
  const attention = computeLicenseAttention(lic);
  const out: any = {
    ...lic,
    attention,
    isCurrent: attention === 'ACTIVE' || attention === 'EXPIRING_30' || attention === 'EXPIRING_60' || attention === 'EXPIRING_90'
  };
  if (audience !== 'gpa') {
    delete out.reviewerNotes;
    delete out.verifiedById;
    out.number = maskLicenseNumber(out.number);
    out.numberMasked = true;
  }
  return out;
}

async function writeLicenseEvent(input: {
  licenseId: string;
  tenantId?: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorId?: string | null;
  reason?: string | null;
  detail?: any;
}) {
  const detail = input.detail ? { ...input.detail } : undefined;
  if (detail?.number) detail.number = maskLicenseNumber(String(detail.number));
  await prisma.licenseEvent.create({
    data: {
      licenseId: input.licenseId,
      tenantId: input.tenantId || null,
      action: input.action,
      fromStatus: input.fromStatus || null,
      toStatus: input.toStatus || null,
      actorId: input.actorId || null,
      reason: input.reason || null,
      detail
    }
  });
}

export async function assertLicenseInTenant(tenantId: string, licenseId: string) {
  const lic = await prisma.license.findUnique({ where: { id: licenseId } });
  if (!lic) deny('License not found', 404);
  await assertProviderInTenant(tenantId, lic.providerId);
  if (lic.tenantId && lic.tenantId !== tenantId) deny('License not found', 404);
  return lic;
}

async function assertNoDuplicateActive(input: {
  tenantId: string;
  providerId: string;
  number: string | null;
  licenseTypeId?: string | null;
  type?: string | null;
  usStateId?: string | null;
  state?: string | null;
  excludeId?: string | null;
}) {
  if (!input.number) return;
  const key = normalizeLicenseNumberKey(input.number);
  const candidates = await prisma.license.findMany({
    where: {
      providerId: input.providerId,
      archived: false,
      ...(input.tenantId ? { OR: [{ tenantId: input.tenantId }, { tenantId: null }] } : {}),
      ...(input.excludeId ? { id: { not: input.excludeId } } : {})
    },
    select: {
      id: true,
      number: true,
      licenseTypeId: true,
      type: true,
      usStateId: true,
      state: true,
      tenantId: true,
      verificationStatus: true
    }
  });
  const hit = candidates.find((c) => {
    if (normalizeLicenseNumberKey(c.number) !== key) return false;
    const typeMatch =
      (input.licenseTypeId && c.licenseTypeId === input.licenseTypeId)
      || (!input.licenseTypeId && input.type && String(c.type).toLowerCase() === String(input.type).toLowerCase())
      || (input.licenseTypeId && !c.licenseTypeId && input.type && String(c.type).toLowerCase() === String(input.type).toLowerCase());
    const stateMatch =
      (input.usStateId && c.usStateId === input.usStateId)
      || (!input.usStateId && input.state && String(c.state || '').toUpperCase() === String(input.state).toUpperCase())
      || (!input.usStateId && !input.state);
    return Boolean(typeMatch && stateMatch);
  });
  if (hit) {
    deny(
      'An active license with the same type, jurisdiction, and number already exists for this provider',
      409,
      'DUPLICATE_LICENSE'
    );
  }
}

export async function createLicense(input: {
  tenantId: string;
  providerId: string;
  body: any;
  actorId: string;
  audience: LicenseAudience;
}) {
  await assertProviderInTenant(input.tenantId, input.providerId);
  const fields = await normalizeLicenseFields(input.body || {}, { forCreate: true });
  const type = String(fields.type || input.body.type || '').trim();
  if (!type && !fields.licenseTypeId) deny('License type is required');
  const number = input.body.number != null ? String(input.body.number).trim() : null;
  await assertNoDuplicateActive({
    tenantId: input.tenantId,
    providerId: input.providerId,
    number,
    licenseTypeId: (fields.licenseTypeId as string) || null,
    type,
    usStateId: (fields.usStateId as string) || null,
    state: (fields.state as string) || input.body.state || null
  });

  if (input.body.documentId) {
    const doc = await prisma.document.findUnique({ where: { id: input.body.documentId } });
    if (!doc || doc.tenantId !== input.tenantId) deny('Document not found', 404);
    if (doc.providerId && doc.providerId !== input.providerId) deny('Document is not linked to this provider', 403);
  }

  const issuedAt = input.body.issuedAt ? new Date(input.body.issuedAt) : null;
  const expiresAt = input.body.expiresAt ? new Date(input.body.expiresAt) : null;
  if (issuedAt && expiresAt && expiresAt.getTime() < issuedAt.getTime()) {
    deny('Expiration date must not be before issue date');
  }

  // Clients/providers cannot create as VERIFIED
  const verificationStatus = HistoryVerificationStatus.NOT_SUBMITTED;
  const row = await prisma.license.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      type: type || 'License',
      licenseTypeId: (fields.licenseTypeId as string) || null,
      number,
      state: (fields.state as string) || input.body.state || null,
      usStateId: (fields.usStateId as string) || null,
      issuedAt,
      expiresAt,
      status: DocumentStatus.RECEIVED,
      issuingBody: input.body.issuingBody || null,
      notes: input.body.notes || null,
      isPrimary: Boolean(input.body.isPrimary),
      documentId: input.body.documentId || null,
      verificationStatus,
      sourceIntakeId: input.body.sourceIntakeId || null
    },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId: row.id,
    tenantId: input.tenantId,
    action: 'CREATED',
    toStatus: verificationStatus,
    actorId: input.actorId,
    detail: { type: row.type, state: row.state }
  });
  return annotateLicense(row, input.audience);
}

export async function updateLicense(input: {
  tenantId: string;
  licenseId: string;
  body: any;
  actorId: string;
  audience: LicenseAudience;
}) {
  const before = await assertLicenseInTenant(input.tenantId, input.licenseId);
  if (before.archived) deny('Archived licenses cannot be edited');

  const body = { ...input.body };
  // Lifecycle fields cannot be set via generic update
  delete body.verificationStatus;
  delete body.verifiedAt;
  delete body.verifiedById;
  delete body.status;
  delete body.tenantId;
  delete body.providerId;
  delete body.renewedFromId;
  if (input.audience !== 'gpa') {
    delete body.reviewerNotes;
    delete body.rejectionReason;
    delete body.archived;
    delete body.suspended;
  }

  const fields = await normalizeLicenseFields({ ...before, ...body }, { forCreate: false });
  if (body.number !== undefined || body.licenseTypeId !== undefined || body.usStateId !== undefined || body.type || body.state) {
    await assertNoDuplicateActive({
      tenantId: input.tenantId,
      providerId: before.providerId,
      number: body.number !== undefined ? body.number : before.number,
      licenseTypeId: (fields.licenseTypeId as string) || before.licenseTypeId,
      type: (fields.type as string) || before.type,
      usStateId: (fields.usStateId as string) || before.usStateId,
      state: (fields.state as string) || body.state || before.state,
      excludeId: before.id
    });
  }

  const issuedAt = body.issuedAt !== undefined ? (body.issuedAt ? new Date(body.issuedAt) : null) : before.issuedAt;
  const expiresAt = body.expiresAt !== undefined ? (body.expiresAt ? new Date(body.expiresAt) : null) : before.expiresAt;
  if (issuedAt && expiresAt && expiresAt.getTime() < issuedAt.getTime()) {
    deny('Expiration date must not be before issue date');
  }

  const wasVerified = before.verificationStatus === HistoryVerificationStatus.VERIFIED;
  const materialKeys = Object.keys(body).filter((k) => !['notes'].includes(k));
  const data: any = {
    ...body,
    ...(fields.licenseTypeId !== undefined ? { licenseTypeId: fields.licenseTypeId } : {}),
    ...(fields.type ? { type: fields.type } : {}),
    ...(fields.usStateId !== undefined ? { usStateId: fields.usStateId } : {}),
    ...(fields.state !== undefined ? { state: fields.state } : {}),
    issuedAt,
    expiresAt
  };
  if (wasVerified && materialKeys.length) {
    data.verificationStatus = HistoryVerificationStatus.PENDING_REVIEW;
    data.verifiedAt = null;
    data.verifiedById = null;
    data.status = DocumentStatus.UNDER_REVIEW;
  }

  const row = await prisma.license.update({
    where: { id: before.id },
    data,
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId: row.id,
    tenantId: input.tenantId,
    action: wasVerified && materialKeys.length ? 'REQUIRES_RE_REVIEW' : 'UPDATED',
    fromStatus: before.verificationStatus,
    toStatus: row.verificationStatus,
    actorId: input.actorId
  });
  return annotateLicense(row, input.audience);
}

export async function submitLicenseForReview(tenantId: string, licenseId: string, actorId: string) {
  const before = await assertLicenseInTenant(tenantId, licenseId);
  if (before.archived) deny('Archived licenses cannot be submitted');
  if (!before.number || !(before.licenseTypeId || before.type)) {
    deny('License is incomplete — type and number are required before review');
  }
  const attention = computeLicenseAttention(before);
  if (attention === 'INCOMPLETE') deny('License is incomplete');
  const row = await prisma.license.update({
    where: { id: licenseId },
    data: {
      verificationStatus: HistoryVerificationStatus.PENDING_REVIEW,
      status: DocumentStatus.UNDER_REVIEW,
      correctionRequest: null
    },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId,
    tenantId,
    action: 'SUBMITTED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.PENDING_REVIEW,
    actorId
  });
  return annotateLicense(row, 'gpa');
}

export async function verifyLicense(
  tenantId: string,
  licenseId: string,
  actorId: string,
  opts: { reviewerNotes?: string | null; verificationSource?: string | null; evidenceDocumentId?: string | null }
) {
  const { normalizeVerificationSource, assertExternalApiAllowed, verificationSourceLabel } =
    await import('./verificationSources');
  const source = normalizeVerificationSource(opts.verificationSource);
  assertExternalApiAllowed(source);

  const before = await assertLicenseInTenant(tenantId, licenseId);
  if (before.archived) deny('Archived licenses cannot be verified');
  const evidenceId = opts.evidenceDocumentId || before.documentId || null;
  if (evidenceId) {
    const doc = await prisma.document.findUnique({ where: { id: evidenceId } });
    if (!doc || doc.tenantId !== tenantId) deny('Evidence document not found', 404);
    if (doc.providerId && doc.providerId !== before.providerId) {
      deny('Evidence document is not linked to this provider', 403);
    }
    if (!isTrustedForConversion(doc.securityStatus as DocumentSecurityStatus)) {
      deny(
        'Supporting document is not AVAILABLE. Quarantined/rejected documents cannot be treated as verified evidence.',
        409,
        'DOCUMENT_NOT_TRUSTED'
      );
    }
  }
  if (computeLicenseAttention(before) === 'INCOMPLETE') {
    deny('Cannot verify an incomplete license');
  }
  // Expired licenses can be verified as historical but attention remains EXPIRED
  const row = await prisma.license.update({
    where: { id: licenseId },
    data: {
      verificationStatus: HistoryVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
      verifiedById: actorId,
      rejectionReason: null,
      status: DocumentStatus.VERIFIED,
      reviewerNotes: opts.reviewerNotes !== undefined ? opts.reviewerNotes : before.reviewerNotes,
      ...(evidenceId && !before.documentId ? { documentId: evidenceId } : {})
    },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId,
    tenantId,
    action: 'VERIFIED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.VERIFIED,
    actorId,
    detail: {
      verificationSource: source,
      verificationSourceLabel: verificationSourceLabel(source),
      evidenceDocumentId: evidenceId,
      note: 'Recorded verification decision — not an automated state board API unless source=external_api and configured'
    }
  });
  return annotateLicense(row, 'gpa');
}

export async function rejectLicense(
  tenantId: string,
  licenseId: string,
  actorId: string,
  reason: string,
  opts: { reviewerNotes?: string | null }
) {
  if (!String(reason || '').trim()) deny('Rejection reason is required');
  const before = await assertLicenseInTenant(tenantId, licenseId);
  const row = await prisma.license.update({
    where: { id: licenseId },
    data: {
      verificationStatus: HistoryVerificationStatus.REJECTED,
      verifiedAt: new Date(),
      verifiedById: actorId,
      rejectionReason: reason,
      status: DocumentStatus.REJECTED,
      reviewerNotes: opts.reviewerNotes !== undefined ? opts.reviewerNotes : before.reviewerNotes
    },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId,
    tenantId,
    action: 'REJECTED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.REJECTED,
    actorId,
    reason
  });
  return annotateLicense(row, 'gpa');
}

export async function requestLicenseCorrection(
  tenantId: string,
  licenseId: string,
  actorId: string,
  comments: string
) {
  if (!String(comments || '').trim()) deny('Correction comments are required');
  const before = await assertLicenseInTenant(tenantId, licenseId);
  const row = await prisma.license.update({
    where: { id: licenseId },
    data: {
      verificationStatus: HistoryVerificationStatus.PENDING_REVIEW,
      status: DocumentStatus.UNDER_REVIEW,
      correctionRequest: comments,
      verifiedAt: null,
      verifiedById: null
    },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId,
    tenantId,
    action: 'CORRECTION_REQUESTED',
    fromStatus: before.verificationStatus,
    toStatus: HistoryVerificationStatus.PENDING_REVIEW,
    actorId,
    reason: comments
  });
  return annotateLicense(row, 'gpa');
}

/**
 * Renewal: preserve old license; create new pending record linked via renewedFromId.
 * Pending renewal never makes the expired license appear current.
 */
export async function renewLicense(input: {
  tenantId: string;
  licenseId: string;
  body: any;
  actorId: string;
  audience: LicenseAudience;
}) {
  const prior = await assertLicenseInTenant(input.tenantId, input.licenseId);
  if (prior.archived) deny('Cannot renew an archived license');
  const issuedAt = input.body.issuedAt ? new Date(input.body.issuedAt) : null;
  const expiresAt = input.body.expiresAt ? new Date(input.body.expiresAt) : null;
  if (!expiresAt) deny('Renewal requires a new expiration date');
  if (issuedAt && expiresAt.getTime() < issuedAt.getTime()) {
    deny('Expiration date must not be before issue date');
  }

  const number = input.body.number != null ? String(input.body.number).trim() : prior.number;
  const row = await prisma.$transaction(async (tx) => {
    // Keep prior record intact — do not overwrite its expiration.
    const created = await tx.license.create({
      data: {
        tenantId: input.tenantId,
        providerId: prior.providerId,
        type: prior.type,
        licenseTypeId: prior.licenseTypeId,
        number,
        state: prior.state,
        usStateId: prior.usStateId,
        issuedAt,
        expiresAt,
        issuingBody: input.body.issuingBody || prior.issuingBody,
        notes: input.body.notes || null,
        isPrimary: prior.isPrimary,
        documentId: input.body.documentId || null,
        renewedFromId: prior.id,
        status: DocumentStatus.UNDER_REVIEW,
        verificationStatus: HistoryVerificationStatus.PENDING_REVIEW
      },
      include: { licenseType: true, usState: true }
    });
    await tx.licenseEvent.create({
      data: {
        licenseId: created.id,
        tenantId: input.tenantId,
        action: 'RENEWAL_CREATED',
        toStatus: HistoryVerificationStatus.PENDING_REVIEW,
        actorId: input.actorId,
        detail: { renewedFromId: prior.id }
      }
    });
    await tx.licenseEvent.create({
      data: {
        licenseId: prior.id,
        tenantId: input.tenantId,
        action: 'RENEWAL_SPAWNED',
        fromStatus: prior.verificationStatus,
        toStatus: prior.verificationStatus,
        actorId: input.actorId,
        detail: { renewalId: created.id }
      }
    });
    return created;
  });
  return annotateLicense(row, input.audience);
}

export async function archiveLicense(tenantId: string, licenseId: string, actorId: string) {
  const before = await assertLicenseInTenant(tenantId, licenseId);
  const row = await prisma.license.update({
    where: { id: licenseId },
    data: { archived: true },
    include: { licenseType: true, usState: true }
  });
  await writeLicenseEvent({
    licenseId,
    tenantId,
    action: 'ARCHIVED',
    fromStatus: before.verificationStatus,
    toStatus: before.verificationStatus,
    actorId
  });
  return annotateLicense(row, 'gpa');
}

export async function listProviderLicenses(
  tenantId: string,
  providerId: string,
  audience: LicenseAudience,
  opts?: { includeArchived?: boolean }
) {
  await assertProviderInTenant(tenantId, providerId);
  const rows = await prisma.license.findMany({
    where: {
      providerId,
      OR: [{ tenantId }, { tenantId: null }],
      ...(opts?.includeArchived ? {} : { archived: false })
    },
    include: { licenseType: true, usState: true, renewals: { select: { id: true, expiresAt: true, verificationStatus: true } } },
    orderBy: [{ isPrimary: 'desc' }, { expiresAt: 'asc' }, { createdAt: 'desc' }]
  });
  // Prefer tenant-scoped rows; if both null and matching tenant exist, still return provider licenses visible in tenant.
  return rows
    .filter((r) => !r.tenantId || r.tenantId === tenantId)
    .map((r) => annotateLicense(r, audience));
}

export async function getLicenseHistory(tenantId: string, licenseId: string) {
  await assertLicenseInTenant(tenantId, licenseId);
  return prisma.licenseEvent.findMany({
    where: { licenseId },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
}

export async function getLicenseExpirationSummary(tenantId: string, filters: {
  providerId?: string;
  licenseTypeId?: string;
  usStateId?: string;
  state?: string;
}) {
  const where: any = {
    archived: false,
    OR: [{ tenantId }, { tenantId: null }],
    provider: { tenantLinks: { some: { tenantId } } }
  };
  if (filters.providerId) {
    await assertProviderInTenant(tenantId, filters.providerId);
    where.providerId = filters.providerId;
  }
  if (filters.licenseTypeId) where.licenseTypeId = filters.licenseTypeId;
  if (filters.usStateId) where.usStateId = filters.usStateId;
  if (filters.state) where.state = { equals: filters.state, mode: 'insensitive' };

  const rows = await prisma.license.findMany({
    where,
    select: {
      id: true,
      providerId: true,
      number: true,
      type: true,
      licenseTypeId: true,
      usStateId: true,
      state: true,
      issuedAt: true,
      expiresAt: true,
      status: true,
      verificationStatus: true,
      archived: true,
      suspended: true
    }
  });

  const counts = {
    total: rows.length,
    active: 0,
    expiring30: 0,
    expiring60: 0,
    expiring90: 0,
    expired: 0,
    pendingVerification: 0,
    rejected: 0,
    incomplete: 0,
    suspended: 0
  };
  const now = new Date();
  for (const r of rows) {
    const a = computeLicenseAttention(r, now);
    if (a === 'ACTIVE') counts.active += 1;
    else if (a === 'EXPIRING_30') { counts.expiring30 += 1; counts.expiring60 += 1; counts.expiring90 += 1; }
    else if (a === 'EXPIRING_60') { counts.expiring60 += 1; counts.expiring90 += 1; }
    else if (a === 'EXPIRING_90') counts.expiring90 += 1;
    else if (a === 'EXPIRED') counts.expired += 1;
    else if (a === 'PENDING_REVIEW') counts.pendingVerification += 1;
    else if (a === 'REJECTED') counts.rejected += 1;
    else if (a === 'INCOMPLETE' || a === 'DRAFT') counts.incomplete += 1;
    else if (a === 'SUSPENDED') counts.suspended += 1;
  }
  return { counts, warningDays: { d30: 30, d60: 60, d90: 90 }, defaultHorizonDays: DEFAULT_LICENSE_WARNING_DAYS };
}
