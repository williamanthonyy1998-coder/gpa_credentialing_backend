import { Role } from '@prisma/client';

export type DocumentAudience = 'gpa' | 'client' | 'provider';

export function documentAudienceForRole(role: Role | string | null | undefined): DocumentAudience {
  if (role === Role.EXTERNAL_PROVIDER || role === 'EXTERNAL_PROVIDER') return 'provider';
  if (role === Role.CLIENT_USER || role === 'CLIENT_USER') return 'client';
  return 'gpa';
}

/**
 * Audience-aware document / credential serializer (RT-02 / SEC-10).
 * Never expose storageKey, internal notes, or private filesystem references to clients/providers.
 */
export function sanitizeDocumentForAudience<T extends Record<string, any>>(
  row: T | null | undefined,
  roleOrAudience: Role | string | DocumentAudience | null | undefined
): (T & { hasFile?: boolean }) | null | undefined {
  if (!row || typeof row !== 'object') return row;
  const audience =
    roleOrAudience === 'gpa' || roleOrAudience === 'client' || roleOrAudience === 'provider'
      ? roleOrAudience
      : documentAudienceForRole(roleOrAudience);

  const out: any = { ...row };
  out.hasFile = Boolean(row.storageKey) || Boolean(row.hasFile);

  if (audience !== 'gpa') {
    // Clients/providers never receive filesystem keys or internal notes (RT-02).
    delete out.storageKey;
    delete out.notes;
    delete out.reviewerNotes;
    delete out.verifiedBy;
    delete out.verifiedById;
    delete out.internalNotes;
  }
  // GPA staff retain storageKey for existing UI affordances; clients cannot PATCH it (RT-01).
  return out;
}

export function stripClientWritableFileFields<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const out: any = { ...data };
  delete out.storageKey;
  delete out.originalName;
  delete out.mimeType;
  delete out.sizeBytes;
  delete out.securityStatus;
  delete out.uploadedAt;
  return out;
}
