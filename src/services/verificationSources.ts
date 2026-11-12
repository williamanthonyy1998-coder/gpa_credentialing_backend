/**
 * Phase 3D — Verification source classification.
 * Manual document review must never be labelled as automated state-board verification.
 */

export const VERIFICATION_SOURCES = [
  'manual_document_review',
  'manual_review', // alias retained for Phase 3B compatibility
  'direct_source_review',
  'external_api',
  'provider_submitted',
  'client_submitted',
  'imported_legacy',
  'source_unavailable'
] as const;

export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

const LABELS: Record<VerificationSource, string> = {
  manual_document_review: 'Manual document review (not state-board API)',
  manual_review: 'Manual document review (not state-board API)',
  direct_source_review: 'Direct authoritative source review by reviewer',
  external_api: 'External verification API (only when integration is configured)',
  provider_submitted: 'Provider-submitted information',
  client_submitted: 'Client-submitted information',
  imported_legacy: 'Imported legacy information',
  source_unavailable: 'Source evidence unavailable — limitation recorded'
};

export function normalizeVerificationSource(raw: string | null | undefined): VerificationSource {
  const s = String(raw || 'manual_document_review').trim().toLowerCase();
  if ((VERIFICATION_SOURCES as readonly string[]).includes(s)) return s as VerificationSource;
  // Reject misleading labels
  if (/state.?board|automated|nppes|api.?verif/i.test(s) && s !== 'external_api') {
    const err: any = new Error(
      'Cannot label verification as automated state-board verification without an external_api integration'
    );
    err.status = 400;
    err.code = 'INVALID_VERIFICATION_SOURCE';
    throw err;
  }
  return 'manual_document_review';
}

export function verificationSourceLabel(source: string | null | undefined) {
  const n = normalizeVerificationSource(source);
  return LABELS[n];
}

/** External API verification is only valid when a real integration is configured. */
export function assertExternalApiAllowed(source: VerificationSource) {
  if (source !== 'external_api') return;
  const configured = Boolean(process.env.EXTERNAL_LICENSE_VERIFY_URL || process.env.NPPES_VERIFY_ENABLED === '1');
  if (!configured) {
    const err: any = new Error(
      'external_api verification source is not configured. Use manual_document_review or direct_source_review.'
    );
    err.status = 400;
    err.code = 'EXTERNAL_VERIFY_NOT_CONFIGURED';
    throw err;
  }
}
