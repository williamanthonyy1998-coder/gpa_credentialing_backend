import {
  DirectoryScope,
  Prisma,
  PrismaClient,
  RecordStatus
} from '@prisma/client';
import { DOCUMENT_CATEGORIES, DOCUMENT_TYPES_BY_CATEGORY } from '../src/services/credentials';

type ChecklistItem = string | { item?: string; title?: string; name?: string };

const US_STATES: Array<{ name: string; abbr: string; fips: string }> = [
  { name: 'Alabama', abbr: 'AL', fips: '01' },
  { name: 'Alaska', abbr: 'AK', fips: '02' },
  { name: 'Arizona', abbr: 'AZ', fips: '04' },
  { name: 'Arkansas', abbr: 'AR', fips: '05' },
  { name: 'California', abbr: 'CA', fips: '06' },
  { name: 'Colorado', abbr: 'CO', fips: '08' },
  { name: 'Connecticut', abbr: 'CT', fips: '09' },
  { name: 'Delaware', abbr: 'DE', fips: '10' },
  { name: 'District of Columbia', abbr: 'DC', fips: '11' },
  { name: 'Florida', abbr: 'FL', fips: '12' },
  { name: 'Georgia', abbr: 'GA', fips: '13' },
  { name: 'Hawaii', abbr: 'HI', fips: '15' },
  { name: 'Idaho', abbr: 'ID', fips: '16' },
  { name: 'Illinois', abbr: 'IL', fips: '17' },
  { name: 'Indiana', abbr: 'IN', fips: '18' },
  { name: 'Iowa', abbr: 'IA', fips: '19' },
  { name: 'Kansas', abbr: 'KS', fips: '20' },
  { name: 'Kentucky', abbr: 'KY', fips: '21' },
  { name: 'Louisiana', abbr: 'LA', fips: '22' },
  { name: 'Maine', abbr: 'ME', fips: '23' },
  { name: 'Maryland', abbr: 'MD', fips: '24' },
  { name: 'Massachusetts', abbr: 'MA', fips: '25' },
  { name: 'Michigan', abbr: 'MI', fips: '26' },
  { name: 'Minnesota', abbr: 'MN', fips: '27' },
  { name: 'Mississippi', abbr: 'MS', fips: '28' },
  { name: 'Missouri', abbr: 'MO', fips: '29' },
  { name: 'Montana', abbr: 'MT', fips: '30' },
  { name: 'Nebraska', abbr: 'NE', fips: '31' },
  { name: 'Nevada', abbr: 'NV', fips: '32' },
  { name: 'New Hampshire', abbr: 'NH', fips: '33' },
  { name: 'New Jersey', abbr: 'NJ', fips: '34' },
  { name: 'New Mexico', abbr: 'NM', fips: '35' },
  { name: 'New York', abbr: 'NY', fips: '36' },
  { name: 'North Carolina', abbr: 'NC', fips: '37' },
  { name: 'North Dakota', abbr: 'ND', fips: '38' },
  { name: 'Ohio', abbr: 'OH', fips: '39' },
  { name: 'Oklahoma', abbr: 'OK', fips: '40' },
  { name: 'Oregon', abbr: 'OR', fips: '41' },
  { name: 'Pennsylvania', abbr: 'PA', fips: '42' },
  { name: 'Rhode Island', abbr: 'RI', fips: '44' },
  { name: 'South Carolina', abbr: 'SC', fips: '45' },
  { name: 'South Dakota', abbr: 'SD', fips: '46' },
  { name: 'Tennessee', abbr: 'TN', fips: '47' },
  { name: 'Texas', abbr: 'TX', fips: '48' },
  { name: 'Utah', abbr: 'UT', fips: '49' },
  { name: 'Vermont', abbr: 'VT', fips: '50' },
  { name: 'Virginia', abbr: 'VA', fips: '51' },
  { name: 'Washington', abbr: 'WA', fips: '53' },
  { name: 'West Virginia', abbr: 'WV', fips: '54' },
  { name: 'Wisconsin', abbr: 'WI', fips: '55' },
  { name: 'Wyoming', abbr: 'WY', fips: '56' }
];

const SPECIALTIES = [
  'Family Medicine',
  'Internal Medicine',
  'Primary Care',
  'Psychiatry',
  'Behavioral Health',
  'Cardiology',
  'Clinical Cardiac Electrophysiology',
  'Pulmonary Disease',
  'Sleep Medicine',
  'Emergency Medicine',
  'Pediatrics',
  'Obstetrics and Gynecology',
  'General Surgery',
  'Anesthesiology',
  'Radiology',
  'Pathology',
  'Dermatology',
  'Neurology',
  'Orthopedic Surgery',
  'Urology'
];

const LICENSE_TYPES = [
  { code: 'MD', name: 'Medical Doctor (MD)' },
  { code: 'DO', name: 'Doctor of Osteopathic Medicine (DO)' },
  { code: 'NP', name: 'Nurse Practitioner (NP)' },
  { code: 'PA', name: 'Physician Assistant (PA)' },
  { code: 'RN', name: 'Registered Nurse (RN)' },
  { code: 'LCSW', name: 'Licensed Clinical Social Worker (LCSW)' },
  { code: 'LPC', name: 'Licensed Professional Counselor (LPC)' },
  { code: 'PSY', name: 'Psychologist (PSY)' },
  { code: 'STATE_MEDICAL', name: 'State Medical License' },
  { code: 'OTHER', name: 'Other License Type' }
];

const DEGREE_TYPES = [
  { code: 'MD', name: 'Doctor of Medicine (MD)' },
  { code: 'DO', name: 'Doctor of Osteopathic Medicine (DO)' },
  { code: 'MBBS', name: 'Bachelor of Medicine, Bachelor of Surgery (MBBS)' },
  { code: 'PhD', name: 'Doctor of Philosophy (PhD)' },
  { code: 'PsyD', name: 'Doctor of Psychology (PsyD)' },
  { code: 'MSN', name: 'Master of Science in Nursing (MSN)' },
  { code: 'BSN', name: 'Bachelor of Science in Nursing (BSN)' },
  { code: 'MPH', name: 'Master of Public Health (MPH)' },
  { code: 'DNP', name: 'Doctor of Nursing Practice (DNP)' },
  { code: 'PA-C', name: 'Physician Assistant Certified (PA-C)' }
];

const EDUCATION_TYPES = [
  { code: 'UNDERGRAD', name: 'Undergraduate Education' },
  { code: 'GRADUATE', name: 'Graduate Education' },
  { code: 'POSTGRAD', name: 'Post-Graduate Education' },
  { code: 'CONTINUING', name: 'Continuing Medical Education' }
];

const RESIDENCY_TYPES = [
  { code: 'INTERNAL_MEDICINE', name: 'Internal Medicine Residency' },
  { code: 'FAMILY_MEDICINE', name: 'Family Medicine Residency' },
  { code: 'PSYCHIATRY', name: 'Psychiatry Residency' },
  { code: 'SURGERY', name: 'General Surgery Residency' }
];

const FELLOWSHIP_TYPES = [
  { code: 'CARDIOLOGY', name: 'Cardiology Fellowship' },
  { code: 'PULMONARY', name: 'Pulmonary Disease Fellowship' },
  { code: 'SLEEP', name: 'Sleep Medicine Fellowship' },
  { code: 'ELECTROPHYSIOLOGY', name: 'Clinical Cardiac Electrophysiology Fellowship' }
];

const BOARD_CATEGORIES = [
  { code: 'ABMS', name: 'American Board of Medical Specialties (ABMS)' },
  { code: 'ABPS', name: 'American Board of Physician Specialties (ABPS)' },
  { code: 'AOA', name: 'American Osteopathic Association Boards' },
  { code: 'OTHER', name: 'Other Board Certification' }
];

const CERTIFICATION_TYPES = [
  { code: 'BLS', name: 'Basic Life Support (BLS)' },
  { code: 'ACLS', name: 'Advanced Cardiovascular Life Support (ACLS)' },
  { code: 'ATLS', name: 'Advanced Trauma Life Support (ATLS)' },
  { code: 'DEA', name: 'DEA Registration' },
  { code: 'CSR', name: 'Controlled Substances Registration' }
];

function stableId(prefix: string, key: string) {
  return `seed-dir-${prefix}-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
}

function checklistTitle(item: ChecklistItem): string {
  if (typeof item === 'string') return item.trim();
  return String(item.title || item.item || item.name || '').trim();
}

export async function seedDirectories(prisma: PrismaClient) {
  for (const st of US_STATES) {
    await prisma.usState.upsert({
      where: { abbreviation: st.abbr },
      update: { name: st.name, fipsCode: st.fips, status: RecordStatus.ACTIVE },
      create: {
        id: stableId('us', st.abbr),
        name: st.name,
        abbreviation: st.abbr,
        fipsCode: st.fips,
        status: RecordStatus.ACTIVE
      }
    });
  }

  for (const name of SPECIALTIES) {
    await prisma.specialty.upsert({
      where: { name },
      update: { status: RecordStatus.ACTIVE },
      create: {
        id: stableId('spec', name),
        name,
        status: RecordStatus.ACTIVE
      }
    });
  }

  for (const lt of LICENSE_TYPES) {
    await prisma.licenseType.upsert({
      where: { code: lt.code },
      update: { name: lt.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('lt', lt.code), ...lt, status: RecordStatus.ACTIVE }
    });
  }

  for (const item of DEGREE_TYPES) {
    await prisma.degreeType.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('deg', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }
  for (const item of EDUCATION_TYPES) {
    await prisma.educationType.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('edu', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }
  for (const item of RESIDENCY_TYPES) {
    await prisma.residencyType.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('res', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }
  for (const item of FELLOWSHIP_TYPES) {
    await prisma.fellowshipType.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('fel', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }
  for (const item of BOARD_CATEGORIES) {
    await prisma.boardCertificationCategory.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('brd', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }
  for (const item of CERTIFICATION_TYPES) {
    await prisma.certificationType.upsert({
      where: { code: item.code },
      update: { name: item.name, status: RecordStatus.ACTIVE },
      create: { id: stableId('cert', item.code), ...item, status: RecordStatus.ACTIVE }
    });
  }

  let sortOrder = 0;
  for (const cat of DOCUMENT_CATEGORIES) {
    const types = DOCUMENT_TYPES_BY_CATEGORY[cat.key] ?? cat.types;
    const existing = await prisma.credentialCategory.findFirst({
      where: { scope: DirectoryScope.PLATFORM, tenantId: null, code: cat.key }
    });
    if (existing) {
      await prisma.credentialCategory.update({
        where: { id: existing.id },
        data: {
          name: cat.label,
          documentTypes: types as object,
          sortOrder: sortOrder++,
          status: RecordStatus.ACTIVE
        }
      });
    } else {
      await prisma.credentialCategory.create({
        data: {
          id: stableId('cc', cat.key),
          scope: DirectoryScope.PLATFORM,
          tenantId: null,
          code: cat.key,
          name: cat.label,
          documentTypes: types as object,
          sortOrder: sortOrder++,
          status: RecordStatus.ACTIVE
        }
      });
    }
  }

  const txState = await prisma.usState.findUnique({ where: { abbreviation: 'TX' } });
  const mdType =
    (await prisma.licenseType.findUnique({ where: { code: 'MD' } })) ||
    (await prisma.licenseType.findUnique({ where: { code: 'STATE_MEDICAL' } }));

  if (txState) {
    await prisma.license.updateMany({
      where: { state: { in: ['TX', 'tx', 'Tx'] }, usStateId: null },
      data: { usStateId: txState.id }
    });
    const licenses = await prisma.license.findMany({ where: { usStateId: null, state: { not: null } }, select: { id: true, state: true } });
    for (const lic of licenses) {
      const abbr = String(lic.state || '').trim().toUpperCase();
      const st = await prisma.usState.findUnique({ where: { abbreviation: abbr } });
      if (st) await prisma.license.update({ where: { id: lic.id }, data: { usStateId: st.id } });
    }
  }

  if (mdType) {
    await prisma.license.updateMany({
      where: {
        licenseTypeId: null,
        OR: [
          { type: { contains: 'State Medical', mode: 'insensitive' } },
          { type: { in: ['MD', 'Medical Doctor', 'State Medical License'] } }
        ]
      },
      data: { licenseTypeId: mdType.id }
    });
  }

  const specialties = await prisma.specialty.findMany({ select: { id: true, name: true } });
  const byName = new Map(specialties.map((s) => [s.name.toLowerCase(), s.id]));
  const providers = await prisma.provider.findMany({
    select: { id: true, primarySpecialty: true, secondarySpecialty: true, primarySpecialtyId: true, secondarySpecialtyId: true }
  });
  for (const p of providers) {
    const updates: Record<string, string> = {};
    if (p.primarySpecialty) {
      const sid = byName.get(p.primarySpecialty.trim().toLowerCase());
      if (sid) updates.primarySpecialtyId = sid;
    }
    if (p.secondarySpecialty) {
      const sid = byName.get(p.secondarySpecialty.trim().toLowerCase());
      if (sid) updates.secondarySpecialtyId = sid;
    }
    if (Object.keys(updates).length) await prisma.provider.update({ where: { id: p.id }, data: updates });

    const primaryId = updates.primarySpecialtyId || p.primarySpecialtyId;
    const secondaryId = updates.secondarySpecialtyId || p.secondarySpecialtyId;
    if (primaryId) {
      await prisma.providerSpecialty.upsert({
        where: { providerId_specialtyId: { providerId: p.id, specialtyId: primaryId } },
        create: { providerId: p.id, specialtyId: primaryId, isPrimary: true },
        update: { isPrimary: true }
      });
    }
    if (secondaryId) {
      await prisma.providerSpecialty.upsert({
        where: { providerId_specialtyId: { providerId: p.id, specialtyId: secondaryId } },
        create: { providerId: p.id, specialtyId: secondaryId, isSecondary: true },
        update: { isSecondary: true }
      });
    }
  }

  const plans = await prisma.payerPlan.findMany({
    where: { checklist: { not: Prisma.DbNull } },
    select: { id: true, payerId: true, checklist: true }
  });
  for (const plan of plans) {
    const raw = plan.checklist;
    if (!Array.isArray(raw)) continue;
    let index = 0;
    for (const entry of raw as ChecklistItem[]) {
      index += 1;
      const title = checklistTitle(entry);
      if (!title) continue;
      const code = `legacy-checklist-${index}`;
      const existing = await prisma.payerRequirement.findFirst({
        where: { scope: DirectoryScope.PLATFORM, payerPlanId: plan.id, code }
      });
      if (existing) {
        await prisma.payerRequirement.update({
          where: { id: existing.id },
          data: {
            title,
            metadata: { legacyChecklistItem: entry, source: 'PayerPlan.checklist' } as object,
            status: RecordStatus.ACTIVE
          }
        });
      } else {
        await prisma.payerRequirement.create({
          data: {
            id: stableId('preq', `${plan.id}-${code}`),
            scope: DirectoryScope.PLATFORM,
            tenantId: null,
            payerId: plan.payerId,
            payerPlanId: plan.id,
            code,
            title,
            sortOrder: index,
            metadata: { legacyChecklistItem: entry, source: 'PayerPlan.checklist' } as object,
            status: RecordStatus.ACTIVE
          }
        });
      }
    }
  }
}
