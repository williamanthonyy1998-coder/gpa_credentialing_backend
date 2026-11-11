import { prisma } from '../lib/prisma';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = typeof prisma | Tx;

/** Unique application number generated server-side; never user-entered. */
export async function generateApplicationNo(db: Db = prisma): Promise<string> {
  const count = await db.enrollmentApplication.count();
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `ENR-${String(count + 1 + attempt).padStart(6, '0')}`;
    const exists = await db.enrollmentApplication.findUnique({
      where: { applicationNo: candidate },
      select: { id: true }
    });
    if (!exists) return candidate;
  }
  return `ENR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function providerNameFromParts(firstName?: string | null, lastName?: string | null, npi?: string | null): string {
  const name = `${firstName || ''} ${lastName || ''}`.trim();
  return name || npi || '';
}

/**
 * Provider Name column rules:
 * - provider assigned → provider name
 * - otherwise → facility name (responsible entity)
 * - never blank/null/undefined for callers that pass a facility fallback
 */
export function enrollmentProviderDisplayName(row: {
  provider?: { firstName?: string | null; lastName?: string | null; npi?: string | null } | null;
  facility?: { name?: string | null } | null;
  practice?: { name?: string | null } | null;
  organization?: { legalName?: string | null; dba?: string | null } | null;
}): string {
  const providerName = providerNameFromParts(
    row.provider?.firstName,
    row.provider?.lastName,
    row.provider?.npi
  );
  if (providerName) return providerName;
  if (row.facility?.name) return row.facility.name;
  if (row.practice?.name) return row.practice.name;
  if (row.organization?.legalName || row.organization?.dba) {
    return row.organization.legalName || row.organization.dba || '—';
  }
  return '—';
}

export function enrollmentFacilityDisplayName(row: {
  facility?: { name?: string | null } | null;
  practice?: { name?: string | null } | null;
}): string {
  return row.facility?.name || row.practice?.name || '—';
}

export type AssigneeUser = { id: string; name?: string | null; email?: string | null };

/** Resolve assignee display name from a user lookup map keyed by lowercased email. */
export function enrollmentAssigneeDisplayName(
  assignedTo?: string | null,
  usersByEmail?: Map<string, AssigneeUser>
): string {
  const key = String(assignedTo || '').trim().toLowerCase();
  if (!key) return '—';
  const user = usersByEmail?.get(key);
  if (user?.name && String(user.name).trim()) return String(user.name).trim();
  return String(assignedTo).trim() || '—';
}

export async function loadAssigneeMap(
  assignedEmails: Array<string | null | undefined>,
  db: Db = prisma
): Promise<Map<string, AssigneeUser>> {
  const emails = [...new Set(
    assignedEmails
      .map(e => String(e || '').trim())
      .filter(Boolean)
  )];
  const map = new Map<string, AssigneeUser>();
  if (!emails.length) return map;
  const users = await db.user.findMany({
    where: { OR: emails.map(email => ({ email: { equals: email, mode: 'insensitive' as const } })) },
    select: { id: true, name: true, email: true }
  });
  for (const u of users) {
    if (u.email) map.set(u.email.toLowerCase(), u);
  }
  return map;
}

export function enrollmentSubjectDisplay(row: {
  subject?: string | null;
  provider?: { firstName?: string | null; lastName?: string | null; npi?: string | null } | null;
  facility?: { name?: string | null } | null;
  organization?: { legalName?: string | null; dba?: string | null } | null;
}): string {
  if (row.subject && String(row.subject).trim()) return String(row.subject).trim();
  const providerName = providerNameFromParts(
    row.provider?.firstName,
    row.provider?.lastName,
    row.provider?.npi
  );
  if (providerName) return providerName;
  if (row.facility?.name) return row.facility.name;
  if (row.organization?.legalName || row.organization?.dba) {
    return row.organization.legalName || row.organization.dba || '—';
  }
  return '—';
}

/** Resolve org/practice from facility and validate optional provider affiliation. */
export async function resolveEnrollmentLinks(input: {
  facilityId: string;
  practiceId?: string | null;
  organizationId?: string | null;
  providerId?: string | null;
  payerPlanId: string;
  payerId?: string | null;
}, db: Db = prisma) {
  const facility = await db.facility.findUnique({
    where: { id: input.facilityId },
    select: {
      id: true,
      practiceId: true,
      organizationId: true,
      practice: { select: { organizationId: true } }
    }
  });
  if (!facility) {
    const err: any = new Error('Selected facility was not found');
    err.status = 400;
    throw err;
  }

  const facilityOrg = facility.organizationId || facility.practice?.organizationId || null;
  const practiceId = input.practiceId || facility.practiceId || null;
  let organizationId = input.organizationId || facilityOrg;

  if (practiceId) {
    const practice = await db.practice.findUnique({
      where: { id: practiceId },
      select: { organizationId: true }
    });
    if (!practice) {
      const err: any = new Error('Selected practice was not found');
      err.status = 400;
      throw err;
    }
    if (facility.practiceId && facility.practiceId !== practiceId) {
      const err: any = new Error('Selected facility does not belong to the selected practice');
      err.status = 400;
      throw err;
    }
    if (organizationId && organizationId !== practice.organizationId) {
      const err: any = new Error('Enrollment organization must match the selected practice organization');
      err.status = 400;
      throw err;
    }
    organizationId = organizationId || practice.organizationId;
  }

  if (organizationId && facilityOrg && organizationId !== facilityOrg) {
    const err: any = new Error('Enrollment organization must match the selected facility organization');
    err.status = 400;
    throw err;
  }

  const plan = await db.payerPlan.findUnique({
    where: { id: input.payerPlanId },
    select: { id: true, payerId: true }
  });
  if (!plan) {
    const err: any = new Error('Selected payer plan was not found');
    err.status = 400;
    throw err;
  }
  if (input.payerId && plan.payerId !== input.payerId) {
    const err: any = new Error('Selected payer plan does not belong to the selected payer');
    err.status = 400;
    throw err;
  }

  let providerId = input.providerId || null;
  if (providerId) {
    const link = await db.providerFacility.findUnique({
      where: { providerId_facilityId: { providerId, facilityId: facility.id } },
      select: { providerId: true }
    });
    if (!link) {
      const err: any = new Error('Selected provider is not affiliated with the selected facility');
      err.status = 400;
      throw err;
    }
  }

  return {
    facilityId: facility.id,
    practiceId,
    organizationId,
    providerId,
    payerPlanId: plan.id
  };
}
