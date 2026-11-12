import { DocumentSecurityStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { getHistorySummary } from './professionalHistory';
import { getProviderCredentialCompleteness } from './credentialCompleteness';
import { listProviderLicenses } from './licenseLifecycle';
import { assessProviderReadiness, type ReadinessAudience } from './credentialingReadiness';
import { listCredentialingGaps, syncCredentialingGaps } from './credentialingGaps';
import { getProfileReview } from './profileReview';
import { computeCredentialAttention } from './credentials';

/**
 * Unified provider credentialing profile — aggregates Phase 3A/3B data.
 * Does not duplicate license/history/document models.
 */
export async function getUnifiedCredentialingProfile(
  tenantId: string,
  providerId: string,
  audience: ReadinessAudience,
  opts: { syncGaps?: boolean; actorId?: string | null } = {}
) {
  await assertProviderInTenant(tenantId, providerId);

  const [
    provider,
    tenantLink,
    orgs,
    practices,
    facilities,
    historySummary,
    licenses,
    completeness,
    review
  ] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        npi: true,
        email: true,
        status: true,
        professionalType: true,
        updatedAt: true,
        createdAt: true,
        primarySpecialtyId: true,
        secondarySpecialtyId: true,
        primarySpecialtyRef: { select: { id: true, name: true, code: true } },
        secondarySpecialtyRef: { select: { id: true, name: true, code: true } }
      }
    }),
    prisma.tenantProvider.findUnique({
      where: { tenantId_providerId: { tenantId, providerId } },
      select: { createdAt: true, updatedAt: true }
    }),
    prisma.providerOrganization.findMany({
      where: { providerId, organization: { tenantId } },
      include: { organization: { select: { id: true, legalName: true, dba: true, status: true } } }
    }),
    prisma.providerPractice.findMany({
      where: { providerId, practice: { organization: { tenantId } } },
      include: { practice: { select: { id: true, name: true, organizationId: true } } }
    }),
    prisma.providerFacility.findMany({
      where: { providerId, facility: { organization: { tenantId } } },
      include: { facility: { select: { id: true, name: true, organizationId: true } } }
    }),
    getHistorySummary(tenantId, providerId),
    listProviderLicenses(tenantId, providerId, audience),
    getProviderCredentialCompleteness(tenantId, providerId),
    getProfileReview(tenantId, providerId, audience)
  ]);

  if (!provider || !tenantLink) {
    const err: any = new Error('Provider not found in tenant');
    err.status = 404;
    throw err;
  }

  const readiness = await assessProviderReadiness(tenantId, providerId, audience);
  if (opts.syncGaps) {
    await syncCredentialingGaps(tenantId, providerId, opts.actorId, audience);
  }
  const gaps = await listCredentialingGaps(tenantId, providerId, { includeResolved: false });

  const documents = completeness.documents.map((d) => ({
    id: d.id,
    title: d.label,
    category: d.category,
    securityStatus: d.securityStatus,
    attention: d.attention,
    trustedEvidence: d.trustedEvidence,
    quarantined: d.quarantined,
    verified: d.verified,
    expired: d.expired,
    pending: d.pending,
    rejected: d.rejected,
    // Never generate public file URLs here.
    downloadAuthorizedViaCredentialsApi: true
  }));

  const credentialSummary = {
    profileInformation: readiness.dimensions.find((d) => d.key === 'identity')?.status,
    professionalHistory: readiness.dimensions.find((d) => d.key === 'professional_history')?.status,
    licenses: readiness.dimensions.find((d) => d.key === 'licenses')?.status,
    credentialDocuments: readiness.dimensions.find((d) => d.key === 'credential_evidence')?.status,
    verification: readiness.dimensions.find((d) => d.key === 'license_verification')?.status,
    expirationAttention: readiness.dimensions.find((d) => d.key === 'expiration_attention')?.status,
    outstandingReviews: readiness.dimensions.find((d) => d.key === 'outstanding_reviews')?.status
  };

  return {
    tenantId,
    provider: {
      id: provider.id,
      firstName: provider.firstName,
      middleName: provider.middleName,
      lastName: provider.lastName,
      npi:
        audience === 'gpa'
          ? provider.npi
          : provider.npi
            ? `${String(provider.npi).slice(0, 2)}****${String(provider.npi).slice(-2)}`
            : null,
      email: provider.email,
      status: provider.status,
      professionalType: provider.professionalType,
      primarySpecialty: provider.primarySpecialtyRef,
      secondarySpecialty: provider.secondarySpecialtyRef,
      updatedAt: provider.updatedAt,
      createdAt: provider.createdAt
    },
    ownership: {
      tenantId,
      linkedAt: tenantLink.createdAt,
      linkUpdatedAt: tenantLink.updatedAt
    },
    relationships: {
      organizations: orgs.map((o) => o.organization),
      practices: practices.map((p) => p.practice),
      facilities: facilities.map((f) => f.facility)
    },
    credentialingSummary: credentialSummary,
    readiness: {
      overall: readiness.overall,
      dimensions: readiness.dimensions,
      disclaimer: readiness.disclaimer,
      assessedAt: readiness.assessedAt
    },
    professionalHistory: historySummary,
    licenses,
    documents,
    gaps,
    profileReview: review,
    completeness: {
      labels: completeness.labels,
      counts: completeness.counts,
      unresolved: completeness.unresolved,
      disclaimer: completeness.disclaimer
    },
    disclaimer:
      'Unified credentialing profile is an operational view. Completeness and readiness do not mean payer enrollment approved or fully credentialed for a payer.'
  };
}

/** Lightweight consistency checks — explain only; never auto-merge/delete. */
export async function runProfileConsistencyChecks(tenantId: string, providerId: string) {
  await assertProviderInTenant(tenantId, providerId);
  const findings: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    recordId?: string;
    section?: string;
  }> = [];

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { primarySpecialtyId: true }
  });
  if (!provider?.primarySpecialtyId) {
    findings.push({
      code: 'no_primary_specialty',
      severity: 'warning',
      message: 'Provider has no primary specialty',
      section: 'specialty'
    });
  }

  const licenses = await listProviderLicenses(tenantId, providerId, 'gpa');
  for (const l of licenses as any[]) {
    if (!l.state && !l.usStateId) {
      findings.push({
        code: 'license_missing_jurisdiction',
        severity: 'error',
        message: 'License is missing required jurisdiction',
        recordId: l.id,
        section: 'licenses'
      });
    }
    if (l.issuedAt && l.expiresAt && new Date(l.expiresAt) < new Date(l.issuedAt)) {
      findings.push({
        code: 'license_date_inconsistent',
        severity: 'error',
        message: 'License expiration is before issue date',
        recordId: l.id,
        section: 'licenses'
      });
    }
  }

  const docs = await prisma.document.findMany({
    where: {
      tenantId,
      providerId,
      securityStatus: { not: DocumentSecurityStatus.DELETED },
      verifiedAt: { not: null }
    },
    select: { id: true, title: true, securityStatus: true, storageKey: true }
  });
  for (const d of docs) {
    const attention = computeCredentialAttention(d as any);
    if (d.securityStatus !== DocumentSecurityStatus.AVAILABLE || !d.storageKey) {
      findings.push({
        code: 'verified_points_to_untrusted',
        severity: 'error',
        message: `Verified credential document is not trusted evidence (${d.title || d.id})`,
        recordId: d.id,
        section: 'credentials'
      });
    }
    void attention;
  }

  // Cross-tenant facility on hospital affiliation
  const affiliations = await prisma.providerHospitalAffiliation.findMany({
    where: { tenantId, providerId, facilityId: { not: null } },
    select: { id: true, facilityId: true }
  });
  for (const a of affiliations) {
    if (!a.facilityId) continue;
    const fac = await prisma.facility.findFirst({
      where: { id: a.facilityId, organization: { tenantId } },
      select: { id: true }
    });
    if (!fac) {
      findings.push({
        code: 'cross_tenant_facility',
        severity: 'error',
        message: 'Hospital affiliation references a facility outside this tenant',
        recordId: a.id,
        section: 'hospital_affiliation'
      });
    }
  }

  return { providerId, tenantId, findings };
}
