import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  PrismaClient,
  Role,
  RecordStatus,
  DocumentStatus,
  CaseStatus,
  EnrollmentStatus,
  TaskStatus,
  Priority,
  TenantStatus,
  TenantRole,
  TenantMembershipStatus,
} from '@prisma/client';
import { seedDirectories } from './seed-directories';

const prisma = new PrismaClient();
const SEED_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'LocalDemo-ChangeThis-2026!';
const d = (value: string) => new Date(`${value}T12:00:00.000Z`);
const addr = (street: string, city: string, state: string, zip: string) => ({ street, city, state, zip, county: city, country: 'USA' });

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const users = [
    { id: 'seed-user-admin', email: 'admin@example.com', name: 'Demo System Admin', role: Role.ADMIN },
    { id: 'seed-user-manager', email: 'manager@example.com', name: 'Demo Credentialing Manager', role: Role.CREDENTIALING_MANAGER },
    { id: 'seed-user-credentialing', email: 'credentialing@example.com', name: 'Demo Credentialing Specialist', role: Role.CREDENTIALING_SPECIALIST },
    { id: 'seed-user-enrollment', email: 'enrollment@example.com', name: 'Demo Enrollment Specialist', role: Role.ENROLLMENT_SPECIALIST },
    { id: 'seed-user-approver', email: 'approver@example.com', name: 'Demo Approver', role: Role.APPROVER },
  ];
  for (const u of users) await prisma.user.upsert({ where: { email: u.email }, update: { id: u.id, name: u.name, role: u.role, active: true }, create: { ...u, passwordHash, active: true } });

  // Phase 0A: demo tenant only. Seed organizations are explicitly linked here.
  // Non-seed / legacy Organization rows are intentionally left with tenantId = null
  // (no automatic guessing of client ownership).
  const demoTenant = await prisma.tenant.upsert({
    where: { id: 'seed-tenant-demo' },
    update: { name: 'Demo GPA Client Account', slug: 'demo-gpa-client', status: TenantStatus.ACTIVE },
    create: {
      id: 'seed-tenant-demo',
      name: 'Demo GPA Client Account',
      slug: 'demo-gpa-client',
      status: TenantStatus.ACTIVE,
    },
  });

  const tenantMemberships = [
    { id: 'seed-tm-admin', userId: 'seed-user-admin', role: TenantRole.TENANT_ADMIN },
    { id: 'seed-tm-manager', userId: 'seed-user-manager', role: TenantRole.CREDENTIALING_MANAGER },
    { id: 'seed-tm-credentialing', userId: 'seed-user-credentialing', role: TenantRole.CREDENTIALING_SPECIALIST },
    { id: 'seed-tm-enrollment', userId: 'seed-user-enrollment', role: TenantRole.ENROLLMENT_SPECIALIST },
    { id: 'seed-tm-approver', userId: 'seed-user-approver', role: TenantRole.APPROVER },
  ];
  for (const m of tenantMemberships) {
    await prisma.tenantMembership.upsert({
      where: { userId_tenantId: { userId: m.userId, tenantId: demoTenant.id } },
      update: { id: m.id, role: m.role, status: TenantMembershipStatus.ACTIVE },
      create: {
        id: m.id,
        userId: m.userId,
        tenantId: demoTenant.id,
        role: m.role,
        status: TenantMembershipStatus.ACTIVE,
      },
    });
  }

  const orgData = [
    { id: 'seed-org-01', legalName: 'Demo Lone Star Medical Group LLC', dba: 'Lone Star Family Care', taxId: 'DEMO-TAX-1001', establishedAt: d('2017-03-15'), contactName: 'Taylor Morgan', contactTitle: 'Practice Administrator', phone: '555-0101', fax: '555-0191', email: 'admin1@example.test', mailingAddress: addr('100 Demo Medical Plaza', 'Houston', 'TX', '77002'), ownership: { status: 'Privately Held', classification: 'LLC', ownerCount: 2 }, bankName: 'Demo Community Bank', bankAccountTitle: 'Lone Star Medical Group LLC', bankContactName: 'Demo Banking Desk', bankContactPhone: '555-0181', bankContactEmail: 'banking1@example.test' },
    { id: 'seed-org-02', legalName: 'Demo Gulf Coast Primary Care PLLC', dba: 'Gulf Coast Primary Care', taxId: 'DEMO-TAX-1002', establishedAt: d('2019-06-01'), contactName: 'Jordan Lee', contactTitle: 'Operations Lead', phone: '555-0102', fax: '555-0192', email: 'admin2@example.test', mailingAddress: addr('200 Sample Bay Road', 'Sugar Land', 'TX', '77478'), ownership: { status: 'Privately Held', classification: 'PLLC', ownerCount: 1 }, bankName: 'Demo Regional Bank', bankAccountTitle: 'Gulf Coast Primary Care PLLC', bankContactName: 'Demo Banking Desk', bankContactPhone: '555-0182', bankContactEmail: 'banking2@example.test' },
    { id: 'seed-org-03', legalName: 'Demo Cypress Behavioral Health LLC', dba: 'Cypress Behavioral Health', taxId: 'DEMO-TAX-1003', establishedAt: d('2020-02-10'), contactName: 'Casey Rivera', contactTitle: 'Clinic Director', phone: '555-0103', fax: '555-0193', email: 'admin3@example.test', mailingAddress: addr('300 Example Wellness Drive', 'Cypress', 'TX', '77429'), ownership: { status: 'Privately Held', classification: 'LLC', ownerCount: 2 }, bankName: 'Demo Community Bank', bankAccountTitle: 'Cypress Behavioral Health LLC', bankContactName: 'Demo Banking Desk', bankContactPhone: '555-0183', bankContactEmail: 'banking3@example.test' },
    { id: 'seed-org-04', legalName: 'Demo Bayou Cardiology Associates PA', dba: 'Bayou Cardiology', taxId: 'DEMO-TAX-1004', establishedAt: d('2015-11-20'), contactName: 'Avery Brooks', contactTitle: 'Credentialing Coordinator', phone: '555-0104', fax: '555-0194', email: 'admin4@example.test', mailingAddress: addr('400 Demo Heart Center', 'Katy', 'TX', '77494'), ownership: { status: 'Privately Held', classification: 'PA', ownerCount: 3 }, bankName: 'Demo Regional Bank', bankAccountTitle: 'Bayou Cardiology Associates PA', bankContactName: 'Demo Banking Desk', bankContactPhone: '555-0184', bankContactEmail: 'banking4@example.test' },
    { id: 'seed-org-05', legalName: 'Demo Northside Specialty Clinic Inc', dba: 'Northside Specialty Clinic', taxId: 'DEMO-TAX-1005', establishedAt: d('2018-08-05'), contactName: 'Morgan Ellis', contactTitle: 'Office Manager', phone: '555-0105', fax: '555-0195', email: 'admin5@example.test', mailingAddress: addr('500 Training Clinic Lane', 'Spring', 'TX', '77373'), ownership: { status: 'Privately Held', classification: 'Corporation', ownerCount: 2 }, bankName: 'Demo Community Bank', bankAccountTitle: 'Northside Specialty Clinic Inc', bankContactName: 'Demo Banking Desk', bankContactPhone: '555-0185', bankContactEmail: 'banking5@example.test' },
  ];
  for (const org of orgData) {
    await prisma.organization.upsert({
      where: { id: org.id },
      update: { ...org, tenantId: demoTenant.id },
      create: { ...org, status: RecordStatus.ACTIVE, tenantId: demoTenant.id },
    });
  }

  const practicesData = [
    { id: 'seed-practice-01', organizationId: 'seed-org-01', name: 'Lone Star Family Medicine', legalName: 'Lone Star Medical Group LLC', npi: '1999999001', taxId: 'DEMO-TAX-1001', dba: 'Lone Star Family Care', taxonomyCode: '207Q00000X', establishedAt: d('2017-03-15'), contactName: 'Taylor Morgan', contactTitle: 'Practice Administrator', phone: '555-1101', fax: '555-1191', email: 'practice1@example.test', mailingAddress: addr('100 Demo Medical Plaza', 'Houston', 'TX', '77002'), primaryAddress: addr('101 Demo Medical Plaza', 'Houston', 'TX', '77002') },
    { id: 'seed-practice-02', organizationId: 'seed-org-02', name: 'Gulf Coast Primary Care', legalName: 'Demo Gulf Coast Primary Care PLLC', npi: '1999999002', taxId: 'DEMO-TAX-1002', dba: 'Gulf Coast Primary Care', taxonomyCode: '207Q00000X', establishedAt: d('2019-06-01'), contactName: 'Jordan Lee', contactTitle: 'Operations Lead', phone: '555-1102', fax: '555-1192', email: 'practice2@example.test', mailingAddress: addr('200 Sample Bay Road', 'Sugar Land', 'TX', '77478'), primaryAddress: addr('201 Sample Bay Road', 'Sugar Land', 'TX', '77478') },
    { id: 'seed-practice-03', organizationId: 'seed-org-03', name: 'Cypress Behavioral Health Clinic', legalName: 'Demo Cypress Behavioral Health LLC', npi: '1999999003', taxId: 'DEMO-TAX-1003', dba: 'Cypress Behavioral Health', taxonomyCode: '2084P0800X', establishedAt: d('2020-02-10'), contactName: 'Casey Rivera', contactTitle: 'Clinic Director', phone: '555-1103', fax: '555-1193', email: 'practice3@example.test', mailingAddress: addr('300 Example Wellness Drive', 'Cypress', 'TX', '77429'), primaryAddress: addr('301 Example Wellness Drive', 'Cypress', 'TX', '77429') },
    { id: 'seed-practice-04', organizationId: 'seed-org-04', name: 'Bayou Cardiology Clinic', legalName: 'Demo Bayou Cardiology Associates PA', npi: '1999999004', taxId: 'DEMO-TAX-1004', dba: 'Bayou Cardiology', taxonomyCode: '207RC0000X', establishedAt: d('2015-11-20'), contactName: 'Avery Brooks', contactTitle: 'Credentialing Coordinator', phone: '555-1104', fax: '555-1194', email: 'practice4@example.test', mailingAddress: addr('400 Demo Heart Center', 'Katy', 'TX', '77494'), primaryAddress: addr('401 Demo Heart Center', 'Katy', 'TX', '77494') },
    { id: 'seed-practice-05', organizationId: 'seed-org-05', name: 'Northside Specialty Clinic', legalName: 'Demo Northside Specialty Clinic Inc', npi: '1999999005', taxId: 'DEMO-TAX-1005', dba: 'Northside Specialty Clinic', taxonomyCode: '207R00000X', establishedAt: d('2018-08-05'), contactName: 'Morgan Ellis', contactTitle: 'Office Manager', phone: '555-1105', fax: '555-1195', email: 'practice5@example.test', mailingAddress: addr('500 Training Clinic Lane', 'Spring', 'TX', '77373'), primaryAddress: addr('501 Training Clinic Lane', 'Spring', 'TX', '77373') },
  ];
  for (const p of practicesData) await prisma.practice.upsert({ where: { id: p.id }, update: p, create: { ...p, status: RecordStatus.ACTIVE } });

  const facilitiesData = [
    { id: 'seed-facility-01', practiceId: 'seed-practice-01', name: 'Lone Star Main Office', npi: '1888888001', contactName: 'Taylor Morgan', contactTitle: 'Administrator', phone: '555-2101', fax: '555-2191', email: 'facility1@example.test', address: addr('101 Demo Medical Plaza', 'Houston', 'TX', '77002'), schedule: { Monday: '08:00-17:00', Tuesday: '08:00-17:00', Wednesday: '08:00-17:00', Thursday: '08:00-17:00', Friday: '08:00-15:00', Saturday: 'Closed', Sunday: 'Closed' } },
    { id: 'seed-facility-02', practiceId: 'seed-practice-02', name: 'Gulf Coast Sugar Land Site', npi: '1888888002', contactName: 'Jordan Lee', contactTitle: 'Operations Lead', phone: '555-2102', fax: '555-2192', email: 'facility2@example.test', address: addr('201 Sample Bay Road', 'Sugar Land', 'TX', '77478'), schedule: { Monday: '08:30-17:00', Tuesday: '08:30-17:00', Wednesday: '08:30-17:00', Thursday: '08:30-17:00', Friday: '08:30-15:00', Saturday: 'Closed', Sunday: 'Closed' } },
    { id: 'seed-facility-03', practiceId: 'seed-practice-03', name: 'Cypress Behavioral Suite', npi: '1888888003', contactName: 'Casey Rivera', contactTitle: 'Clinic Director', phone: '555-2103', fax: '555-2193', email: 'facility3@example.test', address: addr('301 Example Wellness Drive', 'Cypress', 'TX', '77429'), schedule: { Monday: '09:00-18:00', Tuesday: '09:00-18:00', Wednesday: '09:00-18:00', Thursday: '09:00-18:00', Friday: '09:00-16:00', Saturday: 'Closed', Sunday: 'Closed' } },
    { id: 'seed-facility-04', practiceId: 'seed-practice-04', name: 'Bayou Heart Diagnostics', npi: '1888888004', contactName: 'Avery Brooks', contactTitle: 'Coordinator', phone: '555-2104', fax: '555-2194', email: 'facility4@example.test', address: addr('401 Demo Heart Center', 'Katy', 'TX', '77494'), schedule: { Monday: '07:30-16:30', Tuesday: '07:30-16:30', Wednesday: '07:30-16:30', Thursday: '07:30-16:30', Friday: '07:30-14:00', Saturday: 'Closed', Sunday: 'Closed' } },
    { id: 'seed-facility-05', practiceId: 'seed-practice-05', name: 'Northside Specialty Annex', npi: '1888888005', contactName: 'Morgan Ellis', contactTitle: 'Office Manager', phone: '555-2105', fax: '555-2195', email: 'facility5@example.test', address: addr('501 Training Clinic Lane', 'Spring', 'TX', '77373'), schedule: { Monday: '08:00-17:00', Tuesday: '08:00-17:00', Wednesday: '08:00-17:00', Thursday: '08:00-17:00', Friday: '08:00-15:00', Saturday: 'Closed', Sunday: 'Closed' } },
  ];
  for (const f of facilitiesData) await prisma.facility.upsert({ where: { id: f.id }, update: f, create: { ...f, status: RecordStatus.ACTIVE } });

  const providerData = [
    { id: 'seed-provider-01', firstName: 'Demo', middleName: 'A', lastName: 'Family', npi: '1777777001', dateOfBirth: d('1978-04-12'), placeOfBirth: 'Demo City, TX', citizenship: 'Demo/Test', gender: 'Not specified', email: 'provider1@example.test', homePhone: '555-3101', workPhone: '555-4101', address: addr('11 Training Oak Street', 'Houston', 'TX', '77002'), primarySpecialty: 'Family Medicine', secondarySpecialty: 'Primary Care', taxonomyCode: '207Q00000X', professionalType: 'MD', supervisorName: 'Demo Clinical Supervisor 1' },
    { id: 'seed-provider-02', firstName: 'Demo', middleName: 'B', lastName: 'Primary', npi: '1777777002', dateOfBirth: d('1982-07-23'), placeOfBirth: 'Demo City, TX', citizenship: 'Demo/Test', gender: 'Not specified', email: 'provider2@example.test', homePhone: '555-3102', workPhone: '555-4102', address: addr('22 Training Oak Street', 'Sugar Land', 'TX', '77478'), primarySpecialty: 'Internal Medicine', secondarySpecialty: 'Primary Care', taxonomyCode: '207R00000X', professionalType: 'MD', supervisorName: 'Demo Clinical Supervisor 2' },
    { id: 'seed-provider-03', firstName: 'Demo', middleName: 'C', lastName: 'Behavioral', npi: '1777777003', dateOfBirth: d('1985-02-14'), placeOfBirth: 'Demo City, TX', citizenship: 'Demo/Test', gender: 'Not specified', email: 'provider3@example.test', homePhone: '555-3103', workPhone: '555-4103', address: addr('33 Training Oak Street', 'Cypress', 'TX', '77429'), primarySpecialty: 'Psychiatry', secondarySpecialty: 'Behavioral Health', taxonomyCode: '2084P0800X', professionalType: 'MD', supervisorName: 'Demo Clinical Supervisor 3' },
    { id: 'seed-provider-04', firstName: 'Demo', middleName: 'D', lastName: 'Cardiology', npi: '1777777004', dateOfBirth: d('1975-10-05'), placeOfBirth: 'Demo City, TX', citizenship: 'Demo/Test', gender: 'Not specified', email: 'provider4@example.test', homePhone: '555-3104', workPhone: '555-4104', address: addr('44 Training Oak Street', 'Katy', 'TX', '77494'), primarySpecialty: 'Cardiology', secondarySpecialty: 'Clinical Cardiac Electrophysiology', taxonomyCode: '207RC0000X', professionalType: 'MD', supervisorName: 'Demo Clinical Supervisor 4' },
    { id: 'seed-provider-05', firstName: 'Demo', middleName: 'E', lastName: 'Specialty', npi: '1777777005', dateOfBirth: d('1980-12-30'), placeOfBirth: 'Demo City, TX', citizenship: 'Demo/Test', gender: 'Not specified', email: 'provider5@example.test', homePhone: '555-3105', workPhone: '555-4105', address: addr('55 Training Oak Street', 'Spring', 'TX', '77373'), primarySpecialty: 'Pulmonary Disease', secondarySpecialty: 'Sleep Medicine', taxonomyCode: '207RP1001X', professionalType: 'MD', supervisorName: 'Demo Clinical Supervisor 5' },
  ];
  for (let i = 0; i < providerData.length; i++) {
    const p = providerData[i];
    await prisma.provider.upsert({ where: { id: p.id }, update: p, create: { ...p, status: i === 0 ? RecordStatus.ACTIVE : RecordStatus.PENDING } });
    await prisma.providerPractice.upsert({ where: { providerId_practiceId: { providerId: p.id, practiceId: practicesData[i].id } }, update: { affiliationTitle: 'Rendering Provider', effectiveAt: d('2025-01-01') }, create: { providerId: p.id, practiceId: practicesData[i].id, affiliationTitle: 'Rendering Provider', effectiveAt: d('2025-01-01') } });
    await prisma.providerFacility.upsert({ where: { providerId_facilityId: { providerId: p.id, facilityId: facilitiesData[i].id } }, update: { approvalStatus: i === 0 ? 'Approved' : 'Pending', effectiveAt: d('2025-01-01') }, create: { providerId: p.id, facilityId: facilitiesData[i].id, approvalStatus: i === 0 ? 'Approved' : 'Pending', effectiveAt: d('2025-01-01') } });
    await prisma.license.upsert({ where: { id: `seed-license-0${i + 1}` }, update: { providerId: p.id, type: 'State Medical License', number: `DEMO-TX-LIC-${1001 + i}`, state: 'TX', issuedAt: d('2023-01-15'), expiresAt: d(`202${7 + (i % 2)}-12-31`), status: i === 0 ? DocumentStatus.VERIFIED : DocumentStatus.RECEIVED, issuingBody: 'Texas Medical Board (demo record)', notes: 'Synthetic training data; not a real credential.' }, create: { id: `seed-license-0${i + 1}`, providerId: p.id, type: 'State Medical License', number: `DEMO-TX-LIC-${1001 + i}`, state: 'TX', issuedAt: d('2023-01-15'), expiresAt: d(`202${7 + (i % 2)}-12-31`), status: i === 0 ? DocumentStatus.VERIFIED : DocumentStatus.RECEIVED, issuingBody: 'Texas Medical Board (demo record)', notes: 'Synthetic training data; not a real credential.' } });
    await prisma.tenantProvider.upsert({
      where: { tenantId_providerId: { tenantId: demoTenant.id, providerId: p.id } },
      update: {},
      create: { tenantId: demoTenant.id, providerId: p.id }
    });
  }

  const documentData = [
    { id: 'seed-document-01', title: 'Organization Formation Document - Demo 01', type: 'Organization Formation', status: DocumentStatus.VERIFIED, originalName: 'demo-formation-01.pdf', mimeType: 'application/pdf', sizeBytes: 120000, issuedAt: d('2024-01-10'), expiresAt: null, verifiedAt: d('2025-01-10'), verifiedBy: 'Demo Credentialing Manager', organizationId: 'seed-org-01', notes: 'Synthetic metadata only. No real document file is attached.' },
    { id: 'seed-document-02', title: 'IRS Tax Letter - Demo 02', type: 'IRS Letter', status: DocumentStatus.RECEIVED, originalName: 'demo-irs-02.pdf', mimeType: 'application/pdf', sizeBytes: 98000, issuedAt: d('2024-02-12'), expiresAt: null, verifiedAt: null, verifiedBy: null, organizationId: 'seed-org-02', notes: 'Synthetic metadata only; not an actual IRS document.' },
    { id: 'seed-document-03', title: 'Provider CV - Demo 03', type: 'CV', status: DocumentStatus.UNDER_REVIEW, originalName: 'demo-provider-cv-03.pdf', mimeType: 'application/pdf', sizeBytes: 76000, issuedAt: d('2025-03-01'), expiresAt: null, verifiedAt: null, verifiedBy: null, providerId: 'seed-provider-03', notes: 'Synthetic metadata only. No real document file is attached.' },
    { id: 'seed-document-04', title: 'Professional Liability Certificate - Demo 04', type: 'Professional Liability', status: DocumentStatus.RECEIVED, originalName: 'demo-malpractice-04.pdf', mimeType: 'application/pdf', sizeBytes: 145000, issuedAt: d('2025-01-01'), expiresAt: d('2026-12-31'), verifiedAt: null, verifiedBy: null, providerId: 'seed-provider-04', notes: 'Synthetic training record; expiry is illustrative.' },
    { id: 'seed-document-05', title: 'Facility Occupancy Certificate - Demo 05', type: 'Certificate of Occupancy', status: DocumentStatus.MISSING, originalName: null, mimeType: null, sizeBytes: null, issuedAt: null, expiresAt: null, verifiedAt: null, verifiedBy: null, facilityId: 'seed-facility-05', notes: 'Example missing-document task.' },
  ];
  for (const x of documentData) {
    await prisma.document.upsert({
      where: { id: x.id },
      update: { ...x, tenantId: demoTenant.id },
      create: { ...x, tenantId: demoTenant.id }
    });
  }

  const caseData = [
    { id: 'seed-case-01', caseNumber: 'DEMO-CRED-0001', providerId: 'seed-provider-01', practiceId: 'seed-practice-01', status: CaseStatus.APPROVED, assignedTo: 'manager@example.com', dueAt: d('2026-11-15'), submittedAt: d('2026-09-01'), decisionAt: d('2026-09-15'), decisionBy: 'Demo Approver', decisionReason: 'Approved for demo workflow testing', checklist: [{ item: 'Identity', status: 'verified' }, { item: 'State license', status: 'verified' }, { item: 'Education', status: 'verified' }], notes: 'Synthetic demo case; approval is not a real credentialing decision.' },
    { id: 'seed-case-02', caseNumber: 'DEMO-CRED-0002', providerId: 'seed-provider-02', practiceId: 'seed-practice-02', status: CaseStatus.INFORMATION_NEEDED, assignedTo: 'credentialing@example.com', dueAt: d('2026-11-05'), submittedAt: d('2026-10-01'), decisionAt: null, decisionBy: null, decisionReason: null, checklist: [{ item: 'Identity', status: 'verified' }, { item: 'CV', status: 'missing' }, { item: 'Work history', status: 'pending' }], notes: 'Waiting for updated CV and work history.' },
    { id: 'seed-case-03', caseNumber: 'DEMO-CRED-0003', providerId: 'seed-provider-03', practiceId: 'seed-practice-03', status: CaseStatus.VERIFICATION_PENDING, assignedTo: 'credentialing@example.com', dueAt: d('2026-11-10'), submittedAt: d('2026-10-10'), decisionAt: null, decisionBy: null, decisionReason: null, checklist: [{ item: 'State license', status: 'pending verification' }, { item: 'Board certification', status: 'pending' }], notes: 'Verification source and date must be recorded before approval.' },
    { id: 'seed-case-04', caseNumber: 'DEMO-CRED-0004', providerId: 'seed-provider-04', practiceId: 'seed-practice-04', status: CaseStatus.UNDER_REVIEW, assignedTo: 'manager@example.com', dueAt: d('2026-11-20'), submittedAt: d('2026-10-18'), decisionAt: null, decisionBy: null, decisionReason: null, checklist: [{ item: 'Identity', status: 'verified' }, { item: 'Malpractice coverage', status: 'received' }, { item: 'Privileges', status: 'pending' }], notes: 'Manager review in progress.' },
    { id: 'seed-case-05', caseNumber: 'DEMO-CRED-0005', providerId: 'seed-provider-05', practiceId: 'seed-practice-05', status: CaseStatus.ON_HOLD, assignedTo: 'credentialing@example.com', dueAt: d('2026-11-25'), submittedAt: null, decisionAt: null, decisionBy: null, decisionReason: null, checklist: [{ item: 'Provider application', status: 'pending' }, { item: 'License', status: 'pending' }], notes: 'On hold pending provider response.' },
  ];
  for (const c of caseData) {
    await prisma.credentialingCase.upsert({
      where: { caseNumber: c.caseNumber },
      update: { ...c, tenantId: demoTenant.id },
      create: { ...c, tenantId: demoTenant.id }
    });
    const saved = await prisma.credentialingCase.findUniqueOrThrow({ where: { caseNumber: c.caseNumber } });
    await prisma.statusHistory.upsert({ where: { id: `seed-case-history-${c.id}` }, update: { toStatus: saved.status, changedBy: 'seed-script', reason: 'Seeded demo workflow history', caseId: saved.id }, create: { id: `seed-case-history-${c.id}`, toStatus: saved.status, changedBy: 'seed-script', reason: 'Seeded demo workflow history', caseId: saved.id } });
  }

  const payerData = [
    { id: 'seed-payer-01', name: 'Demo Medicare', payerCode: 'DEMO-MCR', website: 'https://www.medicare.gov', phone: '555-5101' },
    { id: 'seed-payer-02', name: 'Demo Texas Medicaid', payerCode: 'DEMO-TXMD', website: 'https://www.hhs.texas.gov', phone: '555-5102' },
    { id: 'seed-payer-03', name: 'Demo Blue Cross Blue Shield Texas', payerCode: 'DEMO-BCBSTX', website: 'https://www.bcbstx.com', phone: '555-5103' },
    { id: 'seed-payer-04', name: 'Demo Aetna', payerCode: 'DEMO-AETNA', website: 'https://www.aetna.com', phone: '555-5104' },
    { id: 'seed-payer-05', name: 'Demo UnitedHealthcare', payerCode: 'DEMO-UHC', website: 'https://www.uhc.com', phone: '555-5105' },
  ];
  for (const p of payerData) await prisma.payer.upsert({ where: { id: p.id }, update: p, create: { ...p, status: RecordStatus.ACTIVE } });

  const planData = [
    { id: 'seed-plan-01', payerId: 'seed-payer-01', name: 'Demo Medicare Part B', planType: 'Government', checklist: ['Provider enrollment application', 'Active state license', 'NPI verification', 'Practice address validation'] },
    { id: 'seed-plan-02', payerId: 'seed-payer-02', name: 'Demo Texas Medicaid Provider', planType: 'Government', checklist: ['Provider enrollment form', 'License', 'Tax documentation', 'Service location'] },
    { id: 'seed-plan-03', payerId: 'seed-payer-03', name: 'Demo Blue Choice PPO', planType: 'Commercial PPO', checklist: ['Credentialing application', 'CV', 'Malpractice certificate', 'W-9'] },
    { id: 'seed-plan-04', payerId: 'seed-payer-04', name: 'Demo Commercial HMO', planType: 'Commercial HMO', checklist: ['Provider profile', 'License verification', 'Malpractice coverage', 'Practice details'] },
    { id: 'seed-plan-05', payerId: 'seed-payer-05', name: 'Demo Choice Plus', planType: 'Commercial PPO', checklist: ['Enrollment application', 'Provider identifiers', 'Practice location', 'Disclosure forms'] },
  ];
  for (const p of planData) await prisma.payerPlan.upsert({ where: { id: p.id }, update: p, create: p });

  const enrollmentData = [
    { id: 'seed-enroll-01', applicationNo: 'DEMO-ENR-0001', providerId: 'seed-provider-01', practiceId: 'seed-practice-01', payerPlanId: 'seed-plan-01', status: EnrollmentStatus.APPROVED, assignedTo: 'enrollment@example.com', dueAt: d('2026-11-30'), submittedAt: d('2026-08-20'), referenceNo: 'DEMO-REF-10001', lastFollowUpAt: d('2026-09-10'), nextFollowUpAt: null, effectiveAt: d('2026-10-01'), decisionAt: d('2026-09-25'), decisionReason: 'Demo approval record', checklist: [{ item: 'Application', status: 'complete' }, { item: 'License', status: 'complete' }], notes: 'Synthetic example only; not a real payer approval.' },
    { id: 'seed-enroll-02', applicationNo: 'DEMO-ENR-0002', providerId: 'seed-provider-02', practiceId: 'seed-practice-02', payerPlanId: 'seed-plan-02', status: EnrollmentStatus.SUBMITTED, assignedTo: 'enrollment@example.com', dueAt: d('2026-11-08'), submittedAt: d('2026-10-12'), referenceNo: 'DEMO-REF-10002', lastFollowUpAt: d('2026-10-20'), nextFollowUpAt: d('2026-10-30'), effectiveAt: null, decisionAt: null, decisionReason: null, checklist: [{ item: 'Application', status: 'submitted' }, { item: 'Tax documentation', status: 'submitted' }], notes: 'Awaiting payer acknowledgement.' },
    { id: 'seed-enroll-03', applicationNo: 'DEMO-ENR-0003', providerId: 'seed-provider-03', practiceId: 'seed-practice-03', payerPlanId: 'seed-plan-03', status: EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED, assignedTo: 'enrollment@example.com', dueAt: d('2026-11-04'), submittedAt: d('2026-09-28'), referenceNo: 'DEMO-REF-10003', lastFollowUpAt: d('2026-10-22'), nextFollowUpAt: d('2026-10-29'), effectiveAt: null, decisionAt: null, decisionReason: null, checklist: [{ item: 'Application', status: 'submitted' }, { item: 'Malpractice certificate', status: 'requested by payer' }], notes: 'Upload requested supporting document and record response.' },
    { id: 'seed-enroll-04', applicationNo: 'DEMO-ENR-0004', providerId: 'seed-provider-04', practiceId: 'seed-practice-04', payerPlanId: 'seed-plan-04', status: EnrollmentStatus.PAYER_REVIEW, assignedTo: 'enrollment@example.com', dueAt: d('2026-11-18'), submittedAt: d('2026-10-15'), referenceNo: 'DEMO-REF-10004', lastFollowUpAt: d('2026-10-21'), nextFollowUpAt: d('2026-11-01'), effectiveAt: null, decisionAt: null, decisionReason: null, checklist: [{ item: 'Application', status: 'submitted' }, { item: 'Provider profile', status: 'under payer review' }], notes: 'Payer review in progress.' },
    { id: 'seed-enroll-05', applicationNo: 'DEMO-ENR-0005', providerId: 'seed-provider-05', practiceId: 'seed-practice-05', payerPlanId: 'seed-plan-05', status: EnrollmentStatus.PREPARING, assignedTo: 'enrollment@example.com', dueAt: d('2026-11-22'), submittedAt: null, referenceNo: null, lastFollowUpAt: null, nextFollowUpAt: d('2026-11-02'), effectiveAt: null, decisionAt: null, decisionReason: null, checklist: [{ item: 'Application', status: 'in progress' }, { item: 'Disclosure forms', status: 'missing' }], notes: 'Complete checklist before submission.' },
  ];
  for (const e of enrollmentData) {
    await prisma.enrollmentApplication.upsert({
      where: { applicationNo: e.applicationNo },
      update: { ...e, tenantId: demoTenant.id },
      create: { ...e, tenantId: demoTenant.id }
    });
    const saved = await prisma.enrollmentApplication.findUniqueOrThrow({ where: { applicationNo: e.applicationNo } });
    await prisma.statusHistory.upsert({ where: { id: `seed-enroll-history-${e.id}` }, update: { toStatus: saved.status, changedBy: 'seed-script', reason: 'Seeded demo enrollment history', enrollmentId: saved.id }, create: { id: `seed-enroll-history-${e.id}`, toStatus: saved.status, changedBy: 'seed-script', reason: 'Seeded demo enrollment history', enrollmentId: saved.id } });
  }

  const taskData = [
    { id: 'seed-task-01', title: 'Review Demo Family provider file', description: 'Check completeness of the provider credentialing checklist and document evidence.', status: TaskStatus.COMPLETED, priority: Priority.NORMAL, dueAt: d('2026-10-15'), assignedToId: 'seed-user-manager', createdById: 'seed-user-admin', caseId: 'seed-case-01', enrollmentId: null },
    { id: 'seed-task-02', title: 'Request updated CV', description: 'Contact provider office and record date and outcome of the request.', status: TaskStatus.OPEN, priority: Priority.HIGH, dueAt: d('2026-11-05'), assignedToId: 'seed-user-credentialing', createdById: 'seed-user-manager', caseId: 'seed-case-02', enrollmentId: null },
    { id: 'seed-task-03', title: 'Verify state license evidence', description: 'Record verification source, date, result, and reviewer in the case notes.', status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH, dueAt: d('2026-11-10'), assignedToId: 'seed-user-credentialing', createdById: 'seed-user-manager', caseId: 'seed-case-03', enrollmentId: null },
    { id: 'seed-task-04', title: 'Follow up with payer on Demo Enrollment 0003', description: 'Confirm requested malpractice certificate requirements and log payer response.', status: TaskStatus.OPEN, priority: Priority.URGENT, dueAt: d('2026-10-29'), assignedToId: 'seed-user-enrollment', createdById: 'seed-user-admin', caseId: null, enrollmentId: 'seed-enroll-03' },
    { id: 'seed-task-05', title: 'Complete payer application checklist', description: 'Collect remaining disclosure form and validate required fields before submission.', status: TaskStatus.BLOCKED, priority: Priority.NORMAL, dueAt: d('2026-11-02'), assignedToId: 'seed-user-enrollment', createdById: 'seed-user-manager', caseId: null, enrollmentId: 'seed-enroll-05' },
  ];
  for (const t of taskData) {
    await prisma.task.upsert({
      where: { id: t.id },
      update: { ...t, tenantId: demoTenant.id },
      create: { ...t, tenantId: demoTenant.id }
    });
  }

  const auditData = [
    { id: 'seed-audit-01', actorId: 'seed-user-admin', organizationId: 'seed-org-01', action: 'SEED_CREATE', entityType: 'Organization', entityId: 'seed-org-01', after: { legalName: 'Demo Lone Star Medical Group LLC' } },
    { id: 'seed-audit-02', actorId: 'seed-user-manager', organizationId: 'seed-org-02', action: 'SEED_CREATE', entityType: 'Practice', entityId: 'seed-practice-02', after: { name: 'Gulf Coast Primary Care' } },
    { id: 'seed-audit-03', actorId: 'seed-user-credentialing', organizationId: 'seed-org-03', action: 'SEED_CREATE', entityType: 'CredentialingCase', entityId: 'seed-case-03', after: { status: 'VERIFICATION_PENDING' } },
    { id: 'seed-audit-04', actorId: 'seed-user-enrollment', organizationId: 'seed-org-04', action: 'SEED_CREATE', entityType: 'EnrollmentApplication', entityId: 'seed-enroll-04', after: { status: 'PAYER_REVIEW' } },
    { id: 'seed-audit-05', actorId: 'seed-user-approver', organizationId: 'seed-org-05', action: 'SEED_CREATE', entityType: 'Task', entityId: 'seed-task-05', after: { status: 'BLOCKED' } },
  ];
  for (const a of auditData) {
    await prisma.auditEvent.upsert({
      where: { id: a.id },
      update: { ...a, tenantId: demoTenant.id },
      create: { ...a, tenantId: demoTenant.id }
    });
  }

  const leaveTypes = [
    { id: 'seed-leave-annual', name: 'Annual Leave', code: 'ANNUAL', paid: true, annualDays: 15 },
    { id: 'seed-leave-sick', name: 'Sick Leave', code: 'SICK', paid: true, annualDays: 10 },
    { id: 'seed-leave-unpaid', name: 'Unpaid Leave', code: 'UNPAID', paid: false, annualDays: 0 }
  ];
  for (const lt of leaveTypes) {
    await prisma.leaveType.upsert({ where: { id: lt.id }, update: lt, create: { ...lt, active: true } });
  }
  const year = new Date().getFullYear();
  for (const u of users) {
    for (const lt of leaveTypes) {
      await prisma.leaveBalance.upsert({
        where: { userId_leaveTypeId_year: { userId: u.id, leaveTypeId: lt.id, year } },
        update: { entitled: lt.annualDays },
        create: { userId: u.id, leaveTypeId: lt.id, year, entitled: lt.annualDays, used: 0 }
      });
    }
  }

  await seedDirectories(prisma);

  console.log('Seed complete. Synthetic demo data created/updated:');
  console.log('- 1 demo tenant (demo-gpa-client), 5 tenant memberships, 5 users, organizations, practices, facilities, providers, licenses, documents, credentialing cases, payers, plans, enrollments, tasks, audit events, leave types/balances.');
  console.log(`Local demo password for all seeded users: ${SEED_PASSWORD}`);
  console.log('All names, identifiers, contact details, documents, and payer outcomes are synthetic test data. Do not use as real credentialing evidence.');
}

main().catch((error) => { console.error('Seed failed:', error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
