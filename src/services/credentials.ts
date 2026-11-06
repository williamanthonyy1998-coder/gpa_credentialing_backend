import { DocumentStatus } from '@prisma/client';

export const DOCUMENT_TYPES_BY_CATEGORY: Record<string, { type: string; required?: boolean; reporting?: boolean }[]> = {
  organization: [
    { type: 'Articles of Incorporation', required: true, reporting: false },
    { type: 'Operating Agreement', required: false, reporting: false }
  ],
  irs: [
    { type: 'W-9 Form', required: true, reporting: true },
    { type: 'IRS CP-575 / EIN Letter', required: true, reporting: false }
  ],
  licenses: [
    { type: 'Facility License', required: true, reporting: true },
    { type: 'CLIA Certificate', required: false, reporting: true }
  ],
  insurance: [
    { type: 'General Liability Insurance', required: true, reporting: true },
    { type: 'Professional Liability Insurance', required: true, reporting: true },
    { type: 'OIG / SAM Sanctions Check', required: true, reporting: false }
  ],
  accreditations: [
    { type: 'Accreditation Certificate', required: false, reporting: true },
    { type: 'Inspection Report', required: false, reporting: false }
  ],
  banking: [
    { type: 'Bank Letter', required: false, reporting: false },
    { type: 'Voided Check', required: true, reporting: true }
  ],
  agreements: [
    { type: 'Participation Agreement', required: false, reporting: false },
    { type: 'Business Associate Agreement', required: true, reporting: false }
  ],
  legal: [
    { type: 'Malpractice History', required: false, reporting: true },
    { type: 'Board Actions Disclosure', required: false, reporting: false }
  ],
  portals: [
    { type: 'CAQH Profile', required: false, reporting: true },
    { type: 'PECOS Enrollment', required: false, reporting: true }
  ]
};

export const DOCUMENT_CATEGORIES = [
  { key: 'organization', label: 'Organization Documents', types: DOCUMENT_TYPES_BY_CATEGORY.organization },
  { key: 'irs', label: 'IRS Documents', types: DOCUMENT_TYPES_BY_CATEGORY.irs },
  { key: 'licenses', label: 'Licenses, Certifications & Boards', types: DOCUMENT_TYPES_BY_CATEGORY.licenses },
  { key: 'insurance', label: 'Insurance and Sanctions Check', types: DOCUMENT_TYPES_BY_CATEGORY.insurance },
  { key: 'accreditations', label: 'Accreditations & Inspections', types: DOCUMENT_TYPES_BY_CATEGORY.accreditations },
  { key: 'banking', label: 'Banking', types: DOCUMENT_TYPES_BY_CATEGORY.banking },
  { key: 'agreements', label: 'Agreements & Contracts', types: DOCUMENT_TYPES_BY_CATEGORY.agreements },
  { key: 'legal', label: 'Legal & Regulatory', types: DOCUMENT_TYPES_BY_CATEGORY.legal },
  { key: 'portals', label: 'Portals', types: DOCUMENT_TYPES_BY_CATEGORY.portals }
] as const;

export type AttentionStatus = 'MISSING' | 'AVAILABLE' | 'EXPIRING_SOON' | 'EXPIRED';

export function computeCredentialAttention(doc: {
  status?: string | null;
  storageKey?: string | null;
  expiresAt?: Date | string | null;
  ignored?: boolean | null;
  required?: boolean | null;
  warningDays?: number | null;
}, now = new Date(), defaultWarningDays = 30): AttentionStatus {
  if (doc.ignored) return 'AVAILABLE';
  const hasFile = Boolean(doc.storageKey) || ['RECEIVED', 'UNDER_REVIEW', 'VERIFIED'].includes(String(doc.status || ''));
  if (!hasFile) {
    if (doc.required || doc.status === 'MISSING') return 'MISSING';
    return 'MISSING';
  }
  if (!doc.expiresAt) return 'AVAILABLE';
  const expires = new Date(doc.expiresAt);
  if (Number.isNaN(expires.getTime())) return 'AVAILABLE';
  if (expires.getTime() < now.getTime()) return 'EXPIRED';
  const warnDays = doc.warningDays && doc.warningDays > 0 ? doc.warningDays : defaultWarningDays;
  const soon = new Date(now);
  soon.setDate(soon.getDate() + warnDays);
  if (expires.getTime() <= soon.getTime()) return 'EXPIRING_SOON';
  return 'AVAILABLE';
}

export function mapAttentionToDocumentStatus(attention: AttentionStatus): DocumentStatus | null {
  if (attention === 'EXPIRED') return DocumentStatus.EXPIRED;
  if (attention === 'MISSING') return DocumentStatus.MISSING;
  return null;
}

export function withAttention<T extends Record<string, any>>(doc: T, now = new Date()) {
  const attention = computeCredentialAttention(doc, now);
  return { ...doc, attention };
}
