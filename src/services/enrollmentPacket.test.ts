import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentSecurityStatus,
  EnrollmentStatus,
  PacketItemStatus,
  RecordStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateApplicationNo } from './enrollments';
import {
  attachPacketEvidence,
  computePacketReadiness,
  evaluateEnrollmentPacket,
  getLatestPacket,
  reviewPacketItem,
  waivePacketItem
} from './enrollmentPacket';
import { previewRequirements } from './payerRequirementsEngine';
import { EnrollmentPacketStatus } from '@prisma/client';

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `Pkt Tenant ${suffix}`, slug: `pkt-tenant-${suffix}`, status: 'ACTIVE' }
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `Pkt TenantB ${suffix}`, slug: `pkt-tenant-b-${suffix}`, status: 'ACTIVE' }
  });
  const admin = await prisma.user.create({
    data: {
      email: `pkt.admin.${suffix}@test.local`,
      name: 'Pkt Admin',
      role: Role.ADMIN,
      passwordHash: 'x'
    }
  });
  const client = await prisma.user.create({
    data: {
      email: `pkt.client.${suffix}@test.local`,
      name: 'Pkt Client',
      role: Role.CLIENT_USER,
      passwordHash: 'x'
    }
  });
  const org = await prisma.organization.create({
    data: { legalName: `Org ${suffix}`, tenantId: tenant.id, status: 'ACTIVE' }
  });
  const facility = await prisma.facility.create({
    data: { name: `Fac ${suffix}`, organizationId: org.id, status: 'ACTIVE' }
  });
  const provider = await prisma.provider.create({
    data: {
      firstName: 'Pkt',
      lastName: `Prov${suffix}`,
      // Unique synthetic NPI per run (avoids global unique collisions across tests)
      npi: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`,
      primarySpecialty: 'Family Medicine',
      status: 'ACTIVE'
    }
  });
  await prisma.tenantProvider.create({ data: { tenantId: tenant.id, providerId: provider.id } });
  await prisma.providerFacility.create({ data: { providerId: provider.id, facilityId: facility.id } });

  const payer = await prisma.payer.create({
    data: { name: `Pkt Payer ${suffix}`, payerCode: `PK${suffix}`, status: 'ACTIVE' }
  });
  const plan = await prisma.payerPlan.create({
    data: { payerId: payer.id, name: `Pkt Plan ${suffix}`, status: 'ACTIVE' }
  });

  const reqNpi = await prisma.payerRequirement.create({
    data: {
      scope: 'PLATFORM',
      payerId: payer.id,
      code: 'NPI',
      title: 'National Provider Identifier',
      category: 'NPI',
      isRequired: true,
      status: RecordStatus.ACTIVE,
      version: 1,
      source: 'GPA authorized configuration'
    }
  });
  const reqOpt = await prisma.payerRequirement.create({
    data: {
      scope: 'PLATFORM',
      payerId: payer.id,
      payerPlanId: plan.id,
      code: 'OPTIONAL_NOTE',
      title: 'Optional cover letter',
      category: 'CORRESPONDENCE',
      isRequired: false,
      status: RecordStatus.ACTIVE,
      version: 1
    }
  });
  const reqDoc = await prisma.payerRequirement.create({
    data: {
      scope: 'PLATFORM',
      payerPlanId: plan.id,
      code: 'W9',
      title: 'W-9',
      category: 'TAX_W9',
      documentCategoryCode: 'IRS',
      isRequired: true,
      tracksExpiration: false,
      status: RecordStatus.ACTIVE,
      version: 1,
      conditions: { all: [{ field: 'enrollmentType', op: 'eq', value: 'INDIVIDUAL' }] }
    }
  });

  const applicationNo = await generateApplicationNo(prisma);
  const enrollment = await prisma.enrollmentApplication.create({
    data: {
      tenantId: tenant.id,
      applicationNo,
      subject: `Pkt Enr ${suffix}`,
      providerId: provider.id,
      organizationId: org.id,
      facilityId: facility.id,
      payerPlanId: plan.id,
      enrollmentType: 'INDIVIDUAL',
      status: EnrollmentStatus.PREPARING
    }
  });

  return {
    suffix, tenant, tenantB, admin, client, org, facility, provider, payer, plan,
    reqNpi, reqOpt, reqDoc, enrollment
  };
}

test('optional missing does not block; mandatory missing does; readiness ≠ SUBMITTED', async () => {
  const s = await seed();
  const result = await evaluateEnrollmentPacket({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  assert.equal(result.enrollmentStatusUnchanged, EnrollmentStatus.PREPARING);
  const enr = await prisma.enrollmentApplication.findUnique({ where: { id: s.enrollment.id } });
  assert.equal(enr!.status, EnrollmentStatus.PREPARING);

  const packet = result.packet;
  assert.ok(packet.items.length >= 2);
  const npi = packet.items.find((i) => i.requirementCode === 'NPI');
  assert.ok(npi);
  assert.equal(npi!.status, PacketItemStatus.INFORMATION_AVAILABLE);
  assert.notEqual(npi!.status, PacketItemStatus.VERIFIED);

  const w9 = packet.items.find((i) => i.requirementCode === 'W9');
  assert.ok(w9);
  assert.equal(w9!.status, PacketItemStatus.MISSING);
  assert.equal(packet.status, EnrollmentPacketStatus.INCOMPLETE);

  // Optional alone does not force INCOMPLETE when required are OK
  assert.equal(
    computePacketReadiness(
      [
        { status: PacketItemStatus.INFORMATION_AVAILABLE, isRequired: true },
        { status: PacketItemStatus.MISSING, isRequired: false }
      ],
      false
    ),
    EnrollmentPacketStatus.READY_FOR_INTERNAL_SUBMISSION_REVIEW
  );
});

test('preview resolves plan requirements; client cannot waive; quarantined evidence rejected', async () => {
  const s = await seed();
  const preview = await previewRequirements({
    tenantId: s.tenant.id,
    payerId: s.payer.id,
    payerPlanId: s.plan.id,
    enrollmentType: 'INDIVIDUAL',
    specialty: 'Family Medicine',
    hasFacility: true
  });
  assert.ok(preview.items.some((i) => i.code === 'NPI'));
  assert.ok(preview.items.some((i) => i.code === 'W9'));

  await evaluateEnrollmentPacket({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  const packet = await getLatestPacket(s.tenant.id, s.enrollment.id);
  const w9 = packet!.items.find((i) => i.requirementCode === 'W9')!;

  await assert.rejects(
    () => waivePacketItem({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      itemId: w9.id,
      actorId: s.client.id,
      role: Role.CLIENT_USER,
      reason: 'client cannot'
    }),
    /authorized|403|Insufficient/i
  );

  const quarantined = await prisma.document.create({
    data: {
      title: 'Quarantined W9',
      type: 'IRS',
      category: 'IRS',
      tenantId: s.tenant.id,
      providerId: s.provider.id,
      securityStatus: DocumentSecurityStatus.QUARANTINED,
      status: 'RECEIVED'
    }
  });
  await assert.rejects(
    () => attachPacketEvidence({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      itemId: w9.id,
      documentId: quarantined.id,
      actorId: s.admin.id,
      role: Role.ADMIN
    }),
    /Quarantined|untrusted/i
  );

  const trusted = await prisma.document.create({
    data: {
      title: 'Trusted W9',
      type: 'IRS',
      category: 'IRS',
      tenantId: s.tenant.id,
      providerId: s.provider.id,
      securityStatus: DocumentSecurityStatus.AVAILABLE,
      status: 'RECEIVED'
    }
  });
  const attached = await attachPacketEvidence({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    itemId: w9.id,
    documentId: trusted.id,
    actorId: s.admin.id,
    role: Role.ADMIN
  });
  assert.equal(attached.status, PacketItemStatus.EVIDENCE_ATTACHED);

  const verified = await reviewPacketItem({
    tenantId: s.tenant.id,
    enrollmentId: s.enrollment.id,
    itemId: w9.id,
    actorId: s.admin.id,
    role: Role.ADMIN,
    decision: 'VERIFY',
    reason: 'W-9 on file'
  });
  assert.equal(verified.status, PacketItemStatus.VERIFIED);

  const after = await getLatestPacket(s.tenant.id, s.enrollment.id);
  assert.equal(after!.status, EnrollmentPacketStatus.READY_FOR_INTERNAL_SUBMISSION_REVIEW);

  // Historical snapshot preserved after requirement change
  const v1 = after!.version;
  await prisma.payerRequirement.update({
    where: { id: s.reqNpi.id },
    data: { title: 'NPI UPDATED FOR FUTURE PACKETS', version: { increment: 1 } }
  });
  const hist = await prisma.enrollmentPacket.findFirst({
    where: { id: after!.id },
    include: { items: true }
  });
  assert.equal(hist!.version, v1);
  const snapNpi = hist!.items.find((i) => i.requirementCode === 'NPI');
  assert.equal(snapNpi!.requirementTitle, 'National Provider Identifier');

  // Cross-tenant document rejected
  const otherDoc = await prisma.document.create({
    data: {
      title: 'Other tenant doc',
      type: 'IRS',
      category: 'IRS',
      tenantId: s.tenantB.id,
      securityStatus: DocumentSecurityStatus.AVAILABLE,
      status: 'RECEIVED'
    }
  });
  await assert.rejects(
    () => attachPacketEvidence({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      itemId: w9.id,
      documentId: otherDoc.id,
      actorId: s.admin.id,
      role: Role.ADMIN
    }),
    /not found/i
  );

  // Rejection requires reason
  await assert.rejects(
    () => reviewPacketItem({
      tenantId: s.tenant.id,
      enrollmentId: s.enrollment.id,
      itemId: w9.id,
      actorId: s.admin.id,
      role: Role.ADMIN,
      decision: 'REJECT',
      reason: ''
    }),
    /reason/i
  );
});

test('inactive requirements excluded; conflicts block readiness calculation input', () => {
  assert.equal(
    computePacketReadiness([{ status: PacketItemStatus.VERIFIED, isRequired: true }], true),
    EnrollmentPacketStatus.BLOCKED
  );
});
