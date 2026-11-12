import { DocumentSecurityStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Malware scanner abstraction (Phase 2C / security remediation H1–H4).
 * No scanner is active unless explicitly configured — never pretend otherwise.
 */
export function isMalwareScannerConfigured(): boolean {
  return Boolean(
    process.env.MALWARE_SCANNER_ENABLED === '1'
    || process.env.MALWARE_SCANNER_URL
  );
}

export type ScanResult =
  | { scanned: true; status: 'AVAILABLE' | 'REJECTED'; detail?: string }
  | { scanned: false; status: 'QUARANTINED'; reason: string };

export async function scanOrQuarantine(_input: {
  documentId: string;
  filePath: string;
}): Promise<ScanResult> {
  if (!isMalwareScannerConfigured()) {
    return {
      scanned: false,
      status: 'QUARANTINED',
      reason: 'Malware scanner is not configured. Document remains quarantined until authorized manual release.'
    };
  }
  // Placeholder for production scanner integration (e.g. HTTP call to MALWARE_SCANNER_URL).
  // Intentionally not implemented — configuration alone must not imply a working scanner.
  return {
    scanned: false,
    status: 'QUARANTINED',
    reason: 'MALWARE_SCANNER_ENABLED is set but no scanner adapter is implemented yet.'
  };
}

/** Quarantined / scanning / uploaded files are not trusted credentials. */
export function isTrustedForConversion(status: DocumentSecurityStatus): boolean {
  return status === DocumentSecurityStatus.AVAILABLE;
}

export function canProviderDownload(status: DocumentSecurityStatus): boolean {
  // Providers may only download their own files after release (AVAILABLE).
  return status === DocumentSecurityStatus.AVAILABLE;
}

/**
 * H4: Normal download path — only AVAILABLE (trusted) documents.
 * Quarantined/scanning/uploaded/rejected/deleted are never downloadable here.
 */
export function canNormalDownload(status: DocumentSecurityStatus | string): boolean {
  return status === DocumentSecurityStatus.AVAILABLE || status === 'AVAILABLE';
}

/** @deprecated Use canNormalDownload — kept name for older call sites during remediation. */
export function canStaffReviewDownload(status: DocumentSecurityStatus, _role: string): boolean {
  return canNormalDownload(status);
}

const INVESTIGATIVE_ROLES: Role[] = [
  Role.ADMIN,
  Role.CREDENTIALING_MANAGER,
  Role.APPROVER
];

export function canInvestigativeDownload(role: Role | string): boolean {
  return INVESTIGATIVE_ROLES.includes(role as Role);
}

const MANUAL_RELEASE_ROLES: Role[] = [
  Role.ADMIN,
  Role.CREDENTIALING_MANAGER,
  Role.APPROVER
];

export function canManualRelease(role: Role | string): boolean {
  return MANUAL_RELEASE_ROLES.includes(role as Role);
}

export const MANUAL_RELEASE_REASON_MIN = 12;

export async function archiveCurrentFileRevision(input: {
  documentId: string;
  storageKey: string | null;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  securityStatus: DocumentSecurityStatus;
  createdById?: string | null;
  reason?: string;
}) {
  if (!input.storageKey) return null;
  return prisma.documentFileRevision.create({
    data: {
      documentId: input.documentId,
      storageKey: input.storageKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      securityStatus: input.securityStatus,
      createdById: input.createdById || null,
      reason: input.reason || 'REPLACE'
    }
  });
}

export async function rejectDocument(documentId: string, actorId: string, reason: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) {
    const err: any = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { securityStatus: DocumentSecurityStatus.REJECTED, notes: reason }
  });
  if (doc.intakeRequestId) {
    await prisma.intakeEvent.create({
      data: {
        intakeId: doc.intakeRequestId,
        action: 'DOCUMENT_REJECTED',
        actorId,
        detail: { documentId, reason }
      }
    });
  }
  return updated;
}

/**
 * H3: Authorized manual release — not a malware scan pass.
 * Requires meaningful reason; records previous→new status.
 */
export async function releaseDocumentFromQuarantine(input: {
  documentId: string;
  actorId: string;
  role: Role | string;
  reason: string;
}) {
  if (!canManualRelease(input.role)) {
    const err: any = new Error('Insufficient permissions for manual document release');
    err.status = 403;
    throw err;
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < MANUAL_RELEASE_REASON_MIN) {
    const err: any = new Error(
      `Release reason is required (minimum ${MANUAL_RELEASE_REASON_MIN} characters). Manual release is not a malware scan.`
    );
    err.status = 400;
    err.code = 'RELEASE_REASON_REQUIRED';
    throw err;
  }

  const doc = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!doc) {
    const err: any = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  if (doc.securityStatus === DocumentSecurityStatus.DELETED) {
    const err: any = new Error('Document was deleted');
    err.status = 400;
    throw err;
  }
  if (doc.securityStatus === DocumentSecurityStatus.REJECTED) {
    const err: any = new Error('Rejected documents cannot be released through ordinary workflow');
    err.status = 400;
    err.code = 'REJECTED_NOT_RELEASABLE';
    throw err;
  }
  if (doc.securityStatus === DocumentSecurityStatus.AVAILABLE) {
    return doc;
  }

  const previousStatus = doc.securityStatus;
  const updated = await prisma.document.update({
    where: { id: input.documentId },
    data: { securityStatus: DocumentSecurityStatus.AVAILABLE }
  });

  if (doc.intakeRequestId) {
    await prisma.intakeEvent.create({
      data: {
        intakeId: doc.intakeRequestId,
        action: 'DOCUMENT_RELEASED',
        actorId: input.actorId,
        detail: {
          documentId: input.documentId,
          previousStatus,
          newStatus: DocumentSecurityStatus.AVAILABLE,
          reason,
          malwareScanned: false,
          note: 'Manual review release — not malware-scanned'
        }
      }
    });
  }

  return { ...updated, _releaseAudit: { previousStatus, reason, malwareScanned: false } };
}
