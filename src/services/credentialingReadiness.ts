import { DocumentSecurityStatus, HistoryVerificationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { getProviderCredentialCompleteness } from './credentialCompleteness';
import { getHistorySummary, listHistorySection } from './professionalHistory';
import { ProfessionalHistorySection } from '@prisma/client';
import { listProviderLicenses } from './licenseLifecycle';

/**
 * Phase 3C — Operational credentialing readiness (NOT payer enrollment approval).
 * Reuses Phase 3A history summary + Phase 3B completeness/license attention.
 * Does not invent payer-specific or state board rules.
 */

export type ReadinessDimensionStatus =
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'PENDING_REVIEW'
  | 'ACTION_REQUIRED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'NOT_APPLICABLE'
  | 'NOT_ASSESSED';

export type ReadinessOverall =
  | 'READY_FOR_INTERNAL_REVIEW'
  | 'ACTION_REQUIRED'
  | 'PENDING_VERIFICATION'
  | 'INCOMPLETE_PROFILE'
  | 'EXPIRED_OR_INVALID_CREDENTIALS'
  | 'NOT_ASSESSED';

export type ReadinessAudience = 'gpa' | 'client' | 'provider';

export type ReadinessIssue = {
  code: string;
  message: string;
  section?: string;
  recordId?: string | null;
  whyItMatters: string;
  recommendedAction: string;
  responsibleRole: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
};

export type ReadinessDimension = {
  key: string;
  label: string;
  status: ReadinessDimensionStatus;
  issues: ReadinessIssue[];
  hrefHint?: string;
  counts?: Record<string, number>;
};

const HISTORY_SECTIONS: ProfessionalHistorySection[] = [
  ProfessionalHistorySection.EDUCATION,
  ProfessionalHistorySection.RESIDENCY,
  ProfessionalHistorySection.FELLOWSHIP,
  ProfessionalHistorySection.BOARD_CERTIFICATION,
  ProfessionalHistorySection.PROFESSIONAL_CERTIFICATION,
  ProfessionalHistorySection.EMPLOYMENT,
  ProfessionalHistorySection.HOSPITAL_AFFILIATION,
  ProfessionalHistorySection.MALPRACTICE
];

function dim(
  key: string,
  label: string,
  status: ReadinessDimensionStatus,
  issues: ReadinessIssue[] = [],
  extra?: Partial<ReadinessDimension>
): ReadinessDimension {
  return { key, label, status, issues, ...extra };
}

function deriveOverall(dimensions: ReadinessDimension[]): ReadinessOverall {
  const statuses = dimensions.map((d) => d.status);
  if (statuses.includes('EXPIRED') || statuses.includes('REJECTED')) {
    return 'EXPIRED_OR_INVALID_CREDENTIALS';
  }
  if (statuses.includes('ACTION_REQUIRED') || statuses.includes('INCOMPLETE')) {
    return 'INCOMPLETE_PROFILE';
  }
  if (statuses.includes('PENDING_REVIEW')) {
    return 'PENDING_VERIFICATION';
  }
  if (statuses.every((s) => s === 'COMPLETE' || s === 'NOT_APPLICABLE')) {
    return 'READY_FOR_INTERNAL_REVIEW';
  }
  if (statuses.some((s) => s === 'NOT_ASSESSED')) {
    return 'NOT_ASSESSED';
  }
  return 'ACTION_REQUIRED';
}

async function collectHistoryIssues(tenantId: string, providerId: string): Promise<{
  issues: ReadinessIssue[];
  rejected: number;
  pending: number;
  expired: number;
  withTrustedEvidence: number;
  totalActive: number;
}> {
  const issues: ReadinessIssue[] = [];
  let rejected = 0;
  let pending = 0;
  let expired = 0;
  let withTrustedEvidence = 0;
  let totalActive = 0;
  const now = new Date();

  const sectionRows = await Promise.all(
    HISTORY_SECTIONS.map(async (section) => ({
      section,
      rows: await listHistorySection(tenantId, providerId, section, 'gpa')
    }))
  );
  const docIds = new Set<string>();
  for (const { rows } of sectionRows) {
    for (const row of rows as any[]) {
      if (row.documentId) docIds.add(row.documentId);
    }
  }
  const docs = docIds.size
    ? await prisma.document.findMany({
        where: { id: { in: [...docIds] }, tenantId },
        select: { id: true, securityStatus: true, storageKey: true }
      })
    : [];
  const docById = new Map(docs.map((d) => [d.id, d]));

  for (const { section, rows } of sectionRows) {
    for (const row of rows as any[]) {
      const archived =
        row.recordStatus === 'ARCHIVED' || row.status === 'ARCHIVED';
      if (archived) continue;
      totalActive += 1;
      const vs = row.verificationStatus as HistoryVerificationStatus | undefined;
      if (vs === HistoryVerificationStatus.REJECTED) {
        rejected += 1;
        issues.push({
          code: `history.${section.toLowerCase()}.rejected`,
          message: `${section.replace(/_/g, ' ')} record was rejected and needs correction`,
          section: section.toLowerCase(),
          recordId: row.id,
          whyItMatters: 'Rejected history blocks internal credentialing review until corrected.',
          recommendedAction: 'Open the record, apply corrections, and resubmit for review.',
          responsibleRole: 'CLIENT_USER or EXTERNAL_PROVIDER (edit); GPA reviewer (re-verify)',
          priority: 'HIGH'
        });
      } else if (vs === HistoryVerificationStatus.PENDING_REVIEW) {
        pending += 1;
        issues.push({
          code: `history.${section.toLowerCase()}.pending`,
          message: `${section.replace(/_/g, ' ')} record is awaiting reviewer verification`,
          section: section.toLowerCase(),
          recordId: row.id,
          whyItMatters: 'Pending verification means evidence has not been GPA-reviewed.',
          recommendedAction: 'Authorized GPA staff should review and verify or request correction.',
          responsibleRole: 'CREDENTIALING_MANAGER / APPROVER / SPECIALIST',
          priority: 'NORMAL'
        });
      }

      const exp =
        row.expirationDate instanceof Date
          ? row.expirationDate
          : row.expirationDate
            ? new Date(row.expirationDate)
            : null;
      const doesNotExpire = Boolean(row.doesNotExpire);
      if (exp && !doesNotExpire && exp < now) {
        expired += 1;
        issues.push({
          code: `history.${section.toLowerCase()}.expired`,
          message: `${section.replace(/_/g, ' ')} credential/policy has expired`,
          section: section.toLowerCase(),
          recordId: row.id,
          whyItMatters: 'Expired credentials require renewal attention before internal review completion.',
          recommendedAction: 'Update dates or renew the credential and upload supporting evidence if required.',
          responsibleRole: 'CLIENT_USER or EXTERNAL_PROVIDER',
          priority: 'HIGH'
        });
      }

      if (row.documentId) {
        const doc = docById.get(row.documentId);
        if (
          doc?.storageKey
          && doc.securityStatus === DocumentSecurityStatus.AVAILABLE
        ) {
          withTrustedEvidence += 1;
        } else if (doc && doc.securityStatus !== DocumentSecurityStatus.AVAILABLE) {
          issues.push({
            code: `history.${section.toLowerCase()}.evidence_untrusted`,
            message: `Supporting document for ${section.replace(/_/g, ' ')} is not trusted evidence`,
            section: section.toLowerCase(),
            recordId: row.id,
            whyItMatters: 'Quarantined or unavailable files cannot be treated as verified evidence.',
            recommendedAction: 'Wait for security clearance or re-upload a clean supporting document.',
            responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER (upload); GPA (security review)',
            priority: 'HIGH'
          });
        }
      }
      // Evidence is optional unless a configured requirement exists — we do not invent mandatory evidence.
    }
  }

  return { issues, rejected, pending, expired, withTrustedEvidence, totalActive };
}

/**
 * Server-side readiness assessment. Never trust client-supplied overall/dimension statuses.
 */
export async function assessProviderReadiness(
  tenantId: string,
  providerId: string,
  audience: ReadinessAudience = 'gpa'
) {
  await assertProviderInTenant(tenantId, providerId);

  const [provider, completeness, historySummary, historyDetail, licenses, review] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        npi: true,
        status: true,
        updatedAt: true,
        primarySpecialtyId: true,
        secondarySpecialtyId: true,
        primarySpecialtyRef: { select: { id: true, name: true } },
        secondarySpecialtyRef: { select: { id: true, name: true } },
        professionalType: true
      }
    }),
    getProviderCredentialCompleteness(tenantId, providerId),
    getHistorySummary(tenantId, providerId),
    collectHistoryIssues(tenantId, providerId),
    listProviderLicenses(tenantId, providerId, audience === 'provider' ? 'provider' : audience === 'client' ? 'client' : 'gpa'),
    prisma.providerProfileReview.findFirst({
      where: { tenantId, providerId },
      orderBy: { updatedAt: 'desc' }
    })
  ]);

  if (!provider) {
    const err: any = new Error('Provider not found');
    err.status = 404;
    throw err;
  }

  const identityIssues: ReadinessIssue[] = [];
  if (!provider.firstName || !provider.lastName) {
    identityIssues.push({
      code: 'identity.name_missing',
      message: 'Provider legal name is incomplete',
      whyItMatters: 'Identity fields are required for credentialing file identification.',
      recommendedAction: 'Update provider first and last name.',
      responsibleRole: 'GPA staff or CLIENT_USER',
      priority: 'HIGH'
    });
  }

  const specialtyIssues: ReadinessIssue[] = [];
  if (!provider.primarySpecialtyId) {
    specialtyIssues.push({
      code: 'specialty.primary_missing',
      message: 'Provider has no primary specialty',
      whyItMatters: 'Primary specialty drives credentialing workflows and enrollment targeting.',
      recommendedAction: 'Assign a primary specialty from the directory.',
      responsibleRole: 'GPA staff or CLIENT_USER',
      priority: 'HIGH'
    });
  }

  const licenseIssues: ReadinessIssue[] = [];
  const licenseVerifyIssues: ReadinessIssue[] = [];
  const expirationIssues: ReadinessIssue[] = [];
  let licenseIncomplete = 0;
  let licensePending = 0;
  let licenseExpired = 0;
  let licenseRejected = 0;
  let licenseVerified = 0;

  for (const l of licenses as any[]) {
    if (l.attention === 'INCOMPLETE' || l.attention === 'DRAFT') {
      licenseIncomplete += 1;
      licenseIssues.push({
        code: 'license.incomplete',
        message: `License missing required information (${l.licenseType?.name || l.type || 'license'})`,
        section: 'licenses',
        recordId: l.id,
        whyItMatters: 'Incomplete licenses cannot be verified.',
        recommendedAction: 'Complete jurisdiction, number, and expiration fields, then submit for review.',
        responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER / GPA specialist',
        priority: 'HIGH'
      });
    }
    if (l.attention === 'PENDING_REVIEW' || l.verificationStatus === 'PENDING_REVIEW') {
      licensePending += 1;
      licenseVerifyIssues.push({
        code: 'license.pending_verification',
        message: 'License is awaiting reviewer verification',
        section: 'licenses',
        recordId: l.id,
        whyItMatters: 'Pending verification is distinct from complete/active credentials.',
        recommendedAction: 'Authorized GPA reviewer verifies or requests correction.',
        responsibleRole: 'CREDENTIALING_MANAGER / APPROVER',
        priority: 'NORMAL'
      });
    }
    if (l.attention === 'EXPIRED') {
      licenseExpired += 1;
      expirationIssues.push({
        code: 'license.expired',
        message: 'License has expired',
        section: 'licenses',
        recordId: l.id,
        whyItMatters: 'Expired licenses require renewal before operational readiness.',
        recommendedAction: 'Use renew workflow to create a new pending license row (history preserved).',
        responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER / GPA specialist',
        priority: 'URGENT'
      });
    }
    if (l.attention === 'REJECTED' || l.verificationStatus === 'REJECTED') {
      licenseRejected += 1;
      licenseIssues.push({
        code: 'license.rejected',
        message: 'License was rejected and needs correction',
        section: 'licenses',
        recordId: l.id,
        whyItMatters: 'Rejected licenses block readiness until corrected and re-reviewed.',
        recommendedAction: 'Apply corrections and resubmit for review.',
        responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER',
        priority: 'HIGH'
      });
    }
    if (l.verificationStatus === 'VERIFIED' && l.attention !== 'EXPIRED') {
      licenseVerified += 1;
    }
  }

  if (!licenses.length) {
    licenseIssues.push({
      code: 'license.none',
      message: 'No state/professional licenses on file',
      section: 'licenses',
      whyItMatters: 'At least one license record is expected for internal credentialing review.',
      recommendedAction: 'Add a license via the license lifecycle API/UI.',
      responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER / GPA specialist',
      priority: 'HIGH'
    });
  }

  const evidenceIssues: ReadinessIssue[] = [];
  const trustIssues: ReadinessIssue[] = [];
  const reviewIssues: ReadinessIssue[] = [];

  for (const d of completeness.documents) {
    if (d.quarantined) {
      trustIssues.push({
        code: 'document.quarantined',
        message: `Credential document is quarantined/not trusted (${d.label})`,
        section: 'credentials',
        recordId: d.id,
        whyItMatters: 'Quarantined files are never treated as trusted evidence.',
        recommendedAction: 'Await security clearance or replace the upload.',
        responsibleRole: 'GPA security/review; uploader may replace file',
        priority: 'HIGH'
      });
    }
    if (d.rejected) {
      evidenceIssues.push({
        code: 'document.rejected',
        message: `Credential document was rejected (${d.label})`,
        section: 'credentials',
        recordId: d.id,
        whyItMatters: 'Rejected evidence must be replaced before review completion.',
        recommendedAction: 'Upload a corrected document and request review.',
        responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER',
        priority: 'HIGH'
      });
    }
    if (d.expired) {
      expirationIssues.push({
        code: 'document.expired',
        message: `Credential document expired (${d.label})`,
        section: 'credentials',
        recordId: d.id,
        whyItMatters: 'Expired documents require renewal attention.',
        recommendedAction: 'Upload a current document with a valid expiration date.',
        responsibleRole: 'CLIENT_USER / EXTERNAL_PROVIDER',
        priority: 'HIGH'
      });
    }
    if (d.pending) {
      reviewIssues.push({
        code: 'document.pending_review',
        message: `Credential document is under review (${d.label})`,
        section: 'credentials',
        recordId: d.id,
        whyItMatters: 'Outstanding document reviews delay profile readiness.',
        recommendedAction: 'GPA reviewer completes document review.',
        responsibleRole: 'CREDENTIALING_SPECIALIST / MANAGER',
        priority: 'NORMAL'
      });
    }
  }

  for (const hi of historyDetail.issues) {
    if (hi.code.includes('.pending')) reviewIssues.push(hi);
  }

  const dimensions: ReadinessDimension[] = [
    dim(
      'identity',
      'Identity and demographic information',
      identityIssues.length ? 'INCOMPLETE' : 'COMPLETE',
      identityIssues,
      { hrefHint: 'personal' }
    ),
    dim(
      'specialty',
      'Specialty information',
      specialtyIssues.length ? 'INCOMPLETE' : 'COMPLETE',
      specialtyIssues,
      { hrefHint: 'personal' }
    ),
    dim(
      'professional_history',
      'Professional history',
      historyDetail.rejected
        ? 'REJECTED'
        : historyDetail.expired
          ? 'EXPIRED'
          : historyDetail.pending
            ? 'PENDING_REVIEW'
            : historyDetail.totalActive === 0
              ? 'INCOMPLETE'
              : 'COMPLETE',
      historyDetail.issues.filter((i) => !i.code.includes('.pending')),
      {
        hrefHint: 'history',
        counts: {
          total: historyDetail.totalActive,
          pending: historyDetail.pending,
          rejected: historyDetail.rejected,
          expired: historyDetail.expired,
          trustedEvidenceLinks: historyDetail.withTrustedEvidence,
          summaryEducation: historySummary.education,
          summaryBoard: historySummary.boardCertifications
        }
      }
    ),
    dim(
      'licenses',
      'License information',
      licenseRejected
        ? 'REJECTED'
        : licenseIncomplete || !licenses.length
          ? 'INCOMPLETE'
          : licenseExpired
            ? 'EXPIRED'
            : 'COMPLETE',
      licenseIssues,
      {
        hrefHint: 'licenses',
        counts: {
          total: licenses.length,
          incomplete: licenseIncomplete,
          rejected: licenseRejected,
          expired: licenseExpired
        }
      }
    ),
    dim(
      'license_verification',
      'License verification',
      licensePending
        ? 'PENDING_REVIEW'
        : licenseVerified > 0 && licensePending === 0 && licenseRejected === 0
          ? 'COMPLETE'
          : licenses.length
            ? 'ACTION_REQUIRED'
            : 'NOT_ASSESSED',
      licenseVerifyIssues,
      { hrefHint: 'licenses', counts: { verified: licenseVerified, pending: licensePending } }
    ),
    dim(
      'credential_evidence',
      'Credential evidence',
      evidenceIssues.length
        ? 'ACTION_REQUIRED'
        : completeness.counts.documentsTrusted > 0 || licenseVerified > 0
          ? 'COMPLETE'
          : completeness.counts.documentsTotal === 0
            ? 'NOT_ASSESSED'
            : 'INCOMPLETE',
      evidenceIssues,
      {
        hrefHint: 'credentials',
        counts: {
          trusted: completeness.counts.documentsTrusted,
          total: completeness.counts.documentsTotal
        }
      }
    ),
    dim(
      'document_trust',
      'Document trust/security',
      trustIssues.length ? 'ACTION_REQUIRED' : completeness.counts.documentsQuarantined === 0 ? 'COMPLETE' : 'ACTION_REQUIRED',
      trustIssues,
      {
        hrefHint: 'credentials',
        counts: { quarantined: completeness.counts.documentsQuarantined }
      }
    ),
    dim(
      'expiration_attention',
      'Expiration attention',
      expirationIssues.length ? 'EXPIRED' : 'COMPLETE',
      expirationIssues,
      { hrefHint: 'licenses' }
    ),
    dim(
      'outstanding_reviews',
      'Outstanding review decisions',
      reviewIssues.length || licensePending || historyDetail.pending
        ? 'PENDING_REVIEW'
        : 'COMPLETE',
      [
        ...reviewIssues,
        ...historyDetail.issues.filter((i) => i.code.includes('.pending'))
      ],
      {
        hrefHint: 'readiness',
        counts: {
          documentPending: reviewIssues.filter((i) => i.code.startsWith('document')).length,
          licensePending,
          historyPending: historyDetail.pending
        }
      }
    )
  ];

  // Deduplicate pending history issues that may appear in both professional_history and outstanding_reviews
  const overall = deriveOverall(dimensions);
  const allIssues = dimensions.flatMap((d) =>
    d.issues.map((issue) => ({ ...issue, dimension: d.key }))
  );

  const profileReview = review
    ? {
        id: review.id,
        status: review.status,
        startedAt: review.startedAt,
        completedAt: review.completedAt,
        correctionsRequestedAt: review.correctionsRequestedAt,
        resubmittedAt: review.resubmittedAt,
        clientVisibleNotes: review.clientVisibleNotes,
        ...(audience === 'gpa'
          ? { internalNotes: review.internalNotes, startedById: review.startedById, completedById: review.completedById }
          : {})
      }
    : null;

  return {
    providerId,
    tenantId,
    assessedAt: new Date().toISOString(),
    overall,
    disclaimer:
      'Operational readiness only. Does NOT mean payer-enrolled, payer-approved, Medicare/Medicaid enrolled, malpractice-adequate, state-board independently confirmed, or approved to practice.',
    dimensions,
    issues: allIssues,
    completenessLabels: completeness.labels,
    completenessCounts: completeness.counts,
    historySummary,
    profileReview,
    provider: {
      id: provider.id,
      firstName: provider.firstName,
      lastName: provider.lastName,
      npi: audience === 'gpa' ? provider.npi : provider.npi ? `${String(provider.npi).slice(0, 2)}****${String(provider.npi).slice(-2)}` : null,
      status: provider.status,
      updatedAt: provider.updatedAt,
      professionalType: provider.professionalType,
      primarySpecialty: provider.primarySpecialtyRef,
      secondarySpecialty: provider.secondarySpecialtyRef
    }
  };
}

export async function listTenantReadiness(
  tenantId: string,
  filters: {
    providerId?: string;
    overall?: string;
    specialtyId?: string;
    missingInformation?: boolean;
    pendingVerification?: boolean;
    expiredCredentials?: boolean;
    rejectedEvidence?: boolean;
    limit?: number;
    offset?: number;
  } = {}
) {
  const links = await prisma.tenantProvider.findMany({
    where: {
      tenantId,
      ...(filters.providerId ? { providerId: filters.providerId } : {})
    },
    select: { providerId: true },
    take: Math.min(filters.limit ?? 50, 100),
    skip: filters.offset ?? 0,
    orderBy: { updatedAt: 'desc' }
  });

  const results = [];
  for (const link of links) {
    const assessment = await assessProviderReadiness(tenantId, link.providerId, 'gpa');
    if (filters.specialtyId) {
      const match =
        assessment.provider.primarySpecialty?.id === filters.specialtyId
        || assessment.provider.secondarySpecialty?.id === filters.specialtyId;
      if (!match) continue;
    }
    if (filters.overall && assessment.overall !== filters.overall) continue;
    if (filters.missingInformation) {
      const hasIncomplete = assessment.dimensions.some((d) =>
        d.status === 'INCOMPLETE' || d.status === 'ACTION_REQUIRED'
      );
      if (!hasIncomplete) continue;
    }
    if (filters.pendingVerification && assessment.overall !== 'PENDING_VERIFICATION') {
      const pending = assessment.dimensions.some((d) => d.status === 'PENDING_REVIEW');
      if (!pending) continue;
    }
    if (filters.expiredCredentials) {
      const expired = assessment.dimensions.some((d) => d.status === 'EXPIRED');
      if (!expired) continue;
    }
    if (filters.rejectedEvidence) {
      const rejected = assessment.dimensions.some((d) => d.status === 'REJECTED')
        || assessment.issues.some((i) => /rejected/i.test(i.code));
      if (!rejected) continue;
    }
    results.push({
      providerId: assessment.providerId,
      provider: assessment.provider,
      overall: assessment.overall,
      dimensionStatuses: Object.fromEntries(assessment.dimensions.map((d) => [d.key, d.status])),
      issueCount: assessment.issues.length,
      assessedAt: assessment.assessedAt
    });
  }

  return {
    tenantId,
    count: results.length,
    items: results,
    disclaimer:
      'List reflects operational readiness only — not payer enrollment approval.'
  };
}
