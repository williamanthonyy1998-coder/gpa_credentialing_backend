import {
  DataQualityIssueStatus,
  DataQualitySeverity,
  DocumentSecurityStatus,
  HistoryVerificationStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant, requireTenantContext } from './tenantAccess';
import { validateNpi } from './npiValidation';
import { computeLicenseAttention, normalizeLicenseNumberKey, listProviderLicenses } from './licenseLifecycle';
import { getProviderCredentialCompleteness } from './credentialCompleteness';
import { listHistorySection } from './professionalHistory';
import { ProfessionalHistorySection } from '@prisma/client';
import { OPENISH } from './dataQualityIssues';

/**
 * Phase 3D — Credentialing QA evaluation & on-demand scan.
 * Reuses DataQualityIssue (fingerprint unique). Does NOT modify source records.
 * Does NOT auto-merge/delete/approve. Scan is GPA-initiated, not a scheduler.
 */

export type QaFindingDraft = {
  issueType: string;
  severity: DataQualitySeverity;
  directoryType: string;
  recordId?: string | null;
  relatedRecordId?: string | null;
  fingerprint: string;
  title: string;
  description?: string;
  details?: Record<string, unknown>;
  tenantId: string;
  /** When true, finding is informational and does not drive readiness changes by itself. */
  informationalOnly?: boolean;
};

const HISTORY_SECTIONS = Object.values(ProfessionalHistorySection);
const DEFAULT_PROVIDER_LIMIT = 100;

export function canRunCredentialingQa(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canAcceptQaRisk(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

function fp(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(':');
}

function draft(
  partial: Omit<QaFindingDraft, 'fingerprint'> & { fingerprint?: string },
  fingerprintParts: string[]
): QaFindingDraft {
  return {
    ...partial,
    fingerprint: partial.fingerprint || fp(fingerprintParts)
  };
}

/** Evaluate a single provider — read-only against source tables. */
export async function evaluateProviderCredentialingQa(
  tenantId: string,
  providerId: string
): Promise<{ findings: QaFindingDraft[]; recordsInspected: number }> {
  await assertProviderInTenant(tenantId, providerId);
  const findings: QaFindingDraft[] = [];
  let recordsInspected = 0;

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      npi: true,
      primarySpecialtyId: true,
      status: true
    }
  });
  recordsInspected += 1;
  if (!provider) return { findings, recordsInspected };

  const link = await prisma.tenantProvider.findUnique({
    where: { tenantId_providerId: { tenantId, providerId } }
  });
  const base = ['credqa', tenantId, providerId] as string[];

  if (!link) {
    findings.push(draft({
      issueType: 'BROKEN_RELATIONSHIP',
      severity: 'CRITICAL',
      directoryType: 'credentialing.providers',
      recordId: providerId,
      tenantId,
      title: 'Broken provider-to-tenant relationship',
      description: 'Provider is not linked via TenantProvider for this tenant',
      details: { providerId }
    }, [...base, 'broken_tenant_link']));
  }

  if (!provider.primarySpecialtyId) {
    findings.push(draft({
      issueType: 'MISSING_REQUIRED',
      severity: 'HIGH',
      directoryType: 'credentialing.providers',
      recordId: providerId,
      tenantId,
      title: 'Missing primary specialty',
      description: 'Provider has no primary specialty assigned',
      details: { providerId }
    }, [...base, 'missing_specialty']));
  }

  if (provider.npi) {
    const npi = validateNpi(provider.npi);
    if (!npi.ok) {
      findings.push(draft({
        issueType: 'NPI_INVALID',
        severity: 'HIGH',
        directoryType: 'credentialing.providers',
        recordId: providerId,
        tenantId,
        title: 'Invalid NPI checksum or format',
        description: npi.reason || 'NPI failed format/checksum validation',
        details: { providerId, validFormat: npi.validFormat, validChecksum: npi.validChecksum }
      }, [...base, 'npi_invalid']));
    }
  }

  // Licenses
  const licenses = await listProviderLicenses(tenantId, providerId, 'gpa', { includeArchived: true });
  recordsInspected += licenses.length;
  const activeKeys = new Map<string, string>();
  for (const l of licenses as any[]) {
    const details = { providerId };
    if (!l.type && !l.licenseTypeId) {
      findings.push(draft({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'credentialing.licenses',
        recordId: l.id,
        tenantId,
        title: 'License missing required type',
        description: 'License type is required',
        details
      }, [...base, l.id, 'license_type']));
    }
    if (!l.state && !l.usStateId) {
      findings.push(draft({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'credentialing.licenses',
        recordId: l.id,
        tenantId,
        title: 'License missing jurisdiction',
        description: 'Issuing jurisdiction is required',
        details
      }, [...base, l.id, 'license_jurisdiction']));
    }
    if (l.issuedAt && l.expiresAt && new Date(l.expiresAt) < new Date(l.issuedAt)) {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'CRITICAL',
        directoryType: 'credentialing.licenses',
        recordId: l.id,
        tenantId,
        title: 'Invalid license date sequence',
        description: 'Expiration date is before issue date',
        details
      }, [...base, l.id, 'license_dates']));
    }
    if (l.attention === 'EXPIRED' && l.status === 'VERIFIED' && l.verificationStatus === 'VERIFIED') {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'MEDIUM',
        directoryType: 'credentialing.licenses',
        recordId: l.id,
        tenantId,
        title: 'Expired license remains verified historically',
        description: 'License is expired; verification is historical only — attention should remain EXPIRED',
        informationalOnly: true,
        details
      }, [...base, l.id, 'expired_verified']));
    }
    if (l.verificationStatus === HistoryVerificationStatus.VERIFIED) {
      const events = await prisma.licenseEvent.count({
        where: { licenseId: l.id, action: 'VERIFIED' }
      });
      recordsInspected += 1;
      if (events === 0) {
        findings.push(draft({
          issueType: 'MISSING_REQUIRED',
          severity: 'HIGH',
          directoryType: 'credentialing.licenses',
          recordId: l.id,
          tenantId,
          title: 'Verified license missing verification event',
          description: 'Lifecycle expects a LicenseEvent VERIFIED entry for accountability',
          details
        }, [...base, l.id, 'missing_verify_event']));
      }
    }
    if (l.renewedFromId) {
      const prior = await prisma.license.findFirst({
        where: { id: l.renewedFromId, tenantId, providerId }
      });
      recordsInspected += 1;
      if (!prior) {
        findings.push(draft({
          issueType: 'INVALID_REFERENCE',
          severity: 'HIGH',
          directoryType: 'credentialing.licenses',
          recordId: l.id,
          relatedRecordId: l.renewedFromId,
          tenantId,
          title: 'Renewal points to invalid or unrelated license',
          description: 'renewedFromId is missing or outside this tenant/provider',
          details
        }, [...base, l.id, 'renewal_invalid']));
      }
    }
    if (!l.archived && l.attention !== 'ARCHIVED') {
      const key = [
        l.licenseTypeId || l.type || '',
        l.usStateId || l.state || '',
        normalizeLicenseNumberKey(l.number)
      ].join('|');
      if (normalizeLicenseNumberKey(l.number)) {
        const existing = activeKeys.get(key);
        if (existing) {
          findings.push(draft({
            issueType: 'DUPLICATE_EXACT',
            severity: 'HIGH',
            directoryType: 'credentialing.licenses',
            recordId: l.id,
            relatedRecordId: existing,
            tenantId,
            title: 'Duplicate active license candidate',
            description: 'Same type/jurisdiction/normalized number among non-archived licenses — human review required; not auto-merged',
            details
          }, [...base, 'dup_license', key]));
        } else {
          activeKeys.set(key, l.id);
        }
      }
    }
  }

  // Professional history
  for (const section of HISTORY_SECTIONS) {
    const rows = await listHistorySection(tenantId, providerId, section, 'gpa');
    recordsInspected += rows.length;
    for (const row of rows as any[]) {
      const archived = row.recordStatus === 'ARCHIVED' || row.status === 'ARCHIVED';
      if (archived) continue;
      if (row.startDate && row.endDate && new Date(row.endDate) < new Date(row.startDate)) {
        findings.push(draft({
          issueType: 'INCONSISTENT_STATUS',
          severity: 'HIGH',
          directoryType: 'credentialing.history',
          recordId: row.id,
          tenantId,
          title: `Invalid date range (${section})`,
          description: 'End date is before start date',
          details: { section, providerId }
        }, [...base, section, row.id, 'date_range']));
      }
      if (section === ProfessionalHistorySection.HOSPITAL_AFFILIATION && row.facilityId) {
        const fac = await prisma.facility.findFirst({
          where: { id: row.facilityId, organization: { tenantId } },
          select: { id: true }
        });
        recordsInspected += 1;
        if (!fac) {
          findings.push(draft({
            issueType: 'BROKEN_RELATIONSHIP',
            severity: 'CRITICAL',
            directoryType: 'credentialing.history',
            recordId: row.id,
            relatedRecordId: row.facilityId,
            tenantId,
            title: 'Cross-tenant or missing facility on hospital affiliation',
            description: 'Facility reference is outside this tenant',
            details: { providerId }
          }, [...base, row.id, 'cross_tenant_facility']));
        }
      }
      if (row.documentId) {
        const doc = await prisma.document.findUnique({
          where: { id: row.documentId },
          select: { id: true, tenantId: true, securityStatus: true, status: true }
        });
        recordsInspected += 1;
        if (!doc || doc.tenantId !== tenantId) {
          findings.push(draft({
            issueType: 'INVALID_REFERENCE',
            severity: 'HIGH',
            directoryType: 'credentialing.history',
            recordId: row.id,
            relatedRecordId: row.documentId,
            tenantId,
            title: 'History linked document missing or cross-tenant',
            details: { section, providerId }
          }, [...base, row.id, 'doc_missing']));
        } else if (
          doc.securityStatus === DocumentSecurityStatus.QUARANTINED
          || doc.securityStatus === DocumentSecurityStatus.SCANNING
          || doc.securityStatus === DocumentSecurityStatus.REJECTED
        ) {
          findings.push(draft({
            issueType: 'INCONSISTENT_STATUS',
            severity: 'HIGH',
            directoryType: 'credentialing.documents',
            recordId: doc.id,
            relatedRecordId: row.id,
            tenantId,
            title: 'History linked to untrusted/quarantined/rejected document',
            description: 'Quarantined or rejected documents cannot satisfy trusted evidence',
            details: { providerId }
          }, [...base, doc.id, 'history_untrusted_doc']));
        }
      }
      if (row.verificationStatus === HistoryVerificationStatus.VERIFIED) {
        const events = await prisma.professionalHistoryVerificationEvent.count({
          where: { tenantId, providerId, section, recordId: row.id, action: 'VERIFIED' }
        });
        recordsInspected += 1;
        if (events === 0) {
          findings.push(draft({
            issueType: 'MISSING_REQUIRED',
            severity: 'MEDIUM',
            directoryType: 'credentialing.history',
            recordId: row.id,
            tenantId,
            title: `Verified ${section} missing verification event`,
            informationalOnly: true,
            details: { providerId }
          }, [...base, section, row.id, 'missing_hist_event']));
        }
      }
    }
  }

  // Documents — completeness already excludes treating quarantine as trusted; flag contradictions if any
  const completeness = await getProviderCredentialCompleteness(tenantId, providerId);
  recordsInspected += completeness.documents.length;
  for (const d of completeness.documents) {
    if (d.quarantined && d.trustedEvidence) {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'CRITICAL',
        directoryType: 'credentialing.documents',
        recordId: d.id,
        tenantId,
        title: 'Quarantined document incorrectly marked trusted',
        description: 'Security status prevents trusted evidence use',
        details: { providerId }
      }, [...base, d.id, 'quarantine_trusted']));
    }
    if (d.rejected && d.trustedEvidence) {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'CRITICAL',
        directoryType: 'credentialing.documents',
        recordId: d.id,
        tenantId,
        title: 'Rejected document counted as available evidence',
        description: 'Rejected documents must not satisfy evidence availability',
        details: { providerId }
      }, [...base, d.id, 'rejected_trusted']));
    }
  }

  return { findings, recordsInspected };
}

async function upsertFindings(findings: QaFindingDraft[]) {
  let created = 0;
  let updated = 0;
  for (const f of findings) {
    const existing = await prisma.dataQualityIssue.findUnique({ where: { fingerprint: f.fingerprint } });
    const details = {
      ...(f.details || {}),
      informationalOnly: Boolean(f.informationalOnly),
      phase: '3D'
    };
    if (!existing) {
      await prisma.dataQualityIssue.create({
        data: {
          tenantId: f.tenantId,
          issueType: f.issueType as any,
          severity: f.severity,
          status: DataQualityIssueStatus.OPEN,
          directoryType: f.directoryType,
          recordId: f.recordId || null,
          relatedRecordId: f.relatedRecordId || null,
          fingerprint: f.fingerprint,
          title: f.title,
          description: f.description || null,
          details
        }
      });
      created += 1;
    } else if (OPENISH.includes(existing.status) || existing.status === DataQualityIssueStatus.REOPENED) {
      await prisma.dataQualityIssue.update({
        where: { id: existing.id },
        data: {
          title: f.title,
          description: f.description || null,
          severity: f.severity,
          issueType: f.issueType as any,
          details,
          recordId: f.recordId || existing.recordId,
          relatedRecordId: f.relatedRecordId || existing.relatedRecordId
        }
      });
      updated += 1;
    } else if (
      existing.status === DataQualityIssueStatus.RESOLVED
      || existing.status === DataQualityIssueStatus.ACCEPTED_LEGITIMATE
    ) {
      // Condition returned — reopen unless previously accepted as legitimate risk/false positive
      if (existing.status === DataQualityIssueStatus.RESOLVED) {
        await prisma.dataQualityIssue.update({
          where: { id: existing.id },
          data: {
            status: DataQualityIssueStatus.REOPENED,
            title: f.title,
            description: f.description || null,
            severity: f.severity,
            details,
            resolvedAt: null,
            resolvedById: null
          }
        });
        updated += 1;
      }
      // ACCEPTED_LEGITIMATE stays closed (accepted risk / false positive)
    }
  }
  return { created, updated };
}

/**
 * Phase 4E — enrollment / packet / submission / revalidation / follow-up integrity checks.
 * Read-only; does not mutate enrollment source records.
 */
export async function evaluateEnrollmentCredentialingQa(
  tenantId: string,
  opts: { limit?: number; offset?: number; providerId?: string } = {}
): Promise<{ findings: QaFindingDraft[]; recordsInspected: number }> {
  const findings: QaFindingDraft[] = [];
  let recordsInspected = 0;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const enrollments = await prisma.enrollmentApplication.findMany({
    where: {
      tenantId,
      ...(opts.providerId ? { providerId: opts.providerId } : {})
    },
    include: {
      packets: { orderBy: { version: 'desc' }, take: 1 },
      submissions: { orderBy: { attemptNumber: 'desc' }, take: 3 },
      revalidations: { where: { status: { notIn: ['COMPLETED', 'DENIED', 'CANCELLED'] as any } } },
      payerPlan: { select: { id: true, payerId: true, status: true } }
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    skip: offset
  });

  for (const e of enrollments) {
    recordsInspected += 1;
    const base = ['enrqa', tenantId, e.id];

    if (!e.providerId) {
      findings.push(draft({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'HIGH',
        directoryType: 'enrollment.integrity',
        recordId: e.id,
        tenantId,
        title: 'Enrollment missing provider relationship',
        description: e.applicationNo
      }, [...base, 'missing-provider']));
    } else {
      const link = await prisma.tenantProvider.findUnique({
        where: { tenantId_providerId: { tenantId, providerId: e.providerId } }
      });
      if (!link) {
        findings.push(draft({
          issueType: 'BROKEN_RELATIONSHIP',
          severity: 'CRITICAL',
          directoryType: 'enrollment.integrity',
          recordId: e.id,
          relatedRecordId: e.providerId,
          tenantId,
          title: 'Enrollment provider not linked to tenant'
        }, [...base, 'provider-tenant']));
      }
    }

    if (!e.payerPlanId || !e.payerPlan) {
      findings.push(draft({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'enrollment.integrity',
        recordId: e.id,
        tenantId,
        title: 'Enrollment missing payer plan'
      }, [...base, 'missing-plan']));
    }

    if (e.status === 'EFFECTIVE' && !e.effectiveAt) {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'HIGH',
        directoryType: 'enrollment.integrity',
        recordId: e.id,
        tenantId,
        title: 'EFFECTIVE enrollment missing effectiveAt'
      }, [...base, 'missing-effective']));
    }

    if (e.status === 'SUBMITTED' || e.status === 'ACKNOWLEDGED' || e.status === 'PAYER_REVIEW'
      || e.status === 'APPROVED' || e.status === 'EFFECTIVE') {
      const confirmed = e.submissions.find((s) => s.confirmationStatus === 'CONFIRMED');
      if (!confirmed && !e.submittedAt) {
        findings.push(draft({
          issueType: 'MISSING_REQUIRED',
          severity: 'MEDIUM',
          directoryType: 'enrollment.submission',
          recordId: e.id,
          tenantId,
          title: 'Lifecycle shows submitted path without confirmed submission metadata'
        }, [...base, 'missing-submission-meta']));
      }
      if (confirmed) {
        if (!confirmed.confirmedById || !confirmed.submittedAt) {
          findings.push(draft({
            issueType: 'INCONSISTENT_STATUS',
            severity: 'MEDIUM',
            directoryType: 'enrollment.submission',
            recordId: confirmed.id,
            relatedRecordId: e.id,
            tenantId,
            title: 'Confirmed submission missing actor or timestamp'
          }, [...base, 'submission-incomplete', confirmed.id]));
        }
        const latestPacket = e.packets[0];
        if (confirmed.packetVersion != null && latestPacket && confirmed.packetVersion !== latestPacket.version) {
          findings.push(draft({
            issueType: 'INCONSISTENT_STATUS',
            severity: 'LOW',
            directoryType: 'enrollment.packet',
            recordId: e.id,
            tenantId,
            title: 'Submission packet version differs from latest packet',
            details: { submittedVersion: confirmed.packetVersion, latestVersion: latestPacket.version },
            informationalOnly: true
          }, [...base, 'packet-version-drift']));
        }
      }
    }

    const latestPacket = e.packets[0];
    if (!latestPacket && ['READY_TO_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED', 'PAYER_REVIEW'].includes(e.status)) {
      findings.push(draft({
        issueType: 'MISSING_REQUIRED',
        severity: 'MEDIUM',
        directoryType: 'enrollment.packet',
        recordId: e.id,
        tenantId,
        title: 'Enrollment missing evaluated packet'
      }, [...base, 'missing-packet']));
    }
    if (latestPacket?.status === 'BLOCKED') {
      findings.push(draft({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'HIGH',
        directoryType: 'enrollment.packet',
        recordId: latestPacket.id,
        relatedRecordId: e.id,
        tenantId,
        title: 'Latest enrollment packet is BLOCKED (conflicts unresolved)'
      }, [...base, 'packet-blocked', latestPacket.id]));
    }

    // Duplicate active enrollments same provider+plan+facility
    if (e.providerId && e.payerPlanId) {
      const dups = await prisma.enrollmentApplication.count({
        where: {
          tenantId,
          providerId: e.providerId,
          payerPlanId: e.payerPlanId,
          facilityId: e.facilityId || undefined,
          status: { notIn: ['DENIED', 'WITHDRAWN', 'TERMINATED', 'CLOSED'] },
          id: { not: e.id }
        }
      });
      if (dups > 0) {
        findings.push(draft({
          issueType: 'DUPLICATE_POSSIBLE',
          severity: 'MEDIUM',
          directoryType: 'enrollment.integrity',
          recordId: e.id,
          tenantId,
          title: 'Possible duplicate active enrollment for same provider/plan/facility'
        }, [...base, 'dup-active']));
      }
    }

    if (e.revalidations.length > 1) {
      // Multiple active of same type already prevented; multiple different types OK — flag same type
      const byType = new Map<string, number>();
      for (const r of e.revalidations) byType.set(r.revalidationType, (byType.get(r.revalidationType) || 0) + 1);
      for (const [t, n] of byType) {
        if (n > 1) {
          findings.push(draft({
            issueType: 'DUPLICATE_EXACT',
            severity: 'HIGH',
            directoryType: 'enrollment.revalidation',
            recordId: e.id,
            tenantId,
            title: `Duplicate active revalidations of type ${t}`
          }, [...base, 'dup-reval', t]));
        }
      }
    }

    for (const r of e.revalidations) {
      if (r.status === 'COMPLETED' && !r.evidenceDocumentId) {
        findings.push(draft({
          issueType: 'MISSING_REQUIRED',
          severity: 'HIGH',
          directoryType: 'enrollment.revalidation',
          recordId: r.id,
          relatedRecordId: e.id,
          tenantId,
          title: 'Completed revalidation missing evidence document'
        }, [...base, 'reval-evidence', r.id]));
      }
      if (r.dueDate && !r.dueDateSource) {
        findings.push(draft({
          issueType: 'MISSING_REQUIRED',
          severity: 'LOW',
          directoryType: 'enrollment.revalidation',
          recordId: r.id,
          tenantId,
          title: 'Revalidation due date missing source classification',
          informationalOnly: true
        }, [...base, 'reval-source', r.id]));
      }
    }

    // Terminal enrollments with open follow-ups
    if (['DENIED', 'WITHDRAWN', 'TERMINATED', 'CLOSED'].includes(e.status)) {
      const openFu = await prisma.task.count({
        where: {
          tenantId,
          enrollmentId: e.id,
          source: 'ENROLLMENT_FOLLOWUP',
          status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }
        }
      });
      if (openFu > 0) {
        findings.push(draft({
          issueType: 'INCONSISTENT_STATUS',
          severity: 'MEDIUM',
          directoryType: 'enrollment.followup',
          recordId: e.id,
          tenantId,
          title: 'Terminal enrollment still has open follow-up tasks'
        }, [...base, 'terminal-open-fu']));
      }
    }
  }

  // Overdue open follow-ups (tenant sample)
  const overdueFu = await prisma.task.findMany({
    where: {
      tenantId,
      source: 'ENROLLMENT_FOLLOWUP',
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      dueAt: { lt: new Date() }
    },
    select: { id: true, enrollmentId: true, fingerprint: true },
    take: 100
  });
  recordsInspected += overdueFu.length;
  for (const t of overdueFu) {
    findings.push(draft({
      issueType: 'INCONSISTENT_STATUS',
      severity: 'MEDIUM',
      directoryType: 'enrollment.followup',
      recordId: t.id,
      relatedRecordId: t.enrollmentId,
      tenantId,
      title: 'Overdue open enrollment follow-up',
      informationalOnly: true
    }, ['enrqa', tenantId, 'fu-overdue', t.id]));
  }

  return { findings, recordsInspected };
}

/**
 * On-demand tenant-scoped credentialing QA scan.
 * Does not modify provider/license/history/document source rows.
 */
export async function runCredentialingQaScan(input: {
  tenantId: string;
  actorId: string;
  role: Role;
  providerId?: string;
  limit?: number;
  offset?: number;
  persist?: boolean;
}) {
  if (!canRunCredentialingQa(input.role)) {
    const err: any = new Error('Your role cannot run credentialing QA scans');
    err.status = 403;
    throw err;
  }
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PROVIDER_LIMIT, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const scan = await prisma.credentialingQaScan.create({
    data: {
      tenantId: input.tenantId,
      startedById: input.actorId,
      status: 'RUNNING',
      summary: { limit, offset, providerId: input.providerId || null }
    }
  });

  try {
    const links = input.providerId
      ? [{ providerId: input.providerId }]
      : await prisma.tenantProvider.findMany({
          where: { tenantId: input.tenantId },
          select: { providerId: true },
          orderBy: { updatedAt: 'desc' },
          take: limit,
          skip: offset
        });

    if (input.providerId) {
      await assertProviderInTenant(input.tenantId, input.providerId);
    }

    const allFindings: QaFindingDraft[] = [];
    let recordsInspected = 0;
    for (const link of links) {
      const result = await evaluateProviderCredentialingQa(input.tenantId, link.providerId);
      allFindings.push(...result.findings);
      recordsInspected += result.recordsInspected;
    }

    // Phase 4E — enrollment / packet / submission / revalidation / follow-up integrity (read-only)
    if (!input.providerId) {
      const enrQa = await evaluateEnrollmentCredentialingQa(input.tenantId, { limit: Math.min(limit, 100), offset });
      allFindings.push(...enrQa.findings);
      recordsInspected += enrQa.recordsInspected;
    } else {
      const enrQa = await evaluateEnrollmentCredentialingQa(input.tenantId, {
        limit: 50,
        offset: 0,
        providerId: input.providerId
      });
      allFindings.push(...enrQa.findings);
      recordsInspected += enrQa.recordsInspected;
    }

    let persistence = { created: 0, updated: 0 };
    if (input.persist !== false) {
      persistence = await upsertFindings(allFindings);
    }

    const bySeverity = {
      CRITICAL: allFindings.filter((f) => f.severity === 'CRITICAL').length,
      HIGH: allFindings.filter((f) => f.severity === 'HIGH').length,
      MEDIUM: allFindings.filter((f) => f.severity === 'MEDIUM').length,
      LOW: allFindings.filter((f) => f.severity === 'LOW').length
    };

    const totalProviders = await prisma.tenantProvider.count({ where: { tenantId: input.tenantId } });
    const incomplete = offset + links.length < totalProviders && !input.providerId;

    const updated = await prisma.credentialingQaScan.update({
      where: { id: scan.id },
      data: {
        status: incomplete ? 'PARTIAL' : 'COMPLETED',
        completedAt: new Date(),
        recordsInspected,
        providersInspected: links.length,
        findingsCreated: persistence.created,
        findingsUpdated: persistence.updated,
        findingsBySeverity: bySeverity,
        summary: {
          limit,
          offset,
          nextOffset: incomplete ? offset + links.length : null,
          totalProviders,
          findingCount: allFindings.length,
          persist: input.persist !== false,
          note: 'Scan does not modify source credential records. Not payer approval.'
        }
      }
    });

    return {
      scan: updated,
      findings: allFindings.map((f) => ({
        ...f,
        // Never expose storage paths
        details: f.details ? { ...f.details, storageKey: undefined } : undefined
      })),
      disclaimer:
        'Credentialing QA scan is operational only. Manual verification is not automated state-board verification. Not payer enrollment approval.'
    };
  } catch (e: any) {
    await prisma.credentialingQaScan.update({
      where: { id: scan.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: String(e?.message || 'Scan failed').slice(0, 500)
      }
    });
    throw e;
  }
}

export async function getCredentialingQaDashboard(tenantId: string) {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400000);
  const in90 = new Date(now.getTime() + 90 * 86400000);

  const [
    providersTotal,
    licensesPending,
    licensesRejected,
    licensesExpired,
    licensesExpiring30,
    licensesExpiring90,
    historyPending,
    historyRejected,
    docsQuarantined,
    docsRejected,
    openGaps,
    openQaIssues,
    reviewsAwaiting,
    incompleteSpecialty
  ] = await Promise.all([
    prisma.tenantProvider.count({ where: { tenantId } }),
    prisma.license.count({
      where: { tenantId, verificationStatus: 'PENDING_REVIEW', archived: false }
    }),
    prisma.license.count({
      where: { tenantId, verificationStatus: 'REJECTED', archived: false }
    }),
    prisma.license.count({
      where: { tenantId, expiresAt: { lt: now }, archived: false }
    }),
    prisma.license.count({
      where: {
        tenantId,
        archived: false,
        expiresAt: { gte: now, lt: in30 }
      }
    }),
    prisma.license.count({
      where: {
        tenantId,
        archived: false,
        expiresAt: { gte: now, lt: in90 }
      }
    }),
    // Approximate pending history across sections
    Promise.all([
      prisma.providerEducation.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerResidency.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerFellowship.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerBoardCertification.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerProfessionalCertification.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerEmployment.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerHospitalAffiliation.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } }),
      prisma.providerMalpracticePolicy.count({ where: { tenantId, verificationStatus: 'PENDING_REVIEW' } })
    ]).then((xs) => xs.reduce((a, b) => a + b, 0)),
    Promise.all([
      prisma.providerEducation.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerResidency.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerFellowship.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerBoardCertification.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerProfessionalCertification.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerEmployment.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerHospitalAffiliation.count({ where: { tenantId, verificationStatus: 'REJECTED' } }),
      prisma.providerMalpracticePolicy.count({ where: { tenantId, verificationStatus: 'REJECTED' } })
    ]).then((xs) => xs.reduce((a, b) => a + b, 0)),
    prisma.document.count({
      where: {
        tenantId,
        securityStatus: { in: ['QUARANTINED', 'SCANNING', 'UPLOADED'] as any }
      }
    }),
    prisma.document.count({
      where: {
        tenantId,
        OR: [{ status: 'REJECTED' }, { securityStatus: 'REJECTED' }]
      }
    }),
    prisma.task.count({
      where: {
        tenantId,
        source: 'CREDENTIALING_GAP',
        status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }
      }
    }),
    prisma.dataQualityIssue.count({
      where: {
        tenantId,
        directoryType: { startsWith: 'credentialing.' },
        status: { in: OPENISH }
      }
    }),
    prisma.providerProfileReview.count({
      where: {
        tenantId,
        status: { in: ['IN_PROGRESS', 'CORRECTIONS_REQUESTED', 'RESUBMITTED'] }
      }
    }),
    prisma.tenantProvider.count({
      where: {
        tenantId,
        provider: { primarySpecialtyId: null }
      }
    })
  ]);

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    counts: {
      providersTotal,
      incompleteProfiles: incompleteSpecialty,
      pendingLicenseVerification: licensesPending,
      rejectedLicenses: licensesRejected,
      expiredLicenses: licensesExpired,
      licensesExpiring30,
      licensesExpiring90,
      pendingHistoryVerification: historyPending,
      rejectedHistory: historyRejected,
      quarantinedDocuments: docsQuarantined,
      rejectedDocuments: docsRejected,
      openCredentialingGaps: openGaps,
      openQaFindings: openQaIssues,
      reviewsAwaitingAction: reviewsAwaiting,
      missingTrustedEvidenceHint: docsQuarantined + docsRejected
    },
    disclaimer:
      'QA dashboard counts are operational. Not payer approval. Malware scanner and expiration schedulers remain inactive unless separately configured.'
  };
}

/**
 * Resolve a credentialing QA finding only after re-evaluating underlying data.
 * Accepted risk / false positive require elevated GPA roles and do not require condition cleared.
 */
export async function resolveCredentialingQaFinding(input: {
  issueId: string;
  tenantId: string;
  actorId: string;
  role: Role;
  mode: 'RESOLVED' | 'ACCEPTED_RISK' | 'FALSE_POSITIVE';
  notes?: string | null;
}) {
  const issue = await prisma.dataQualityIssue.findUnique({ where: { id: input.issueId } });
  if (!issue || issue.tenantId !== input.tenantId) {
    const err: any = new Error('Finding not found');
    err.status = 404;
    throw err;
  }
  if (!String(issue.directoryType || '').startsWith('credentialing.')) {
    const err: any = new Error('Not a credentialing QA finding');
    err.status = 400;
    throw err;
  }

  if (input.mode === 'ACCEPTED_RISK' || input.mode === 'FALSE_POSITIVE') {
    if (!canAcceptQaRisk(input.role)) {
      const err: any = new Error('Only authorized GPA roles may accept risk or mark false positive');
      err.status = 403;
      throw err;
    }
    return prisma.dataQualityIssue.update({
      where: { id: issue.id },
      data: {
        status: DataQualityIssueStatus.ACCEPTED_LEGITIMATE,
        resolutionNotes: [
          input.mode,
          input.notes || ''
        ].filter(Boolean).join(': ').slice(0, 2000),
        resolvedAt: new Date(),
        resolvedById: input.actorId
      }
    });
  }

  // RESOLVED — re-run evaluation for related provider
  // Fingerprint format: credqa:{tenantId}:{providerId}:...
  const fpParts = String(issue.fingerprint || '').split(':');
  const providerIdFromFp = fpParts[0] === 'credqa' ? fpParts[2] : null;
  const providerId =
    (issue.details as any)?.providerId
    || providerIdFromFp
    || (issue.directoryType === 'credentialing.providers' ? issue.recordId : null)
    || (
      issue.directoryType === 'credentialing.licenses' && issue.recordId
        ? (await prisma.license.findFirst({
            where: { id: issue.recordId, tenantId: input.tenantId },
            select: { providerId: true }
          }))?.providerId
        : null
    );

  if (!providerId) {
    const err: any = new Error('Unable to re-evaluate finding without provider context');
    err.status = 409;
    err.code = 'QA_REEVAL_CONTEXT';
    throw err;
  }

  const { findings } = await evaluateProviderCredentialingQa(input.tenantId, providerId);
  const stillPresent = findings.some((f) => f.fingerprint === issue.fingerprint);
  if (stillPresent) {
    const err: any = new Error('Finding cannot be resolved while the underlying issue remains');
    err.status = 409;
    err.code = 'QA_STILL_OPEN';
    throw err;
  }

  return prisma.dataQualityIssue.update({
    where: { id: issue.id },
    data: {
      status: DataQualityIssueStatus.RESOLVED,
      resolutionNotes: input.notes || 'Underlying condition cleared on re-evaluation',
      resolvedAt: new Date(),
      resolvedById: input.actorId
    }
  });
}

export async function listCredentialingQaScans(tenantId: string, opts: { limit?: number } = {}) {
  return prisma.credentialingQaScan.findMany({
    where: { tenantId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(opts.limit ?? 20, 50)
  });
}

// silence unused import warning for requireTenantContext in this module
void requireTenantContext;
void computeLicenseAttention;
