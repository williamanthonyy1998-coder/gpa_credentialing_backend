import { RecordStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type SpecialtySyncInput = {
  primarySpecialtyId?: string | null;
  secondarySpecialtyId?: string | null;
  primarySpecialty?: string | null;
  secondarySpecialty?: string | null;
};

export type LicenseSyncInput = {
  licenseTypeId?: string | null;
  usStateId?: string | null;
  type?: string | null;
  state?: string | null;
};

function deny(message: string, status = 400): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}

/** Active specialty required for new assignments; inactive allowed only when already set (caller passes allowInactive). */
export async function resolveSpecialtyId(
  idOrNull: string | null | undefined,
  opts: { allowInactive?: boolean } = {}
): Promise<{ id: string; name: string } | null> {
  if (!idOrNull) return null;
  const row = await prisma.specialty.findUnique({
    where: { id: idOrNull },
    select: { id: true, name: true, status: true }
  });
  if (!row) deny('Specialty not found', 404);
  if (!opts.allowInactive && row.status !== RecordStatus.ACTIVE) {
    deny('Selected specialty is inactive');
  }
  return { id: row.id, name: row.name };
}

export async function resolveSpecialtyByName(name: string | null | undefined) {
  const n = String(name || '').trim();
  if (!n) return null;
  return prisma.specialty.findFirst({
    where: { name: { equals: n, mode: 'insensitive' } },
    select: { id: true, name: true, status: true }
  });
}

export async function resolveLicenseType(
  idOrNull: string | null | undefined,
  opts: { allowInactive?: boolean } = {}
) {
  if (!idOrNull) return null;
  const row = await prisma.licenseType.findUnique({
    where: { id: idOrNull },
    select: { id: true, name: true, code: true, status: true }
  });
  if (!row) deny('License type not found', 404);
  if (!opts.allowInactive && row.status !== RecordStatus.ACTIVE) {
    deny('Selected license type is inactive');
  }
  return row;
}

export async function resolveUsState(
  idOrNull: string | null | undefined,
  opts: { allowInactive?: boolean } = {}
) {
  if (!idOrNull) return null;
  const row = await prisma.usState.findUnique({
    where: { id: idOrNull },
    select: { id: true, name: true, abbreviation: true, status: true }
  });
  if (!row) deny('State not found', 404);
  if (!opts.allowInactive && row.status !== RecordStatus.ACTIVE) {
    deny('Selected state is inactive');
  }
  return row;
}

export async function resolveUsStateByAbbrev(abbrev: string | null | undefined) {
  const a = String(abbrev || '').trim().toUpperCase();
  if (!a) return null;
  return prisma.usState.findFirst({
    where: { abbreviation: a },
    select: { id: true, name: true, abbreviation: true, status: true }
  });
}

/**
 * Normalize provider specialty fields: prefer IDs, sync legacy name strings,
 * reject duplicate primary/secondary assignment.
 */
export async function normalizeProviderSpecialtyFields(
  input: SpecialtySyncInput,
  opts: { forCreate: boolean }
) {
  const out: Record<string, unknown> = {};
  let primaryId = input.primarySpecialtyId;
  let secondaryId = input.secondarySpecialtyId;

  if (primaryId && secondaryId && primaryId === secondaryId) {
    deny('Primary and secondary specialty must be different');
  }

  if (primaryId === undefined && input.primarySpecialty) {
    const byName = await resolveSpecialtyByName(input.primarySpecialty);
    if (byName) primaryId = byName.id;
  }
  if (secondaryId === undefined && input.secondarySpecialty) {
    const byName = await resolveSpecialtyByName(input.secondarySpecialty);
    if (byName) secondaryId = byName.id;
  }

  if (primaryId !== undefined) {
    if (primaryId === null || primaryId === '') {
      out.primarySpecialtyId = null;
      if (input.primarySpecialty !== undefined) out.primarySpecialty = input.primarySpecialty || null;
      else out.primarySpecialty = null;
    } else {
      const primary = await resolveSpecialtyId(primaryId, { allowInactive: !opts.forCreate });
      out.primarySpecialtyId = primary!.id;
      out.primarySpecialty = primary!.name;
    }
  } else if (input.primarySpecialty !== undefined) {
    out.primarySpecialty = input.primarySpecialty || null;
  }

  if (secondaryId !== undefined) {
    if (secondaryId === null || secondaryId === '') {
      out.secondarySpecialtyId = null;
      if (input.secondarySpecialty !== undefined) out.secondarySpecialty = input.secondarySpecialty || null;
      else out.secondarySpecialty = null;
    } else {
      const secondary = await resolveSpecialtyId(secondaryId, { allowInactive: !opts.forCreate });
      out.secondarySpecialtyId = secondary!.id;
      out.secondarySpecialty = secondary!.name;
    }
  } else if (input.secondarySpecialty !== undefined) {
    out.secondarySpecialty = input.secondarySpecialty || null;
  }

  const p = (out.primarySpecialtyId as string | null | undefined) ?? primaryId;
  const s = (out.secondarySpecialtyId as string | null | undefined) ?? secondaryId;
  if (p && s && p === s) deny('Primary and secondary specialty must be different');

  return out;
}

export async function syncProviderSpecialtyJoin(
  providerId: string,
  primarySpecialtyId?: string | null,
  secondarySpecialtyId?: string | null
) {
  const desired: Array<{ specialtyId: string; isPrimary: boolean; isSecondary: boolean }> = [];
  if (primarySpecialtyId) {
    desired.push({ specialtyId: primarySpecialtyId, isPrimary: true, isSecondary: false });
  }
  if (secondarySpecialtyId && secondarySpecialtyId !== primarySpecialtyId) {
    desired.push({ specialtyId: secondarySpecialtyId, isPrimary: false, isSecondary: true });
  }

  const existing = await prisma.providerSpecialty.findMany({ where: { providerId } });
  const desiredIds = new Set(desired.map((d) => d.specialtyId));

  for (const row of existing) {
    if (!desiredIds.has(row.specialtyId) && (row.isPrimary || row.isSecondary)) {
      // Keep non-primary/secondary extras; clear flags on replaced primary/secondary
      if (row.isPrimary || row.isSecondary) {
        await prisma.providerSpecialty.delete({ where: { id: row.id } });
      }
    }
  }

  for (const d of desired) {
    await prisma.providerSpecialty.upsert({
      where: { providerId_specialtyId: { providerId, specialtyId: d.specialtyId } },
      update: { isPrimary: d.isPrimary, isSecondary: d.isSecondary },
      create: {
        providerId,
        specialtyId: d.specialtyId,
        isPrimary: d.isPrimary,
        isSecondary: d.isSecondary
      }
    });
  }
}

export async function normalizeLicenseFields(input: LicenseSyncInput, opts: { forCreate: boolean }) {
  const out: Record<string, unknown> = {};

  if (input.licenseTypeId !== undefined) {
    if (!input.licenseTypeId) {
      out.licenseTypeId = null;
      if (input.type !== undefined) out.type = input.type;
    } else {
      const lt = await resolveLicenseType(input.licenseTypeId, { allowInactive: !opts.forCreate });
      out.licenseTypeId = lt!.id;
      out.type = lt!.name;
    }
  } else if (input.type !== undefined) {
    out.type = input.type;
    const byName = await prisma.licenseType.findFirst({
      where: {
        OR: [
          { name: { equals: String(input.type), mode: 'insensitive' } },
          { code: { equals: String(input.type), mode: 'insensitive' } }
        ]
      },
      select: { id: true }
    });
    if (byName) out.licenseTypeId = byName.id;
  }

  if (input.usStateId !== undefined) {
    if (!input.usStateId) {
      out.usStateId = null;
      if (input.state !== undefined) out.state = input.state;
    } else {
      const st = await resolveUsState(input.usStateId, { allowInactive: !opts.forCreate });
      out.usStateId = st!.id;
      out.state = st!.abbreviation;
    }
  } else if (input.state !== undefined) {
    out.state = input.state;
    const byAbbrev = await resolveUsStateByAbbrev(input.state);
    if (byAbbrev) out.usStateId = byAbbrev.id;
  }

  return out;
}

/** Validate payer plan is ACTIVE for new enrollments; inactive allowed for existing views only. */
export async function assertPayerPlanAssignable(payerPlanId: string, opts: { requireActive: boolean }) {
  const plan = await prisma.payerPlan.findUnique({
    where: { id: payerPlanId },
    select: { id: true, status: true, payerId: true, payer: { select: { id: true, status: true } } }
  });
  if (!plan) deny('Payer plan not found', 404);
  if (opts.requireActive) {
    if (plan.status !== RecordStatus.ACTIVE) deny('Selected payer plan is inactive');
    if (plan.payer.status !== RecordStatus.ACTIVE) deny('Selected payer is inactive');
  }
  return plan;
}

export async function assertBillingEntityInTenant(tenantId: string, billingEntityId: string) {
  const row = await prisma.billingEntity.findFirst({
    where: { id: billingEntityId, tenantId },
    select: { id: true, status: true }
  });
  if (!row) deny('Billing entity not found', 404);
  return row;
}

export async function assertCredentialCategoryCodeAssignable(
  code: string,
  tenantId: string | null | undefined,
  opts: { forCreate: boolean }
) {
  const c = String(code || '').trim();
  if (!c) return null;

  // Any matching code (including other tenants) — detect cross-tenant misuse.
  const anyMatch = await prisma.credentialCategory.findMany({
    where: { code: c },
    select: { id: true, code: true, status: true, scope: true, tenantId: true }
  });
  if (!anyMatch.length) {
    // Legacy hardcoded codes remain acceptable if not yet in DB.
    return null;
  }

  const row =
    anyMatch.find((r) => r.scope === 'PLATFORM' && r.tenantId == null) ||
    anyMatch.find((r) => r.scope === 'TENANT' && tenantId && r.tenantId === tenantId) ||
    null;

  if (!row) {
    // Code exists only under another tenant — do not treat as legacy.
    deny('Credential category not found', 404);
  }
  if (opts.forCreate && row.status !== RecordStatus.ACTIVE) {
    deny('Selected credential category is inactive');
  }
  return row;
}

/** Normalize address.state free-text to abbreviation when it matches UsState. */
export async function normalizeAddressStateField(address: any) {
  if (!address || typeof address !== 'object') return address;
  const state = String(address.state || '').trim();
  if (!state) return address;
  const byAbbrev = await resolveUsStateByAbbrev(state);
  if (byAbbrev) return { ...address, state: byAbbrev.abbreviation };
  const byName = await prisma.usState.findFirst({
    where: { name: { equals: state, mode: 'insensitive' } },
    select: { abbreviation: true }
  });
  if (byName) return { ...address, state: byName.abbreviation };
  return address;
}
