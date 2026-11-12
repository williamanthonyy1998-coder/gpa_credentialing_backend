import { HistoryVerificationStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  createBoardCertification,
  createEducation,
  createEmployment,
  createFellowship,
  createHospitalAffiliation,
  createMalpractice,
  createProfessionalCertification,
  createResidency
} from './professionalHistory';

function str(v: any) {
  return typeof v === 'string' ? v.trim() : '';
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [v];
  return [];
}

/**
 * Map intake submitted payload professional-history answers into structured records.
 * - Never overwrites VERIFIED history
 * - Skips near-duplicates
 * - New records start PENDING_REVIEW
 * - Idempotent per intake via sourceIntakeId markers
 */
export async function convertIntakeProfessionalHistory(input: {
  tenantId: string;
  providerId: string;
  intakeId: string;
  actorId: string;
  payload: any;
  tx?: Prisma.TransactionClient;
}) {
  const payload = input.payload || {};
  const provider = payload.provider || payload;
  const unmapped: string[] = [];
  const created: Record<string, number> = {
    education: 0,
    residency: 0,
    fellowship: 0,
    boardCertifications: 0,
    professionalCertifications: 0,
    employment: 0,
    hospitalAffiliations: 0,
    malpractice: 0
  };
  const skippedDuplicates: string[] = [];

  // Idempotency: if this intake already produced history rows, do not recreate.
  const existingFromIntake = await prisma.providerEducation.count({
    where: { sourceIntakeId: input.intakeId, providerId: input.providerId, tenantId: input.tenantId }
  });
  const existingBoard = await prisma.providerBoardCertification.count({
    where: { sourceIntakeId: input.intakeId, providerId: input.providerId, tenantId: input.tenantId }
  });
  if (existingFromIntake > 0 || existingBoard > 0) {
    return {
      idempotent: true,
      created,
      skippedDuplicates,
      unmapped: ['Intake professional history already converted for this intake']
    };
  }

  const opts = {
    initialStatus: HistoryVerificationStatus.PENDING_REVIEW,
    sourceIntakeId: input.intakeId
  };

  for (const edu of asArray(provider.education)) {
    const institutionName = str(edu.institutionName || edu.school || edu.institution);
    if (!institutionName) {
      unmapped.push('education: missing institution');
      continue;
    }
    try {
      await createEducation(
        input.tenantId,
        input.providerId,
        {
          institutionName,
          degreeName: str(edu.degree || edu.degreeName) || null,
          fieldOfStudy: str(edu.fieldOfStudy || edu.field) || null,
          graduationDate: edu.graduationYear
            ? `${edu.graduationYear}-06-15`
            : edu.graduationDate || edu.endDate || null,
          startDate: edu.startDate || null,
          endDate: edu.endDate || null,
          country: edu.country || null,
          state: edu.state || null,
          city: edu.city || null,
          notes: edu.notes || null
        },
        input.actorId,
        opts
      );
      created.education += 1;
    } catch (e: any) {
      if (e?.code === 'DUPLICATE_HISTORY') skippedDuplicates.push(`education:${institutionName}`);
      else unmapped.push(`education:${institutionName}:${e.message}`);
    }
  }

  for (const res of asArray(provider.residencies || provider.residency)) {
    const institutionName = str(res.institutionName || res.institution || res.program);
    if (!institutionName) {
      unmapped.push('residency: missing institution');
      continue;
    }
    try {
      await createResidency(
        input.tenantId,
        input.providerId,
        {
          institutionName,
          programName: str(res.programName || res.program) || null,
          specialtyName: str(res.specialty || res.specialtyName) || null,
          specialtyId: res.specialtyId || null,
          startDate: res.startDate || null,
          endDate: res.endDate || null,
          country: res.country || null,
          state: res.state || null,
          city: res.city || null
        },
        input.actorId,
        opts
      );
      created.residency += 1;
    } catch (e: any) {
      unmapped.push(`residency:${institutionName}:${e.message}`);
    }
  }

  for (const fel of asArray(provider.fellowships || provider.fellowship)) {
    const institutionName = str(fel.institutionName || fel.institution || fel.program);
    if (!institutionName) {
      unmapped.push('fellowship: missing institution');
      continue;
    }
    try {
      await createFellowship(
        input.tenantId,
        input.providerId,
        {
          institutionName,
          programName: str(fel.programName || fel.program) || null,
          specialtyName: str(fel.specialty || fel.specialtyName) || null,
          specialtyId: fel.specialtyId || null,
          startDate: fel.startDate || null,
          endDate: fel.endDate || null
        },
        input.actorId,
        opts
      );
      created.fellowship += 1;
    } catch (e: any) {
      unmapped.push(`fellowship:${institutionName}:${e.message}`);
    }
  }

  for (const cert of asArray(provider.boardCertifications || provider.boardCertification)) {
    const certifyingBoard = str(cert.certifyingBoard || cert.board || cert.name);
    if (!certifyingBoard) {
      unmapped.push('boardCertification: missing board name');
      continue;
    }
    try {
      await createBoardCertification(
        input.tenantId,
        input.providerId,
        {
          certifyingBoard,
          specialtyName: str(cert.specialty) || null,
          certificationNumber: cert.number || cert.certificationNumber || null,
          issueDate: cert.issueDate || (cert.year ? `${cert.year}-01-01` : null),
          expirationDate: cert.expirationDate || null,
          doesNotExpire: Boolean(cert.doesNotExpire)
        },
        input.actorId,
        opts
      );
      created.boardCertifications += 1;
    } catch (e: any) {
      unmapped.push(`boardCertification:${certifyingBoard}:${e.message}`);
    }
  }

  for (const cert of asArray(provider.professionalCertifications || provider.certifications)) {
    const certificationName = str(cert.certificationName || cert.name);
    if (!certificationName) {
      unmapped.push('professionalCertification: missing name');
      continue;
    }
    try {
      await createProfessionalCertification(
        input.tenantId,
        input.providerId,
        {
          certificationName,
          issuingOrganization: cert.issuingOrganization || cert.issuer || null,
          certificateNumber: cert.certificateNumber || cert.number || null,
          issueDate: cert.issueDate || null,
          expirationDate: cert.expirationDate || null
        },
        input.actorId,
        opts
      );
      created.professionalCertifications += 1;
    } catch (e: any) {
      unmapped.push(`professionalCertification:${certificationName}:${e.message}`);
    }
  }

  for (const emp of asArray(provider.employment || provider.employmentHistory)) {
    const employerName = str(emp.employerName || emp.employer || emp.organizationName);
    if (!employerName) {
      unmapped.push('employment: missing employer');
      continue;
    }
    try {
      await createEmployment(
        input.tenantId,
        input.providerId,
        {
          employerName,
          positionTitle: emp.positionTitle || emp.title || null,
          startDate: emp.startDate || emp.effectiveDate || null,
          endDate: emp.endDate || null,
          isCurrent: Boolean(emp.isCurrent || emp.current),
          city: emp.city || null,
          state: emp.state || null,
          country: emp.country || null
        },
        input.actorId,
        opts
      );
      created.employment += 1;
    } catch (e: any) {
      unmapped.push(`employment:${employerName}:${e.message}`);
    }
  }

  for (const aff of asArray(provider.affiliations || provider.hospitalAffiliations)) {
    const hospitalName = str(aff.hospitalName || aff.facilityName || aff.organizationName || aff.name);
    if (!hospitalName && !aff.facilityId) {
      unmapped.push('hospitalAffiliation: missing hospital');
      continue;
    }
    try {
      await createHospitalAffiliation(
        input.tenantId,
        input.providerId,
        {
          hospitalName: hospitalName || null,
          facilityId: aff.facilityId || null,
          affiliationType: aff.affiliationType || aff.type || null,
          department: aff.department || null,
          effectiveDate: aff.effectiveDate || aff.startDate || null,
          expirationDate: aff.expirationDate || aff.endDate || null,
          privilegeStatus: aff.privilegeStatus || null
        },
        input.actorId,
        opts
      );
      created.hospitalAffiliations += 1;
    } catch (e: any) {
      unmapped.push(`hospitalAffiliation:${hospitalName}:${e.message}`);
    }
  }

  for (const pol of asArray(provider.malpractice || provider.malpracticePolicies || provider.insurance)) {
    const insuranceCarrier = str(pol.insuranceCarrier || pol.carrier || pol.name);
    if (!insuranceCarrier) {
      unmapped.push('malpractice: missing carrier');
      continue;
    }
    try {
      await createMalpractice(
        input.tenantId,
        input.providerId,
        {
          insuranceCarrier,
          policyNumber: pol.policyNumber || null,
          coverageType: pol.coverageType || null,
          perOccurrenceAmount: pol.perOccurrenceAmount || pol.perOccurrence || null,
          aggregateAmount: pol.aggregateAmount || pol.aggregate || null,
          effectiveDate: pol.effectiveDate || null,
          expirationDate: pol.expirationDate || null,
          isCurrent: Boolean(pol.isCurrent || pol.current)
        },
        input.actorId,
        opts
      );
      created.malpractice += 1;
    } catch (e: any) {
      unmapped.push(`malpractice:${insuranceCarrier}:${e.message}`);
    }
  }

  // Preserve incomplete history notes without inventing structure
  if (str(provider.historyNotes) && Object.values(created).every((n) => n === 0)) {
    unmapped.push('historyNotes: free-text preserved on intake only (not mapped to structured records)');
  }

  return { idempotent: false, created, skippedDuplicates, unmapped };
}
