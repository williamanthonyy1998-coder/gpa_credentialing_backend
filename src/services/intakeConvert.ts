import { DocumentSecurityStatus, IntakeStatus, ProviderIdentityMatch } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  normalizeAddressStateField,
  normalizeLicenseFields,
  normalizeProviderSpecialtyFields
} from './directoryIntegration';
import { validateNpi } from './npiValidation';
import { assertTransition } from './intakeStateMachine';
import { isTrustedForConversion } from './documentSecurity';

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
  // Idempotent: repeated convert returns existing result without creating duplicates.
  if (intake.status === 'CONVERTED') {
    let professionalHistory: any = null;
    if (intake.convertedProviderId && intake.tenantId) {
      const { convertIntakeProfessionalHistory } = await import('./professionalHistoryConvert');
      const payloadExisting: any = (intake as any).submittedPayload || intake.payload || {};
      professionalHistory = await convertIntakeProfessionalHistory({
        tenantId: intake.tenantId,
        providerId: intake.convertedProviderId,
        intakeId: intake.id,
        actorId,
        payload: payloadExisting
      });
    }
    return {
      intake,
      reused: { provider: true, practice: true, facility: true, organization: true },
      created: { provider: false, practice: false, facility: false, organization: false },
      providerId: intake.convertedProviderId,
      practiceId: intake.convertedPracticeId,
      facilityId: intake.convertedFacilityId,
      organizationId: intake.convertedOrganizationId,
      idempotent: true,
      professionalHistory
    };
  }

  // Prefer APPROVED for external provider intakes; allow SUBMITTED/UNDER_REVIEW for legacy internal.
  if (intake.status === IntakeStatus.APPROVED) {
    assertTransition(intake.status, IntakeStatus.CONVERTED, 'convert');
  } else if (!['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'].includes(intake.status)) {
    const err: any = new Error('Intake must be submitted, under review, or approved before conversion');
    err.status = 400;
    throw err;
  }
  if ((intake as any).identityMatch === ProviderIdentityMatch.AMBIGUOUS) {
    const err: any = new Error('Resolve ambiguous provider identity before conversion');
    err.status = 409;
    err.code = 'IDENTITY_AMBIGUOUS';
    throw err;
  }

  // Prefer approved submission version payload, then submittedPayload, then working draft.
  let payload: any = (intake as any).submittedPayload || intake.payload || {};
  const version = (intake as any).currentSubmissionVersion || 0;
  if (version > 0) {
    const submission = await prisma.intakeSubmission.findUnique({
      where: { intakeRequestId_version: { intakeRequestId: intake.id, version } }
    });
    if (submission?.payload) payload = submission.payload;
  }

  const missing = missingIntakeFields(intake.kind, payload);
  if (missing.length) {
    const err: any = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.status = 400;
    err.missing = missing;
    throw err;
  }

  const converted = await prisma.$transaction(async (tx) => {
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
        // Cross-tenant org reuse denied when intake is tenant-scoped
        if (intake.tenantId && org.tenantId && org.tenantId !== intake.tenantId) {
          const err: any = new Error('Organization identity belongs to another client; resolve manually');
          err.status = 409;
          err.code = 'ORG_CROSS_TENANT';
          throw err;
        }
        organizationId = org.id;
        result.reused.organization = true;
        if (intake.tenantId && !org.tenantId) {
          await tx.organization.update({ where: { id: org.id }, data: { tenantId: intake.tenantId } });
        }
      } else if (legalName) {
        org = await tx.organization.create({
          data: {
            tenantId: intake.tenantId || null,
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
        let facilityAddress = facilityData.address || null;
        if (facilityAddress) facilityAddress = await normalizeAddressStateField(facilityAddress);
        facility = await tx.facility.create({
          data: {
            name,
            npi,
            organizationId: organizationId || str(facilityData.organizationId) || null,
            practiceId: practiceId || str(facilityData.practiceId) || null,
            contactName: str(facilityData.contactName || intake.contactName) || null,
            phone: str(facilityData.phone || intake.contactPhone) || null,
            email: str(facilityData.email || intake.contactEmail) || null,
            address: facilityAddress || null,
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
      if (npi) {
        const npiCheck = validateNpi(npi);
        if (!npiCheck.ok) {
          const err: any = new Error(`Invalid NPI: ${npiCheck.reason || 'failed validation'}`);
          err.status = 400;
          throw err;
        }
      }

      let provider = null as any;
      const forceNew = (intake as any).identityMatch === ProviderIdentityMatch.NEW
        && !(intake as any).matchedProviderId;
      if (!forceNew && (intake as any).matchedProviderId) {
        provider = await tx.provider.findUnique({ where: { id: (intake as any).matchedProviderId } });
      }
      if (!provider && npi && !forceNew) {
        provider = await tx.provider.findUnique({ where: { npi } });
      }

      if (provider) {
        // Do not overwrite existing approved provider demographics automatically.
        providerId = provider.id;
        result.reused.provider = true;
      } else {
        const specialtyFields = await normalizeProviderSpecialtyFields({
          primarySpecialtyId: providerData.primarySpecialtyId || null,
          secondarySpecialtyId: providerData.secondarySpecialtyId || null,
          primarySpecialty: providerData.primarySpecialty || null,
          secondarySpecialty: providerData.secondarySpecialty || null
        }, { forCreate: true });
        let address = providerData.address || null;
        if (address) address = await normalizeAddressStateField(address);
        provider = await tx.provider.create({
          data: {
            firstName: str(providerData.firstName),
            middleName: str(providerData.middleName) || null,
            lastName: str(providerData.lastName),
            npi,
            email: str(providerData.email || intake.contactEmail) || null,
            homePhone: str(providerData.homePhone || providerData.phone || intake.contactPhone) || null,
            primarySpecialty: (specialtyFields.primarySpecialty as string) || str(providerData.primarySpecialty) || null,
            secondarySpecialty: (specialtyFields.secondarySpecialty as string) || str(providerData.secondarySpecialty) || null,
            primarySpecialtyId: (specialtyFields.primarySpecialtyId as string) || null,
            secondarySpecialtyId: (specialtyFields.secondarySpecialtyId as string) || null,
            taxonomyCode: str(providerData.taxonomyCode) || null,
            professionalType: str(providerData.professionalType) || null,
            dateOfBirth: providerData.dateOfBirth ? new Date(providerData.dateOfBirth) : null,
            address: address || undefined,
            status: 'PENDING'
          }
        });
        providerId = provider.id;
        result.created.provider = true;
        if (provider.primarySpecialtyId && providerId) {
          await tx.providerSpecialty.upsert({
            where: { providerId_specialtyId: { providerId, specialtyId: provider.primarySpecialtyId } },
            create: { providerId, specialtyId: provider.primarySpecialtyId, isPrimary: true, isSecondary: false },
            update: { isPrimary: true, isSecondary: false }
          });
        }
        if (provider.secondarySpecialtyId && providerId) {
          await tx.providerSpecialty.upsert({
            where: { providerId_specialtyId: { providerId, specialtyId: provider.secondarySpecialtyId } },
            create: { providerId, specialtyId: provider.secondarySpecialtyId, isPrimary: false, isSecondary: true },
            update: { isPrimary: false, isSecondary: true }
          });
        }
      }

      // Licenses: add missing numbers only (avoid duplicates by number+state for this provider)
      const licenseList = Array.isArray(providerData.licenses)
        ? providerData.licenses
        : (providerData.license ? [providerData.license] : []);
      for (const licensePayload of licenseList) {
        if (!licensePayload) continue;
        const licFields = await normalizeLicenseFields({
          licenseTypeId: licensePayload.licenseTypeId || null,
          usStateId: licensePayload.usStateId || null,
          type: licensePayload.type || null,
          state: licensePayload.state || null
        }, { forCreate: true });
        const number = str(licensePayload.number) || null;
        if (!(licFields.type || licFields.licenseTypeId) && !number) continue;
        if (number && providerId) {
          const stateVal = (licFields.state as string) || str(licensePayload.state) || null;
          const usStateId = (licFields.usStateId as string) || null;
          const existingLic = await tx.license.findFirst({
            where: {
              providerId,
              number,
              ...(usStateId ? { usStateId } : stateVal ? { state: stateVal } : {})
            }
          });
          if (existingLic) continue;
        }
        if (providerId && (licFields.type || licFields.licenseTypeId || number)) {
          await tx.license.create({
            data: {
              providerId,
              type: String(licFields.type || licensePayload.type || 'License'),
              licenseTypeId: (licFields.licenseTypeId as string) || null,
              number,
              state: (licFields.state as string) || str(licensePayload.state) || null,
              usStateId: (licFields.usStateId as string) || null,
              issuedAt: licensePayload.issuedAt ? new Date(licensePayload.issuedAt) : null,
              expiresAt: licensePayload.expiresAt ? new Date(licensePayload.expiresAt) : null,
              status: 'RECEIVED'
            }
          });
        }
      }

      if (providerId && intake.tenantId) {
        await tx.tenantProvider.upsert({
          where: { tenantId_providerId: { tenantId: intake.tenantId, providerId } },
          update: {},
          create: { tenantId: intake.tenantId, providerId }
        });
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

      // Link only trusted (AVAILABLE) intake documents — never quarantined/rejected
      if (providerId) {
        const docs = await tx.document.findMany({
          where: { intakeRequestId: intake.id },
          select: { id: true, securityStatus: true }
        });
        const trustedIds = docs
          .filter((d) => isTrustedForConversion(d.securityStatus))
          .map((d) => d.id);
        if (trustedIds.length) {
          await tx.document.updateMany({
            where: { id: { in: trustedIds } },
            data: { providerId }
          });
        }
      }
    }

    const updated = await tx.intakeRequest.update({
      where: { id: intake.id },
      data: {
        status: IntakeStatus.CONVERTED,
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

  // Phase 3A: map intake professional-history answers into structured tenant-scoped records.
  // Runs after the core convert transaction so intake/provider IDs are durable.
  // Never overwrites verified history; new rows stay PENDING_REVIEW; idempotent per intake.
  let professionalHistory: any = null;
  if (converted.providerId && intake.tenantId) {
    try {
      const { convertIntakeProfessionalHistory } = await import('./professionalHistoryConvert');
      professionalHistory = await convertIntakeProfessionalHistory({
        tenantId: intake.tenantId,
        providerId: converted.providerId,
        intakeId: intake.id,
        actorId,
        payload
      });
      await prisma.intakeEvent.create({
        data: {
          intakeId: intake.id,
          action: 'PROFESSIONAL_HISTORY_MAPPED',
          actorId,
          detail: {
            created: professionalHistory.created,
            unmappedCount: (professionalHistory.unmapped || []).length,
            idempotent: professionalHistory.idempotent
          }
        }
      });
    } catch (e: any) {
      professionalHistory = {
        error: e?.message || 'Professional history mapping failed',
        created: null
      };
      await prisma.intakeEvent.create({
        data: {
          intakeId: intake.id,
          action: 'PROFESSIONAL_HISTORY_MAP_FAILED',
          actorId,
          detail: { error: e?.message || 'unknown' }
        }
      });
    }
  }

  return { ...converted, professionalHistory };
}
