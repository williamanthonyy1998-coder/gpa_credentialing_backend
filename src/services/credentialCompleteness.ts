import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { computeCredentialAttention } from './credentials';
import { listProviderLicenses } from './licenseLifecycle';
import { DocumentSecurityStatus } from '@prisma/client';

/**
 * Explainable provider credential completeness (Phase 3B).
 * Distinguishes information complete vs evidence available vs verified vs expired.
 * Does NOT invent payer-specific requirements or claim "fully credentialed".
 */
export async function getProviderCredentialCompleteness(tenantId: string, providerId: string) {
  await assertProviderInTenant(tenantId, providerId);

  const licenses = await listProviderLicenses(tenantId, providerId, 'gpa');
  const docs = await prisma.document.findMany({
    where: {
      providerId,
      tenantId,
      securityStatus: { not: DocumentSecurityStatus.DELETED }
    },
    select: {
      id: true,
      title: true,
      category: true,
      type: true,
      status: true,
      securityStatus: true,
      storageKey: true,
      expiresAt: true,
      ignored: true,
      required: true,
      warningDays: true,
      verifiedAt: true
    },
    orderBy: { updatedAt: 'desc' }
  });

  const licenseItems = licenses.map((l: any) => ({
    id: l.id,
    kind: 'license' as const,
    label: `${l.licenseType?.name || l.type}${l.state ? ` (${l.state})` : ''}`,
    attention: l.attention,
    verificationStatus: l.verificationStatus,
    informationComplete: !['INCOMPLETE'].includes(l.attention),
    verified: l.verificationStatus === 'VERIFIED',
    expired: l.attention === 'EXPIRED',
    pending: l.attention === 'PENDING_REVIEW',
    rejected: l.attention === 'REJECTED'
  }));

  const docItems = docs.map((d) => {
    const attention = computeCredentialAttention(d);
    const evidenceAvailable =
      Boolean(d.storageKey) && d.securityStatus === DocumentSecurityStatus.AVAILABLE;
    const quarantined = d.securityStatus === DocumentSecurityStatus.QUARANTINED
      || d.securityStatus === DocumentSecurityStatus.SCANNING
      || d.securityStatus === DocumentSecurityStatus.UPLOADED;
    return {
      id: d.id,
      kind: 'document' as const,
      label: d.title || d.type,
      category: d.category,
      attention,
      securityStatus: d.securityStatus,
      informationComplete: Boolean(d.title && d.category),
      evidenceAvailable,
      trustedEvidence: evidenceAvailable,
      quarantined,
      verified: Boolean(d.verifiedAt) && evidenceAvailable,
      expired: attention === 'EXPIRED',
      pending: d.status === 'UNDER_REVIEW',
      rejected: d.status === 'REJECTED' || d.securityStatus === DocumentSecurityStatus.REJECTED
    };
  });

  const missing: string[] = [];
  if (!licenseItems.length) missing.push('No state/professional licenses on file');
  if (licenseItems.some((i) => !i.informationComplete)) missing.push('One or more licenses are incomplete');
  if (licenseItems.some((i) => i.pending)) missing.push('License(s) pending verification');
  if (licenseItems.some((i) => i.expired)) missing.push('Expired license(s)');
  if (licenseItems.some((i) => i.rejected)) missing.push('Rejected license(s)');
  if (docItems.some((i) => i.quarantined)) missing.push('Credential document(s) still quarantined (not trusted evidence)');
  if (docItems.some((i) => i.expired)) missing.push('Expired credential document(s)');
  if (docItems.some((i) => i.rejected)) missing.push('Rejected credential document(s)');

  const counts = {
    licensesTotal: licenseItems.length,
    licensesVerified: licenseItems.filter((i) => i.verified && !i.expired).length,
    licensesPending: licenseItems.filter((i) => i.pending).length,
    licensesExpired: licenseItems.filter((i) => i.expired).length,
    licensesRejected: licenseItems.filter((i) => i.rejected).length,
    documentsTotal: docItems.length,
    documentsTrusted: docItems.filter((i) => i.trustedEvidence).length,
    documentsQuarantined: docItems.filter((i) => i.quarantined).length,
    documentsExpired: docItems.filter((i) => i.expired).length,
    documentsRejected: docItems.filter((i) => i.rejected).length
  };

  return {
    providerId,
    tenantId,
    counts,
    unresolved: missing,
    labels: {
      informationComplete: missing.filter((m) => /incomplete|No state/i.test(m)).length === 0,
      evidenceAvailable: counts.documentsTrusted > 0 || counts.licensesVerified > 0,
      verified: counts.licensesVerified > 0 && counts.licensesPending === 0 && counts.licensesRejected === 0,
      hasExpired: counts.licensesExpired > 0 || counts.documentsExpired > 0
    },
    licenses: licenseItems,
    documents: docItems,
    disclaimer:
      'Completeness does not mean payer-enrolled, malpractice-adequate, or fully credentialed for contracting.'
  };
}

export async function getProviderLicenseBundle(tenantId: string, providerId: string, audience: 'gpa' | 'client' | 'provider') {
  const licenses = await listProviderLicenses(tenantId, providerId, audience);
  const completeness = audience === 'gpa'
    ? await getProviderCredentialCompleteness(tenantId, providerId)
    : null;
  return { licenses, completeness };
}
