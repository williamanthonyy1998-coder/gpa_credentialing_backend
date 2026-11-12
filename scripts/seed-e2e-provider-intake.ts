/**
 * Phase 2C synthetic E2E seed.
 *
 * SAFETY:
 * - Refuses to run unless DATABASE_URL database name matches *_e2e / *_test / credentialing_e2e
 *   OR E2E_SAFE_DATABASE=1 is explicitly set.
 * - Uses only @e2e.credentialing.test emails and known synthetic NPIs.
 * - Idempotent upserts keyed by email/slug/reference.
 *
 * Usage:
 *   DATABASE_URL=.../credentialing_e2e E2E_SAFE_DATABASE=1 npx tsx scripts/seed-e2e-provider-intake.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  IntakeStatus,
  Prisma,
  Role,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const DOMAIN = 'e2e.credentialing.test';
const PASSWORD = 'E2eTest-Password-ChangeMe-2026!';

function databaseNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || '').replace(/^\//, '').split('?')[0];
  } catch {
    return '';
  }
}

function assertSafeDatabase() {
  const url = process.env.DATABASE_URL || '';
  const name = databaseNameFromUrl(url);
  const allowedByName = /(_e2e|_test)$/i.test(name) || /^credentialing_e2e$/i.test(name);
  const allowedByFlag = process.env.E2E_SAFE_DATABASE === '1' && /credentialing/i.test(name);
  if (!allowedByName && !allowedByFlag) {
    console.error(`Refusing E2E seed: database "${name}" is not recognized as a test database.`);
    console.error('Use a DB named *_e2e / *_test, or set E2E_SAFE_DATABASE=1 for an explicitly approved credentialing* DB.');
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'production' && process.env.E2E_ALLOW_PRODUCTION !== '1') {
    console.error('Refusing E2E seed in production.');
    process.exit(2);
  }
  console.log(`E2E seed targeting database: ${name}`);
}

async function upsertUser(email: string, name: string, role: Role) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return prisma.user.upsert({
    where: { email },
    create: { email, name, role, passwordHash, active: true },
    update: { name, role, passwordHash, active: true }
  });
}

async function upsertTenant(slug: string, name: string) {
  return prisma.tenant.upsert({
    where: { slug },
    create: { slug, name, status: TenantStatus.ACTIVE, onboardingStatus: 'ACTIVE' },
    update: { name, status: TenantStatus.ACTIVE }
  });
}

async function ensureMembership(userId: string, tenantId: string, role: TenantRole) {
  return prisma.tenantMembership.upsert({
    where: { userId_tenantId: { userId, tenantId } },
    create: { userId, tenantId, role, status: 'ACTIVE' },
    update: { role, status: 'ACTIVE' }
  });
}

async function main() {
  assertSafeDatabase();

  const gpaAdmin = await upsertUser(`gpa.admin@${DOMAIN}`, 'E2E GPA Admin', Role.ADMIN);
  const clientA = await upsertUser(`client.a.admin@${DOMAIN}`, 'E2E Client A Admin', Role.CLIENT_USER);
  const clientB = await upsertUser(`client.b.admin@${DOMAIN}`, 'E2E Client B Admin', Role.CLIENT_USER);
  const providerA = await upsertUser(`provider.a@${DOMAIN}`, 'E2E Provider A', Role.EXTERNAL_PROVIDER);
  const providerB = await upsertUser(`provider.b@${DOMAIN}`, 'E2E Provider B', Role.EXTERNAL_PROVIDER);

  const tenantA = await upsertTenant('e2e-tenant-a', 'E2E Tenant A');
  const tenantB = await upsertTenant('e2e-tenant-b', 'E2E Tenant B');

  await ensureMembership(clientA.id, tenantA.id, TenantRole.TENANT_ADMIN);
  await ensureMembership(clientB.id, tenantB.id, TenantRole.TENANT_ADMIN);
  await ensureMembership(gpaAdmin.id, tenantA.id, TenantRole.TENANT_ADMIN);

  const orgA = await prisma.organization.upsert({
    where: { id: 'e2e-org-a-fixed' },
    create: {
      id: 'e2e-org-a-fixed',
      tenantId: tenantA.id,
      legalName: 'E2E Organization A',
      status: 'ACTIVE'
    },
    update: { tenantId: tenantA.id, legalName: 'E2E Organization A', status: 'ACTIVE' }
  }).catch(async () => {
    const existing = await prisma.organization.findFirst({
      where: { tenantId: tenantA.id, legalName: 'E2E Organization A' }
    });
    if (existing) return existing;
    return prisma.organization.create({
      data: { tenantId: tenantA.id, legalName: 'E2E Organization A', status: 'ACTIVE' }
    });
  });

  const orgB = await prisma.organization.findFirst({
    where: { tenantId: tenantB.id, legalName: 'E2E Organization B' }
  }) || await prisma.organization.create({
    data: { tenantId: tenantB.id, legalName: 'E2E Organization B', status: 'ACTIVE' }
  });

  let practiceA = await prisma.practice.findFirst({
    where: { organizationId: orgA.id, name: 'E2E Practice A' }
  });
  if (!practiceA) {
    practiceA = await prisma.practice.create({
      data: { organizationId: orgA.id, name: 'E2E Practice A', status: 'ACTIVE' }
    });
  }

  // Baseline intakes for cross-tenant isolation checks
  const intakeA = await prisma.intakeRequest.upsert({
    where: { referenceNo: 'E2E-INTAKE-A' },
    create: {
      referenceNo: 'E2E-INTAKE-A',
      tenantId: tenantA.id,
      organizationId: orgA.id,
      kind: 'PROVIDER',
      status: IntakeStatus.DRAFT,
      createdById: gpaAdmin.id,
      contactEmail: `provider.a@${DOMAIN}`,
      invitedEmail: `provider.a@${DOMAIN}`,
      contactName: 'E2E Provider A',
      payload: { provider: { email: `provider.a@${DOMAIN}` } }
    },
    update: {
      tenantId: tenantA.id,
      organizationId: orgA.id,
      status: IntakeStatus.DRAFT,
          providerUserId: null,
      submittedPayload: Prisma.DbNull,
      currentSubmissionVersion: 0
    }
  });

  const intakeB = await prisma.intakeRequest.upsert({
    where: { referenceNo: 'E2E-INTAKE-B' },
    create: {
      referenceNo: 'E2E-INTAKE-B',
      tenantId: tenantB.id,
      organizationId: orgB.id,
      kind: 'PROVIDER',
      status: IntakeStatus.IN_PROGRESS,
      createdById: gpaAdmin.id,
      providerUserId: providerB.id,
      contactEmail: `provider.b@${DOMAIN}`,
      invitedEmail: `provider.b@${DOMAIN}`,
      contactName: 'E2E Provider B',
      payload: {
        provider: {
          firstName: 'Other',
          lastName: 'Provider',
          npi: '1245319599',
          email: `provider.b@${DOMAIN}`
        }
      }
    },
    update: {
      tenantId: tenantB.id,
      providerUserId: providerB.id,
      status: IntakeStatus.IN_PROGRESS
    }
  });

  const out = {
    password: PASSWORD,
    domain: DOMAIN,
    users: {
      gpaAdmin: { email: gpaAdmin.email, id: gpaAdmin.id },
      clientA: { email: clientA.email, id: clientA.id },
      clientB: { email: clientB.email, id: clientB.id },
      providerA: { email: providerA.email, id: providerA.id },
      providerB: { email: providerB.email, id: providerB.id }
    },
    tenants: {
      a: { id: tenantA.id, slug: tenantA.slug, name: tenantA.name },
      b: { id: tenantB.id, slug: tenantB.slug, name: tenantB.name }
    },
    organizations: { a: orgA.id, b: orgB.id },
    practiceA: practiceA.id,
    intakes: { a: intakeA.id, b: intakeB.id, refA: intakeA.referenceNo, refB: intakeB.referenceNo }
  };

  const fixturePath = path.resolve(process.cwd(), '../frontend/e2e/fixtures.e2e.json');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, JSON.stringify(out, null, 2));
  console.log(`Wrote fixtures to ${fixturePath}`);
  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
