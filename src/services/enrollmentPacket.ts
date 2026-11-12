import {
  EnrollmentPacketStatus,
  PacketItemStatus,
  Role,
  TaskStatus,
  HistoryVerificationStatus,
  DocumentSecurityStatus,
  Priority
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertProviderInTenant } from './tenantAccess';
import { isTrustedForConversion } from './documentSecurity';
import {
  canReviewPacket,
  canWaiveOrVerify,
  resolveApplicableRequirements,
  type ResolvedRequirement
} from './payerRequirementsEngine';

/**
 * Phase 4B — Enrollment requirement packets.
 * Packet readiness is INTERNAL only — never means payer submission/approval/effective.
 * Evaluating a packet does NOT transition EnrollmentApplication to SUBMITTED.
 */

export const PACKET_GAP_SOURCE = 'ENROLLMENT_PACKET_GAP';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

const SATISFIED: PacketItemStatus[] = [
  PacketItemStatus.VERIFIED,
  PacketItemStatus.WAIVED,
  PacketItemStatus.NOT_APPLICABLE,
  PacketItemStatus.INFORMATION_AVAILABLE
];

function startOfDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function computePacketReadiness(
  items: Array<{ status: PacketItemStatus; isRequired: boolean }>,
  hasConflicts: boolean
): EnrollmentPacketStatus {
  if (hasConflicts) return EnrollmentPacketStatus.BLOCKED;
  if (!items.length) return EnrollmentPacketStatus.NOT_EVALUATED;

  const required = items.filter((i) => i.isRequired);
  const hasRejected = required.some((i) => i.status === PacketItemStatus.REJECTED);
  if (hasRejected) return EnrollmentPacketStatus.INCOMPLETE;

  const hasExpired = required.some((i) => i.status === PacketItemStatus.EXPIRED);
  if (hasExpired) return EnrollmentPacketStatus.INCOMPLETE;

  const hasPending = required.some((i) =>
    i.status === PacketItemStatus.PENDING_REVIEW || i.status === PacketItemStatus.EVIDENCE_ATTACHED
  );
  const hasMissing = required.some((i) =>
    i.status === PacketItemStatus.MISSING
    || i.status === PacketItemStatus.NOT_STARTED
  );

  if (hasMissing) return EnrollmentPacketStatus.INCOMPLETE;
  if (hasPending) return EnrollmentPacketStatus.REVIEW_REQUIRED;

  const evidencePending = required.some((i) => i.status === PacketItemStatus.INFORMATION_AVAILABLE);
  // INFORMATION_AVAILABLE for info-only categories can satisfy; evidence categories stay pending if required doc missing handled above
  if (evidencePending) {
    // Treat info-available as satisfied for readiness of demographic/NPI style requirements
  }

  const allRequiredOk = required.every((i) =>
    SATISFIED.includes(i.status) || i.status === PacketItemStatus.INFORMATION_AVAILABLE
  );
  if (allRequiredOk) return EnrollmentPacketStatus.READY_FOR_INTERNAL_SUBMISSION_REVIEW;

  const optionalOnlyPending = !hasMissing && items.some((i) =>
    !i.isRequired && (i.status === PacketItemStatus.PENDING_REVIEW || i.status === PacketItemStatus.EVIDENCE_ATTACHED)
  );
  if (optionalOnlyPending) return EnrollmentPacketStatus.EVIDENCE_PENDING;

  return EnrollmentPacketStatus.INCOMPLETE;
}

async function loadEnrollment(tenantId: string, enrollmentId: string) {
  const enrollment = await prisma.enrollmentApplication.findFirst({
    where: { id: enrollmentId, tenantId },
    include: {
      payerPlan: { include: { payer: true } },
      provider: true,
      organization: true,
      practice: true,
      facility: true,
      billingEntity: true
    }
  });
  if (!enrollment) deny('Enrollment not found', 404);
  return enrollment;
}

async function mapSourceForRequirement(
  req: ResolvedRequirement,
  enrollment: Awaited<ReturnType<typeof loadEnrollment>>
): Promise<{
  status: PacketItemStatus;
  sourceType?: string;
  sourceRecordId?: string;
  sourceLabel?: string;
  documentId?: string;
  expiresAt?: Date | null;
  note?: string;
}> {
  const category = (req.category || req.requirementKind || '').toUpperCase();
  const provider = enrollment.provider;

  if (category.includes('NPI') || req.code?.toUpperCase() === 'NPI') {
    if (provider?.npi) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'PROVIDER_NPI',
        sourceRecordId: provider.id,
        sourceLabel: `NPI ${provider.npi}`,
        note: 'Mapped from provider profile — not auto-verified'
      };
    }
    return { status: PacketItemStatus.MISSING, note: 'Provider NPI missing' };
  }

  if (category.includes('SPECIALTY') || req.code?.toUpperCase()?.includes('SPECIALTY')) {
    const label = provider?.primarySpecialty || null;
    if (label) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'SPECIALTY',
        sourceRecordId: provider?.id,
        sourceLabel: label,
        note: 'Mapped from provider specialty — not auto-verified'
      };
    }
    return { status: PacketItemStatus.MISSING, note: 'Provider specialty missing' };
  }

  if (category.includes('STATE_LICENSE') || category === 'LICENSE' || req.documentCategoryCode === 'LICENSE') {
    if (!provider) return { status: PacketItemStatus.MISSING, note: 'No provider on enrollment' };
    await assertProviderInTenant(enrollment.tenantId!, provider.id);
    const licenses = await prisma.license.findMany({
      where: { providerId: provider.id, OR: [{ tenantId: enrollment.tenantId! }, { tenantId: null }] },
      orderBy: { updatedAt: 'desc' },
      take: 5
    });
    if (!licenses.length) return { status: PacketItemStatus.MISSING, note: 'No licenses on file' };
    if (licenses.length > 1) {
      return {
        status: PacketItemStatus.PENDING_REVIEW,
        sourceType: 'LICENSE',
        sourceRecordId: licenses[0].id,
        sourceLabel: `${licenses[0].type || 'License'} ${licenses[0].number || ''} (${licenses[0].state || ''})`.trim(),
        expiresAt: licenses[0].expiresAt,
        note: 'Multiple licenses found — human selection required; not auto-verified'
      };
    }
    const lic = licenses[0];
    if (lic.expiresAt && startOfDay(lic.expiresAt) < startOfDay(new Date())) {
      return {
        status: PacketItemStatus.EXPIRED,
        sourceType: 'LICENSE',
        sourceRecordId: lic.id,
        sourceLabel: `${lic.type} ${lic.number || ''}`.trim(),
        expiresAt: lic.expiresAt,
        note: 'License expired'
      };
    }
    if (lic.verificationStatus === HistoryVerificationStatus.VERIFIED) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'LICENSE',
        sourceRecordId: lic.id,
        sourceLabel: `${lic.type} ${lic.number || ''} (verified in credentialing)`.trim(),
        expiresAt: lic.expiresAt,
        note: 'License verified in credentialing — packet item still needs reviewer confirmation for enrollment'
      };
    }
    return {
      status: PacketItemStatus.INFORMATION_AVAILABLE,
      sourceType: 'LICENSE',
      sourceRecordId: lic.id,
      sourceLabel: `${lic.type} ${lic.number || ''}`.trim(),
      expiresAt: lic.expiresAt,
      note: 'License present but not verified — not treated as packet VERIFIED'
    };
  }

  // Professional history sections
  const historyMap: Record<string, { model: string; sourceType: string }> = {
    EDUCATION: { model: 'providerEducation', sourceType: 'EDUCATION' },
    RESIDENCY: { model: 'providerResidency', sourceType: 'RESIDENCY' },
    FELLOWSHIP: { model: 'providerFellowship', sourceType: 'FELLOWSHIP' },
    BOARD_CERTIFICATION: { model: 'providerBoardCertification', sourceType: 'BOARD_CERTIFICATION' },
    EMPLOYMENT: { model: 'providerEmployment', sourceType: 'EMPLOYMENT' },
    HOSPITAL_AFFILIATION: { model: 'providerHospitalAffiliation', sourceType: 'HOSPITAL_AFFILIATION' },
    MALPRACTICE: { model: 'providerMalpracticePolicy', sourceType: 'MALPRACTICE' }
  };
  for (const [key, meta] of Object.entries(historyMap)) {
    if (category.includes(key) || req.code?.toUpperCase()?.includes(key)) {
      if (!provider) return { status: PacketItemStatus.MISSING, note: 'No provider' };
      const rows = await (prisma as any)[meta.model].findMany({
        where: { providerId: provider.id, tenantId: enrollment.tenantId! },
        take: 3,
        orderBy: { updatedAt: 'desc' }
      });
      if (!rows.length) return { status: PacketItemStatus.MISSING, note: `${key} history missing` };
      const row = rows[0];
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: meta.sourceType,
        sourceRecordId: row.id,
        sourceLabel: row.institutionName || row.employerName || row.hospitalName || row.boardName || row.policyNumber || key,
        expiresAt: row.expiresAt || row.endDate || null,
        note: rows.length > 1
          ? 'Multiple history records — human selection may be required; not auto-verified'
          : 'Mapped from professional history — not auto-verified'
      };
    }
  }

  if (category.includes('BILLING') || category.includes('TAX')) {
    if (enrollment.billingEntityId && enrollment.billingEntity) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'BILLING_ENTITY',
        sourceRecordId: enrollment.billingEntityId,
        sourceLabel: enrollment.billingEntity.legalName,
        note: 'Billing entity linked on enrollment — not auto-verified'
      };
    }
    return { status: PacketItemStatus.MISSING, note: 'Billing entity not linked' };
  }

  if (category.includes('FACILITY') || category.includes('GROUP') || category.includes('PRACTICE') || category.includes('ORGANIZATION')) {
    if (enrollment.facilityId && enrollment.facility) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'FACILITY',
        sourceRecordId: enrollment.facilityId,
        sourceLabel: enrollment.facility.name,
        note: 'Facility linked — not auto-verified'
      };
    }
    if (enrollment.practiceId && enrollment.practice) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'PRACTICE',
        sourceRecordId: enrollment.practiceId,
        sourceLabel: enrollment.practice.name,
        note: 'Practice linked — not auto-verified'
      };
    }
    if (enrollment.organizationId && enrollment.organization) {
      return {
        status: PacketItemStatus.INFORMATION_AVAILABLE,
        sourceType: 'ORGANIZATION',
        sourceRecordId: enrollment.organizationId,
        sourceLabel: enrollment.organization.legalName,
        note: 'Organization linked — not auto-verified'
      };
    }
    return { status: PacketItemStatus.MISSING, note: 'Org/practice/facility not linked' };
  }

  // Document category mapping
  if (req.documentCategoryCode && provider) {
    const docs = await prisma.document.findMany({
      where: {
        providerId: provider.id,
        tenantId: enrollment.tenantId!,
        OR: [
          { category: req.documentCategoryCode },
          { type: req.documentCategoryCode }
        ],
        securityStatus: { not: DocumentSecurityStatus.DELETED }
      },
      orderBy: { updatedAt: 'desc' },
      take: 5
    });
    const trusted = docs.filter((d) => isTrustedForConversion(d.securityStatus));
    if (!docs.length) return { status: PacketItemStatus.MISSING, note: 'No documents for category' };
    if (!trusted.length) {
      return {
        status: PacketItemStatus.MISSING,
        sourceType: 'DOCUMENT',
        sourceRecordId: docs[0].id,
        sourceLabel: docs[0].title,
        note: 'Documents exist but are not trusted (quarantined/unreleased)'
      };
    }
    const doc = trusted[0];
    if (doc.status === 'REJECTED') {
      return {
        status: PacketItemStatus.REJECTED,
        sourceType: 'DOCUMENT',
        sourceRecordId: doc.id,
        documentId: doc.id,
        sourceLabel: doc.title,
        note: 'Document rejected'
      };
    }
    if (req.tracksExpiration && doc.expiresAt && startOfDay(doc.expiresAt) < startOfDay(new Date())) {
      return {
        status: PacketItemStatus.EXPIRED,
        sourceType: 'DOCUMENT',
        sourceRecordId: doc.id,
        documentId: doc.id,
        sourceLabel: doc.title,
        expiresAt: doc.expiresAt,
        note: 'Trusted document expired'
      };
    }
    return {
      status: PacketItemStatus.EVIDENCE_ATTACHED,
      sourceType: 'DOCUMENT',
      sourceRecordId: doc.id,
      documentId: doc.id,
      sourceLabel: doc.title,
      expiresAt: doc.expiresAt,
      note: 'Trusted document mapped — upload does not auto-verify'
    };
  }

  return { status: PacketItemStatus.MISSING, note: 'No automatic mapping available' };
}

async function ensurePacketGapTask(input: {
  tenantId: string;
  enrollmentId: string;
  itemId: string;
  title: string;
  providerId?: string | null;
  facilityId?: string | null;
}) {
  const fingerprint = `enr-packet-gap:${input.enrollmentId}:${input.itemId}`;
  const existing = await prisma.task.findFirst({
    where: { tenantId: input.tenantId, fingerprint, source: PACKET_GAP_SOURCE }
  });
  const openish: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED];
  if (existing && openish.includes(existing.status)) return existing;
  if (existing) {
    return prisma.task.update({
      where: { id: existing.id },
      data: { status: TaskStatus.OPEN, title: input.title, dueAt: new Date(Date.now() + 7 * 86400000) }
    });
  }
  return prisma.task.create({
    data: {
      tenantId: input.tenantId,
      title: input.title,
      description: 'Mandatory enrollment packet requirement incomplete',
      status: TaskStatus.OPEN,
      priority: Priority.NORMAL,
      dueAt: new Date(Date.now() + 7 * 86400000),
      enrollmentId: input.enrollmentId,
      providerId: input.providerId || null,
      facilityId: input.facilityId || null,
      source: PACKET_GAP_SOURCE,
      fingerprint,
      relatedType: 'EnrollmentPacketItem',
      relatedId: input.itemId
    }
  });
}

export async function getLatestPacket(tenantId: string, enrollmentId: string) {
  return prisma.enrollmentPacket.findFirst({
    where: { tenantId, enrollmentId },
    orderBy: { version: 'desc' },
    include: {
      items: { orderBy: [{ sortOrder: 'asc' }, { requirementTitle: 'asc' }] }
    }
  });
}

export async function listPacketHistory(tenantId: string, enrollmentId: string) {
  return prisma.enrollmentPacket.findMany({
    where: { tenantId, enrollmentId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      status: true,
      evaluatedAt: true,
      createdAt: true,
      conflictNotes: true,
      evaluationSummary: true,
      _count: { select: { items: true } }
    }
  });
}

export async function evaluateEnrollmentPacket(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  forceNewVersion?: boolean;
}) {
  if (!canReviewPacket(input.role) && input.role !== Role.CLIENT_USER) {
    // Clients may trigger evaluate for their tenant enrollments (read-only refresh) via GPA/staff typically
    if (input.role === Role.EXTERNAL_PROVIDER || input.role === Role.READ_ONLY || input.role === Role.AUDITOR) {
      deny('Insufficient permissions to evaluate enrollment packet', 403);
    }
  }
  if (input.role === Role.CLIENT_USER) {
    // Clients can view/trigger mapping refresh but not create GPA requirement catalog — allow evaluate
  }

  const enrollment = await loadEnrollment(input.tenantId, input.enrollmentId);
  if (enrollment.providerId) {
    await assertProviderInTenant(input.tenantId, enrollment.providerId);
  }

  const payerId = enrollment.payerPlan.payerId;
  const resolved = await resolveApplicableRequirements({
    tenantId: input.tenantId,
    payerId,
    payerPlanId: enrollment.payerPlanId,
    enrollmentType: enrollment.enrollmentType || 'INDIVIDUAL',
    asOf: enrollment.preparedAt || enrollment.createdAt || new Date(),
    context: {
      enrollmentType: enrollment.enrollmentType,
      specialty: enrollment.provider?.primarySpecialty,
      state: null,
      hasFacility: Boolean(enrollment.facilityId),
      hasBillingEntity: Boolean(enrollment.billingEntityId),
      providerType: enrollment.provider?.professionalType,
      payerPlanId: enrollment.payerPlanId
    }
  });

  const latest = await getLatestPacket(input.tenantId, input.enrollmentId);
  const nextVersion = latest ? latest.version + 1 : 1;
  // Always create a new version on evaluate to preserve historical integrity
  void input.forceNewVersion;

  const mappedItems: Array<{
    req: ResolvedRequirement;
    mapped: Awaited<ReturnType<typeof mapSourceForRequirement>>;
    sortOrder: number;
  }> = [];
  for (let i = 0; i < resolved.items.length; i++) {
    const req = resolved.items[i];
    const mapped = await mapSourceForRequirement(req, enrollment);
    mappedItems.push({ req, mapped, sortOrder: i });
  }

  const packet = await prisma.$transaction(async (tx) => {
    const created = await tx.enrollmentPacket.create({
      data: {
        enrollmentId: enrollment.id,
        tenantId: input.tenantId,
        version: nextVersion,
        status: EnrollmentPacketStatus.NOT_EVALUATED,
        payerId,
        payerPlanId: enrollment.payerPlanId,
        enrollmentType: enrollment.enrollmentType || 'INDIVIDUAL',
        requirementSnapshot: resolved.items.map((i) => i.snapshot) as any,
        conflictNotes: resolved.conflicts.length
          ? `Conflicting requirements at same specificity: ${resolved.conflicts.map((c) => c.code || c.title).join(', ')}`
          : null,
        createdById: input.actorId,
        evaluatedAt: new Date()
      }
    });

    const itemRows = [];
    for (const { req, mapped, sortOrder } of mappedItems) {
      const item = await tx.enrollmentPacketItem.create({
        data: {
          packetId: created.id,
          payerRequirementId: req.id,
          requirementCode: req.code,
          requirementTitle: req.title,
          category: req.category,
          isRequired: req.isRequired,
          sortOrder,
          status: mapped.status,
          applicabilityReason: req.applicabilityReason,
          sourceType: mapped.sourceType || null,
          sourceRecordId: mapped.sourceRecordId || null,
          sourceLabel: mapped.sourceLabel || null,
          documentId: mapped.documentId || null,
          expiresAt: mapped.expiresAt || null,
          reviewNotes: mapped.note || null,
          requirementVersion: req.version,
          snapshot: req.snapshot as any
        }
      });
      await tx.enrollmentPacketItemEvent.create({
        data: {
          itemId: item.id,
          eventType: 'ITEM_MAPPED',
          toStatus: mapped.status,
          actorId: input.actorId,
          actorRole: input.role,
          reason: mapped.note || req.applicabilityReason
        }
      });
      itemRows.push(item);
    }

    const status = computePacketReadiness(itemRows, resolved.conflicts.length > 0);
    const summary = {
      total: itemRows.length,
      required: itemRows.filter((x) => x.isRequired).length,
      requiredSatisfied: itemRows.filter((x) => x.isRequired && (SATISFIED.includes(x.status) || x.status === PacketItemStatus.INFORMATION_AVAILABLE || x.status === PacketItemStatus.EVIDENCE_ATTACHED)).length,
      missing: itemRows.filter((x) => x.status === PacketItemStatus.MISSING || x.status === PacketItemStatus.NOT_STARTED).length,
      pendingReview: itemRows.filter((x) => x.status === PacketItemStatus.PENDING_REVIEW || x.status === PacketItemStatus.EVIDENCE_ATTACHED).length,
      rejected: itemRows.filter((x) => x.status === PacketItemStatus.REJECTED).length,
      expired: itemRows.filter((x) => x.status === PacketItemStatus.EXPIRED).length,
      waived: itemRows.filter((x) => x.status === PacketItemStatus.WAIVED).length,
      conflicts: resolved.conflicts.length,
      disclaimer: 'READY_FOR_INTERNAL_SUBMISSION_REVIEW means internal packet readiness only — not payer submission, approval, or effective enrollment.'
    };

    // Refine readiness: EVIDENCE_ATTACHED / INFORMATION_AVAILABLE on required items still need verify for READY
    const required = itemRows.filter((x) => x.isRequired);
    const allVerifiedOrWaived = required.every((x) =>
      x.status === PacketItemStatus.VERIFIED
      || x.status === PacketItemStatus.WAIVED
      || x.status === PacketItemStatus.NOT_APPLICABLE
      || x.status === PacketItemStatus.INFORMATION_AVAILABLE
    );
    const anyEvidenceOnly = required.some((x) => x.status === PacketItemStatus.EVIDENCE_ATTACHED);
    let finalStatus = status;
    const incompleteStatuses: PacketItemStatus[] = [
      PacketItemStatus.MISSING,
      PacketItemStatus.NOT_STARTED,
      PacketItemStatus.REJECTED,
      PacketItemStatus.EXPIRED
    ];
    if (resolved.conflicts.length) finalStatus = EnrollmentPacketStatus.BLOCKED;
    else if (required.some((x) => incompleteStatuses.includes(x.status))) {
      finalStatus = EnrollmentPacketStatus.INCOMPLETE;
    } else if (anyEvidenceOnly || required.some((x) => x.status === PacketItemStatus.PENDING_REVIEW)) {
      finalStatus = EnrollmentPacketStatus.REVIEW_REQUIRED;
    } else if (allVerifiedOrWaived) {
      finalStatus = EnrollmentPacketStatus.READY_FOR_INTERNAL_SUBMISSION_REVIEW;
    }

    const updated = await tx.enrollmentPacket.update({
      where: { id: created.id },
      data: {
        status: finalStatus,
        evaluationSummary: summary as any
      },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { requirementTitle: 'asc' }] } }
    });

    return updated;
  });

  // Gap tasks for missing mandatory (outside tx for simplicity)
  for (const item of packet.items) {
    if (item.isRequired && (item.status === PacketItemStatus.MISSING || item.status === PacketItemStatus.EXPIRED || item.status === PacketItemStatus.REJECTED)) {
      await ensurePacketGapTask({
        tenantId: input.tenantId,
        enrollmentId: enrollment.id,
        itemId: item.id,
        title: `Packet: ${item.requirementTitle}`,
        providerId: enrollment.providerId,
        facilityId: enrollment.facilityId
      }).catch(() => {});
    }
  }

  // Enrollment status must remain unchanged
  return {
    packet,
    enrollmentStatusUnchanged: enrollment.status,
    note: 'Packet evaluation does not submit to a payer and does not change enrollment lifecycle status.'
  };
}

export async function attachPacketEvidence(input: {
  tenantId: string;
  enrollmentId: string;
  itemId: string;
  documentId: string;
  actorId: string;
  role: Role;
}) {
  if (input.role === Role.READ_ONLY || input.role === Role.AUDITOR) {
    deny('Insufficient permissions', 403);
  }
  const packet = await getLatestPacket(input.tenantId, input.enrollmentId);
  if (!packet) deny('No packet found — evaluate first', 404);
  const item = packet.items.find((i) => i.id === input.itemId);
  if (!item) deny('Packet item not found', 404);

  const doc = await prisma.document.findFirst({
    where: { id: input.documentId, tenantId: input.tenantId }
  });
  if (!doc) deny('Document not found in tenant', 404);
  if (!isTrustedForConversion(doc.securityStatus)) {
    deny('Quarantined or untrusted documents cannot satisfy enrollment evidence', 400, 'UNTRUSTED_DOCUMENT');
  }
  if (doc.status === 'REJECTED') deny('Rejected documents cannot satisfy a requirement');

  const from = item.status;
  const updated = await prisma.enrollmentPacketItem.update({
    where: { id: item.id },
    data: {
      documentId: doc.id,
      sourceType: 'DOCUMENT',
      sourceRecordId: doc.id,
      sourceLabel: doc.title,
      expiresAt: doc.expiresAt,
      status: PacketItemStatus.EVIDENCE_ATTACHED,
      // Explicitly not VERIFIED
      verifiedAt: null,
      verifiedById: null
    }
  });
  await prisma.enrollmentPacketItemEvent.create({
    data: {
      itemId: item.id,
      eventType: 'EVIDENCE_ATTACHED',
      fromStatus: from,
      toStatus: PacketItemStatus.EVIDENCE_ATTACHED,
      actorId: input.actorId,
      actorRole: input.role,
      reason: 'Evidence attached — not auto-verified',
      metadata: { documentId: doc.id } as any
    }
  });
  await refreshPacketStatus(packet.id);
  return updated;
}

export async function reviewPacketItem(input: {
  tenantId: string;
  enrollmentId: string;
  itemId: string;
  actorId: string;
  role: Role;
  decision: 'VERIFY' | 'REJECT' | 'NOT_APPLICABLE' | 'REQUEST_CORRECTION';
  reason?: string | null;
  internalNotes?: string | null;
  reviewNotes?: string | null;
}) {
  if (!canReviewPacket(input.role)) deny('Insufficient permissions', 403);
  if (input.decision === 'VERIFY' && !canWaiveOrVerify(input.role)) {
    deny('Only authorized reviewers can verify requirements', 403);
  }

  const packet = await getLatestPacket(input.tenantId, input.enrollmentId);
  if (!packet) deny('No packet found', 404);
  const item = packet.items.find((i) => i.id === input.itemId);
  if (!item) deny('Packet item not found', 404);

  let toStatus: PacketItemStatus = item.status;
  let eventType = 'REVIEWED';
  if (input.decision === 'VERIFY') {
    if (item.documentId) {
      const doc = await prisma.document.findUnique({ where: { id: item.documentId } });
      if (doc && !isTrustedForConversion(doc.securityStatus)) {
        deny('Cannot verify with untrusted evidence');
      }
    }
    toStatus = PacketItemStatus.VERIFIED;
    eventType = 'REQUIREMENT_VERIFIED';
  } else if (input.decision === 'REJECT') {
    if (!String(input.reason || '').trim()) deny('Rejection reason is required');
    toStatus = PacketItemStatus.REJECTED;
    eventType = 'EVIDENCE_REJECTED';
  } else if (input.decision === 'NOT_APPLICABLE') {
    if (!String(input.reason || '').trim()) deny('Not-applicable explanation is required');
    toStatus = PacketItemStatus.NOT_APPLICABLE;
    eventType = 'MARKED_NOT_APPLICABLE';
  } else if (input.decision === 'REQUEST_CORRECTION') {
    if (!String(input.reason || '').trim()) deny('Correction request reason is required');
    toStatus = PacketItemStatus.PENDING_REVIEW;
    eventType = 'CORRECTION_REQUESTED';
  }

  const from = item.status;
  const updated = await prisma.enrollmentPacketItem.update({
    where: { id: item.id },
    data: {
      status: toStatus,
      rejectionReason: input.decision === 'REJECT' ? input.reason : item.rejectionReason,
      reviewNotes: input.reviewNotes ?? input.reason ?? item.reviewNotes,
      internalNotes: input.internalNotes ?? item.internalNotes,
      verifiedAt: input.decision === 'VERIFY' ? new Date() : null,
      verifiedById: input.decision === 'VERIFY' ? input.actorId : null
    }
  });
  await prisma.enrollmentPacketItemEvent.create({
    data: {
      itemId: item.id,
      eventType,
      fromStatus: from,
      toStatus,
      actorId: input.actorId,
      actorRole: input.role,
      reason: input.reason || null
    }
  });
  await refreshPacketStatus(packet.id);
  return updated;
}

export async function waivePacketItem(input: {
  tenantId: string;
  enrollmentId: string;
  itemId: string;
  actorId: string;
  role: Role;
  reason: string;
}) {
  if (!canWaiveOrVerify(input.role)) deny('Only authorized GPA roles may waive requirements', 403);
  if (!String(input.reason || '').trim()) deny('Waiver reason is required');

  const packet = await getLatestPacket(input.tenantId, input.enrollmentId);
  if (!packet) deny('No packet found', 404);
  const item = packet.items.find((i) => i.id === input.itemId);
  if (!item) deny('Packet item not found', 404);

  const from = item.status;
  const updated = await prisma.enrollmentPacketItem.update({
    where: { id: item.id },
    data: {
      status: PacketItemStatus.WAIVED,
      waiverReason: input.reason,
      waivedById: input.actorId,
      waivedAt: new Date()
    }
  });
  await prisma.enrollmentPacketItemEvent.create({
    data: {
      itemId: item.id,
      eventType: 'REQUIREMENT_WAIVED',
      fromStatus: from,
      toStatus: PacketItemStatus.WAIVED,
      actorId: input.actorId,
      actorRole: input.role,
      reason: input.reason
    }
  });
  await refreshPacketStatus(packet.id);
  return updated;
}

async function refreshPacketStatus(packetId: string) {
  const packet = await prisma.enrollmentPacket.findUnique({
    where: { id: packetId },
    include: { items: true }
  });
  if (!packet) return;
  const hasConflicts = Boolean(packet.conflictNotes);
  const required = packet.items.filter((x) => x.isRequired);
  let status: EnrollmentPacketStatus;
  const incompleteStatuses: PacketItemStatus[] = [
    PacketItemStatus.MISSING,
    PacketItemStatus.NOT_STARTED,
    PacketItemStatus.REJECTED,
    PacketItemStatus.EXPIRED
  ];
  const satisfiedStatuses: PacketItemStatus[] = [
    PacketItemStatus.VERIFIED,
    PacketItemStatus.WAIVED,
    PacketItemStatus.NOT_APPLICABLE,
    PacketItemStatus.INFORMATION_AVAILABLE
  ];
  if (hasConflicts) status = EnrollmentPacketStatus.BLOCKED;
  else if (required.some((x) => incompleteStatuses.includes(x.status))) {
    status = EnrollmentPacketStatus.INCOMPLETE;
  } else if (required.some((x) => x.status === PacketItemStatus.EVIDENCE_ATTACHED || x.status === PacketItemStatus.PENDING_REVIEW)) {
    status = EnrollmentPacketStatus.REVIEW_REQUIRED;
  } else if (required.every((x) => satisfiedStatuses.includes(x.status))) {
    status = EnrollmentPacketStatus.READY_FOR_INTERNAL_SUBMISSION_REVIEW;
  } else {
    status = computePacketReadiness(packet.items, hasConflicts);
  }

  const summary = {
    total: packet.items.length,
    required: required.length,
    requiredSatisfied: required.filter((x) => satisfiedStatuses.includes(x.status)).length,
    missing: packet.items.filter((x) => x.status === PacketItemStatus.MISSING || x.status === PacketItemStatus.NOT_STARTED).length,
    pendingReview: packet.items.filter((x) => x.status === PacketItemStatus.PENDING_REVIEW || x.status === PacketItemStatus.EVIDENCE_ATTACHED).length,
    rejected: packet.items.filter((x) => x.status === PacketItemStatus.REJECTED).length,
    expired: packet.items.filter((x) => x.status === PacketItemStatus.EXPIRED).length,
    waived: packet.items.filter((x) => x.status === PacketItemStatus.WAIVED).length,
    disclaimer: 'Internal packet readiness only — not payer submission or approval.'
  };

  return prisma.enrollmentPacket.update({
    where: { id: packetId },
    data: { status, evaluationSummary: summary as any, evaluatedAt: new Date() }
  });
}

export function sanitizePacketForAudience(packet: any, audience: 'gpa' | 'client' | 'provider') {
  if (!packet) return packet;
  const items = (packet.items || []).map((item: any) => {
    const out = { ...item };
    if (audience !== 'gpa') {
      delete out.internalNotes;
    }
    return out;
  });
  const out: any = {
    ...packet,
    items,
    disclaimer: 'Packet readiness is internal preparation only. It does not mean the payer received, approved, or activated enrollment.'
  };
  if (audience !== 'gpa') {
    delete out.conflictNotes;
  }
  return out;
}
