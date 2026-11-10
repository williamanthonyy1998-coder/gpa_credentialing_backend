import { prisma } from '../lib/prisma';

function str(v: any) {
  return typeof v === 'string' ? v.trim() : '';
}

export function missingIntakeFields(kind: string, payload: any): string[] {
  const p = payload || {};
  const missing: string[] = [];
  if (kind === 'PROVIDER' || kind === 'COMBINED') {
    if (!str(p.provider?.firstName) && !str(p.firstName)) missing.push('Provider first name');
    if (!str(p.provider?.lastName) && !str(p.lastName)) missing.push('Provider last name');
    if (!str(p.provider?.npi) && !str(p.npi)) missing.push('Provider NPI');
  }
  if (kind === 'PRACTICE' || kind === 'COMBINED') {
    if (!str(p.practice?.name) && !str(p.practiceName)) missing.push('Practice name');
    if (!str(p.practice?.organizationId) && !str(p.organizationId)) missing.push('Organization');
  }
  if (kind === 'FACILITY' || kind === 'COMBINED') {
    if (!str(p.facility?.name) && !str(p.facilityName)) missing.push('Facility name');
  }
  if (kind === 'ORGANIZATION') {
    if (!str(p.organization?.legalName) && !str(p.legalName)) missing.push('Organization legal name');
  }
  return missing;
}

/**
 * Convert intake payload into master directory records.
 * Reuses Provider by NPI, Practice by NPI/Tax ID, Facility by NPI when present.
 */
export async function convertIntake(intakeId: string, actorId: string) {
  const intake = await prisma.intakeRequest.findUnique({ where: { id: intakeId } });
  if (!intake) {
    const err: any = new Error('Intake request not found');
    err.status = 404;
    throw err;
  }
  if (intake.status === 'CONVERTED') {
    const err: any = new Error('Intake already converted');
    err.status = 400;
    throw err;
  }
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(intake.status)) {
    const err: any = new Error('Intake must be submitted or under review before conversion');
    err.status = 400;
    throw err;
  }

  const payload: any = intake.payload || {};
  const missing = missingIntakeFields(intake.kind, payload);
  if (missing.length) {
    const err: any = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.status = 400;
    err.missing = missing;
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    const result: any = {
      reused: { provider: false, practice: false, facility: false, organization: false },
      created: { provider: false, practice: false, facility: false, organization: false }
    };

    let organizationId = intake.organizationId || str(payload.organizationId) || null;
    let practiceId: string | null = null;
    let facilityId: string | null = null;
    let providerId: string | null = null;

    if (intake.kind === 'ORGANIZATION' || (intake.kind === 'COMBINED' && (payload.organization || payload.legalName))) {
      const legalName = str(payload.organization?.legalName || payload.legalName);
      const taxId = str(payload.organization?.taxId || payload.taxId) || null;
      let org = taxId
        ? await tx.organization.findFirst({ where: { taxId } })
        : null;
      if (!org && legalName) {
        org = await tx.organization.findFirst({ where: { legalName: { equals: legalName, mode: 'insensitive' } } });
      }
      if (org) {
        organizationId = org.id;
        result.reused.organization = true;
      } else if (legalName) {
        org = await tx.organization.create({
          data: {
            legalName,
            dba: str(payload.organization?.dba || payload.dba) || null,
            taxId,
            contactName: str(payload.organization?.contactName || payload.contactName || intake.contactName) || null,
            phone: str(payload.organization?.phone || payload.phone || intake.contactPhone) || null,
            email: str(payload.organization?.email || payload.email || intake.contactEmail) || null,
            status: 'PENDING'
          }
        });
        organizationId = org.id;
        result.created.organization = true;
      }
    }

    if (intake.kind === 'PRACTICE' || intake.kind === 'COMBINED') {
      const practiceData = payload.practice || {};
      const name = str(practiceData.name || payload.practiceName);
      const npi = str(practiceData.npi || payload.practiceNpi) || null;
      const taxId = str(practiceData.taxId || payload.practiceTaxId) || null;
      const orgId = organizationId || str(practiceData.organizationId);
      if (!orgId) {
        const err: any = new Error('Practice conversion requires an organization');
        err.status = 400;
        throw err;
      }
      let practice = null as any;
      if (npi) practice = await tx.practice.findFirst({ where: { npi } });
      if (!practice && taxId) practice = await tx.practice.findFirst({ where: { taxId, organizationId: orgId } });
      if (practice) {
        practiceId = practice.id;
        result.reused.practice = true;
        organizationId = practice.organizationId;
      } else {
        practice = await tx.practice.create({
          data: {
            organizationId: orgId,
            name,
            legalName: str(practiceData.legalName) || null,
            npi,
            taxId,
            taxonomyCode: str(practiceData.taxonomyCode) || null,
            contactName: str(practiceData.contactName || intake.contactName) || null,
            phone: str(practiceData.phone || intake.contactPhone) || null,
            email: str(practiceData.email || intake.contactEmail) || null,
            status: 'PENDING'
          }
        });
        practiceId = practice.id;
        organizationId = orgId;
        result.created.practice = true;
      }
    }

    if (intake.kind === 'FACILITY' || intake.kind === 'COMBINED') {
      const facilityData = payload.facility || {};
      const name = str(facilityData.name || payload.facilityName);
      const npi = str(facilityData.npi || payload.facilityNpi) || null;
      let facility = null as any;
      if (npi) facility = await tx.facility.findFirst({ where: { npi } });
      if (facility) {
        facilityId = facility.id;
        result.reused.facility = true;
        organizationId = organizationId || facility.organizationId;
        practiceId = practiceId || facility.practiceId;
      } else {
        facility = await tx.facility.create({
          data: {
            name,
            npi,
            organizationId: organizationId || str(facilityData.organizationId) || null,
            practiceId: practiceId || str(facilityData.practiceId) || null,
            contactName: str(facilityData.contactName || intake.contactName) || null,
            phone: str(facilityData.phone || intake.contactPhone) || null,
            email: str(facilityData.email || intake.contactEmail) || null,
            address: facilityData.address || null,
            status: 'PENDING'
          }
        });
        facilityId = facility.id;
        result.created.facility = true;
      }
    }

    if (intake.kind === 'PROVIDER' || intake.kind === 'COMBINED') {
      const providerData = payload.provider || payload;
      const npi = str(providerData.npi) || null;
      let provider = npi ? await tx.provider.findUnique({ where: { npi } }) : null;
      if (provider) {
        providerId = provider.id;
        result.reused.provider = true;
      } else {
        provider = await tx.provider.create({
          data: {
            firstName: str(providerData.firstName),
            middleName: str(providerData.middleName) || null,
            lastName: str(providerData.lastName),
            npi,
            email: str(providerData.email || intake.contactEmail) || null,
            homePhone: str(providerData.homePhone || providerData.phone || intake.contactPhone) || null,
            primarySpecialty: str(providerData.primarySpecialty) || null,
            taxonomyCode: str(providerData.taxonomyCode) || null,
            professionalType: str(providerData.professionalType) || null,
            dateOfBirth: providerData.dateOfBirth ? new Date(providerData.dateOfBirth) : null,
            status: 'PENDING'
          }
        });
        providerId = provider.id;
        result.created.provider = true;
      }

      if (providerId && organizationId) {
        await tx.providerOrganization.upsert({
          where: { providerId_organizationId: { providerId, organizationId } },
          update: { status: 'ACTIVE' },
          create: { providerId, organizationId, status: 'ACTIVE', affiliationTitle: 'Intake conversion' }
        });
      }
      if (providerId && practiceId) {
        await tx.providerPractice.upsert({
          where: { providerId_practiceId: { providerId, practiceId } },
          update: {},
          create: { providerId, practiceId, affiliationTitle: 'Intake conversion' }
        });
      }
      if (providerId && facilityId) {
        await tx.providerFacility.upsert({
          where: { providerId_facilityId: { providerId, facilityId } },
          update: {},
          create: { providerId, facilityId, approvalStatus: 'PENDING' }
        });
      }
    }

    const updated = await tx.intakeRequest.update({
      where: { id: intake.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        convertedProviderId: providerId,
        convertedPracticeId: practiceId,
        convertedFacilityId: facilityId,
        convertedOrganizationId: organizationId,
        organizationId: organizationId || intake.organizationId,
        missingFields: []
      }
    });

    await tx.intakeEvent.create({
      data: {
        intakeId: intake.id,
        action: 'CONVERTED',
        actorId,
        detail: { ...result, providerId, practiceId, facilityId, organizationId }
      }
    });

    return { intake: updated, ...result, providerId, practiceId, facilityId, organizationId };
  });
}
