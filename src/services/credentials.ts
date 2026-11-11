import { DocumentStatus, Prisma, Role } from '@prisma/client';
import { decryptField, encryptField, maskLast4 } from '../lib/fieldCrypto';

export const WARNING_DAY_OPTIONS = [30, 60, 90, 120] as const;
export type WarningDays = (typeof WARNING_DAY_OPTIONS)[number];

export const INSURANCE_LIABILITY_TYPES = [
  'General Liability Insurance',
  'Professional Liability Insurance'
] as const;

export const BANKING_CREDENTIAL_TYPES = [
  'Bank Letter',
  'Voided Check'
] as const;

export const BANK_ACCOUNT_TYPE_OPTIONS = ['Checking', 'Savings', 'Other'] as const;

export function isInsuranceLiabilityType(type?: string | null): boolean {
  return INSURANCE_LIABILITY_TYPES.includes(type as any);
}

export function isBankingCredentialType(type?: string | null): boolean {
  return BANKING_CREDENTIAL_TYPES.includes(type as any);
}

export function supportsCredentialAssociations(type?: string | null, category?: string | null): boolean {
  return isInsuranceLiabilityType(type) || isBankingCredentialType(type) || category === 'insurance' || category === 'banking';
}

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
    { type: 'Inspection Report', required: false, reporting: false },
    { type: 'Site Survey', required: false, reporting: true }
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
  ],
  // Custom / ad-hoc facility credentials — types are user-defined at create time.
  other: []
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
  { key: 'portals', label: 'Portals', types: DOCUMENT_TYPES_BY_CATEGORY.portals },
  { key: 'other', label: 'Other Documents', types: DOCUMENT_TYPES_BY_CATEGORY.other }
] as const;

export const OTHER_DOCUMENTS_CATEGORY = 'other' as const;
export const AGREEMENTS_CATEGORY = 'agreements' as const;
export const IRS_CATEGORY = 'irs' as const;

export function isOtherDocumentsCategory(category?: string | null): boolean {
  return category === OTHER_DOCUMENTS_CATEGORY;
}

export function isAgreementsCategory(category?: string | null): boolean {
  return category === AGREEMENTS_CATEGORY;
}

export function isIrsCategory(category?: string | null): boolean {
  return category === IRS_CATEGORY;
}

export type AttentionStatus = 'MISSING' | 'AVAILABLE' | 'EXPIRING_SOON' | 'EXPIRED' | 'IGNORED';

export function computeCredentialAttention(doc: {
  status?: string | null;
  storageKey?: string | null;
  expiresAt?: Date | string | null;
  ignored?: boolean | null;
  required?: boolean | null;
  warningDays?: number | null;
}, now = new Date(), defaultWarningDays = 30): AttentionStatus {
  if (doc.ignored) return 'IGNORED';
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

export function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function canViewFullBanking(role?: Role | null): boolean {
  // Full routing only for roles that manage banking credentials; list endpoints still force-mask.
  return ([
    Role.ADMIN,
    Role.CREDENTIALING_MANAGER,
    Role.CREDENTIALING_SPECIALIST,
    Role.ENROLLMENT_SPECIALIST
  ] as Role[]).includes(role as Role);
}

/** Encrypt sensitive banking fields before persistence. Never log the plaintext. */
export function encryptBankingFieldsForStorage<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const out: any = { ...data };
  if ('bankRoutingNumber' in out) {
    out.bankRoutingNumber = encryptField(out.bankRoutingNumber);
  }
  return out;
}

/**
 * Decrypt + mask banking fields for API responses.
 * Full routing values only for ADMIN / CREDENTIALING_MANAGER.
 * List views should pass maskAlways=true to force masking even for privileged roles.
 */
export function presentBankingFields<T extends Record<string, any>>(
  doc: T,
  role?: Role | null,
  opts?: { maskAlways?: boolean }
): T {
  if (!doc || typeof doc !== 'object') return doc;
  const out: any = { ...doc };
  if (!('bankRoutingNumber' in out) && !isBankingCredentialType(out.type) && out.category !== 'banking') {
    return out;
  }
  const decrypted = decryptField(out.bankRoutingNumber);
  const showFull = !opts?.maskAlways && canViewFullBanking(role);
  if (decrypted) {
    out.bankRoutingNumberMasked = maskLast4(decrypted, '••••');
    out.bankRoutingNumber = showFull ? decrypted : out.bankRoutingNumberMasked;
  } else if (out.bankRoutingNumber) {
    // Could not decrypt; never leak ciphertext
    out.bankRoutingNumberMasked = '••••';
    out.bankRoutingNumber = showFull ? null : '••••';
  }
  return out;
}

export function serializeCredential<T extends Record<string, any>>(
  doc: T,
  now = new Date(),
  role?: Role | null,
  opts?: { maskAlways?: boolean }
) {
  const attention = computeCredentialAttention(doc, now);
  const facilities = (doc.documentFacilities || []).map((link: any) => link.facility).filter(Boolean);
  const providers = (doc.documentProviders || []).map((link: any) => link.provider).filter(Boolean);
  const base = {
    ...doc,
    perOccurrence: decimalToNumber(doc.perOccurrence),
    aggregate: decimalToNumber(doc.aggregate),
    facilities,
    providers,
    facilityIds: (doc.documentFacilities || []).map((l: any) => l.facilityId ?? l.facility?.id).filter(Boolean),
    providerIds: (doc.documentProviders || []).map((l: any) => l.providerId ?? l.provider?.id).filter(Boolean),
    attention
  };
  return presentBankingFields(base, role, opts);
}

export function withAttention<T extends Record<string, any>>(
  doc: T,
  now = new Date(),
  role?: Role | null,
  opts?: { maskAlways?: boolean }
) {
  return serializeCredential(doc, now, role, opts);
}

export const credentialInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
  organization: { select: { id: true, legalName: true } },
  practice: { select: { id: true, name: true } },
  facility: { select: { id: true, name: true } },
  provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
  documentFacilities: { include: { facility: { select: { id: true, name: true, organizationId: true } } } },
  documentProviders: { include: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } } } }
} as const;
