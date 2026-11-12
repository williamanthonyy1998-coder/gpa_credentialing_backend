import {
  DirectoryScope,
  Prisma,
  RecordStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  evaluateConditions,
  validateConditionSchema,
  type EvaluationContext
} from './requirementConditions';

/**
 * Phase 4B — Resolve applicable payer requirements with scope precedence.
 * Precedence (highest wins per code): TENANT+plan > TENANT+payer > PLATFORM+plan > PLATFORM+payer > PLATFORM global.
 * Same-specificity conflicts are surfaced (not silently chosen).
 */

export type ResolvedRequirement = {
  id: string;
  code: string | null;
  title: string;
  category: string | null;
  isRequired: boolean;
  version: number;
  scope: DirectoryScope;
  payerId: string | null;
  payerPlanId: string | null;
  tenantId: string | null;
  documentCategoryCode: string | null;
  tracksExpiration: boolean;
  requirementKind: string | null;
  instructions: string | null;
  source: string | null;
  sourceReference: string | null;
  specificity: number;
  applies: boolean;
  applicabilityReason: string;
  conflict?: boolean;
  conflictWithIds?: string[];
  snapshot: Record<string, unknown>;
};

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canManagePlatformRequirements(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER;
}

export function canManageTenantRequirements(role: Role) {
  return (
    canManagePlatformRequirements(role)
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canReviewPacket(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canWaiveOrVerify(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER || role === Role.APPROVER;
}

/** Higher = more specific. */
export function requirementSpecificity(row: {
  scope: DirectoryScope;
  tenantId?: string | null;
  payerId?: string | null;
  payerPlanId?: string | null;
}): number {
  const tenantBoost = row.scope === DirectoryScope.TENANT || row.tenantId ? 10 : 0;
  if (row.payerPlanId) return 3 + tenantBoost;
  if (row.payerId) return 2 + tenantBoost;
  return 1 + tenantBoost;
}

function asStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return [];
}

function inEffectiveWindow(
  row: { effectiveFrom?: Date | null; effectiveTo?: Date | null },
  asOf: Date
) {
  if (row.effectiveFrom && row.effectiveFrom > asOf) return false;
  if (row.effectiveTo && row.effectiveTo < asOf) return false;
  return true;
}

function legacyApplies(
  row: {
    enrollmentTypes?: unknown;
    appliesToProviderTypes?: unknown;
    appliesToSpecialties?: unknown;
    appliesToStates?: unknown;
    appliesToFacility?: boolean;
    appliesToGroup?: boolean;
  },
  ctx: EvaluationContext & { enrollmentType?: string | null }
): { ok: boolean; reason: string } {
  const types = asStringArray(row.enrollmentTypes);
  if (types.length && ctx.enrollmentType && !types.includes(ctx.enrollmentType)) {
    return { ok: false, reason: `Enrollment type ${ctx.enrollmentType} not in [${types.join(',')}]` };
  }
  if (row.appliesToFacility && !ctx.hasFacility) {
    return { ok: false, reason: 'Requires facility association' };
  }
  if (row.appliesToGroup && ctx.enrollmentType === 'INDIVIDUAL') {
    // Group flag alone does not exclude individual unless enrollmentTypes set
  }
  const specialties = asStringArray(row.appliesToSpecialties);
  if (specialties.length) {
    if (!ctx.specialty) return { ok: false, reason: 'Specialty missing for specialty-scoped requirement' };
    if (!specialties.map((s) => s.toLowerCase()).includes(String(ctx.specialty).toLowerCase())) {
      return { ok: false, reason: `Specialty ${ctx.specialty} not in configured list` };
    }
  }
  const states = asStringArray(row.appliesToStates);
  if (states.length) {
    if (!ctx.state) return { ok: false, reason: 'State missing for jurisdiction-scoped requirement' };
    if (!states.map((s) => s.toUpperCase()).includes(String(ctx.state).toUpperCase())) {
      return { ok: false, reason: `State ${ctx.state} not in configured list` };
    }
  }
  const providerTypes = asStringArray(row.appliesToProviderTypes);
  if (providerTypes.length) {
    if (!ctx.providerType) return { ok: false, reason: 'Provider type missing for type-scoped requirement' };
    if (!providerTypes.map((s) => s.toLowerCase()).includes(String(ctx.providerType).toLowerCase())) {
      return { ok: false, reason: `Provider type ${ctx.providerType} not in configured list` };
    }
  }
  return { ok: true, reason: 'Legacy applicability filters passed' };
}

export async function listPayerRequirements(input: {
  tenantId?: string | null;
  payerId?: string | null;
  payerPlanId?: string | null;
  category?: string | null;
  status?: RecordStatus | null;
  includeInactive?: boolean;
}) {
  const and: Prisma.PayerRequirementWhereInput[] = [];
  if (!input.includeInactive) {
    and.push({ status: input.status || RecordStatus.ACTIVE });
  } else if (input.status) {
    and.push({ status: input.status });
  }
  if (input.payerId) {
    and.push({ OR: [{ payerId: input.payerId }, { payerId: null }] });
  }
  if (input.payerPlanId) {
    and.push({ OR: [{ payerPlanId: input.payerPlanId }, { payerPlanId: null }] });
  }
  if (input.category) and.push({ category: input.category });
  // Platform + this tenant only
  and.push({
    OR: [
      { scope: DirectoryScope.PLATFORM, tenantId: null },
      ...(input.tenantId
        ? [{ scope: DirectoryScope.TENANT, tenantId: input.tenantId }]
        : [])
    ]
  });
  return prisma.payerRequirement.findMany({
    where: { AND: and },
    include: {
      payer: { select: { id: true, name: true } },
      payerPlan: { select: { id: true, name: true, payerId: true } }
    },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }]
  });
}

export async function resolveApplicableRequirements(input: {
  tenantId: string;
  payerId: string;
  payerPlanId: string;
  enrollmentType: string;
  asOf?: Date;
  context: EvaluationContext;
}): Promise<{ items: ResolvedRequirement[]; conflicts: ResolvedRequirement[] }> {
  const asOf = input.asOf || new Date();
  const ctx: EvaluationContext = {
    ...input.context,
    enrollmentType: input.enrollmentType,
    payerPlanId: input.payerPlanId
  };

  const candidates = await prisma.payerRequirement.findMany({
    where: {
      status: RecordStatus.ACTIVE,
      OR: [
        { scope: DirectoryScope.PLATFORM, tenantId: null },
        { scope: DirectoryScope.TENANT, tenantId: input.tenantId }
      ],
      AND: [
        {
          OR: [
            { payerId: null, payerPlanId: null },
            { payerId: input.payerId, payerPlanId: null },
            { payerPlanId: input.payerPlanId }
          ]
        }
      ]
    },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }]
  });

  const evaluated: ResolvedRequirement[] = [];
  for (const row of candidates) {
    if (!inEffectiveWindow(row, asOf)) continue;
    // Plan-scoped must belong to selected payer
    if (row.payerPlanId && row.payerPlanId !== input.payerPlanId) continue;
    if (row.payerId && !row.payerPlanId && row.payerId !== input.payerId) continue;

    const legacy = legacyApplies(row, ctx);
    const cond = evaluateConditions(row.conditions, ctx);
    const applies = legacy.ok && cond.applies && !cond.invalid;
    const reasons = [
      `specificity=${requirementSpecificity(row)}`,
      legacy.reason,
      ...cond.reasons
    ];
    evaluated.push({
      id: row.id,
      code: row.code,
      title: row.title,
      category: row.category,
      isRequired: row.isRequired,
      version: row.version,
      scope: row.scope,
      payerId: row.payerId,
      payerPlanId: row.payerPlanId,
      tenantId: row.tenantId,
      documentCategoryCode: row.documentCategoryCode,
      tracksExpiration: row.tracksExpiration,
      requirementKind: row.requirementKind,
      instructions: row.instructions,
      source: row.source,
      sourceReference: row.sourceReference,
      specificity: requirementSpecificity(row),
      applies,
      applicabilityReason: reasons.join('; '),
      snapshot: {
        id: row.id,
        code: row.code,
        title: row.title,
        category: row.category,
        isRequired: row.isRequired,
        version: row.version,
        scope: row.scope,
        documentCategoryCode: row.documentCategoryCode,
        tracksExpiration: row.tracksExpiration,
        requirementKind: row.requirementKind,
        instructions: row.instructions,
        conditions: row.conditions,
        source: row.source,
        sourceReference: row.sourceReference
      }
    });
  }

  // Group by code (fallback title) among applicable
  const applicable = evaluated.filter((e) => e.applies);
  const byKey = new Map<string, ResolvedRequirement[]>();
  for (const item of applicable) {
    const key = (item.code || item.title).toLowerCase();
    const list = byKey.get(key) || [];
    list.push(item);
    byKey.set(key, list);
  }

  const winners: ResolvedRequirement[] = [];
  const conflicts: ResolvedRequirement[] = [];
  for (const [, group] of byKey) {
    const maxSpec = Math.max(...group.map((g) => g.specificity));
    const top = group.filter((g) => g.specificity === maxSpec);
    if (top.length > 1) {
      // Same specificity — conflict
      for (const t of top) {
        t.conflict = true;
        t.conflictWithIds = top.filter((x) => x.id !== t.id).map((x) => x.id);
        conflicts.push(t);
      }
      // Still include highest title-sorted for visibility but mark conflict
      top.sort((a, b) => a.title.localeCompare(b.title));
      winners.push(top[0]);
    } else {
      winners.push(top[0]);
    }
  }

  winners.sort((a, b) => a.title.localeCompare(b.title));
  return { items: winners, conflicts };
}

export async function previewRequirements(input: {
  tenantId: string;
  payerId: string;
  payerPlanId: string;
  enrollmentType: string;
  specialty?: string | null;
  state?: string | null;
  hasFacility?: boolean;
  hasBillingEntity?: boolean;
  providerType?: string | null;
  asOf?: Date;
}) {
  const plan = await prisma.payerPlan.findUnique({
    where: { id: input.payerPlanId },
    include: { payer: true }
  });
  if (!plan) deny('Payer plan not found', 404);
  if (plan.payerId !== input.payerId) deny('Payer plan does not belong to selected payer');
  if (plan.status !== RecordStatus.ACTIVE || plan.payer.status !== RecordStatus.ACTIVE) {
    deny('Payer and plan must be active');
  }
  return resolveApplicableRequirements({
    tenantId: input.tenantId,
    payerId: input.payerId,
    payerPlanId: input.payerPlanId,
    enrollmentType: input.enrollmentType,
    asOf: input.asOf,
    context: {
      specialty: input.specialty,
      state: input.state,
      hasFacility: input.hasFacility,
      hasBillingEntity: input.hasBillingEntity,
      providerType: input.providerType,
      enrollmentType: input.enrollmentType,
      payerPlanId: input.payerPlanId
    }
  });
}

export function normalizeRequirementWrite(body: any, actorRole: Role, tenantId: string | null) {
  if (body.conditions !== undefined && body.conditions !== null) {
    body.conditions = validateConditionSchema(body.conditions);
  }
  if (body.scope === DirectoryScope.PLATFORM || body.scope === 'PLATFORM') {
    if (!canManagePlatformRequirements(actorRole)) {
      deny('Only GPA platform administrators may manage PLATFORM requirements', 403);
    }
    body.tenantId = null;
    body.scope = DirectoryScope.PLATFORM;
  } else if (body.scope === DirectoryScope.TENANT || body.scope === 'TENANT') {
    if (!canManageTenantRequirements(actorRole)) {
      deny('Insufficient permissions for tenant requirements', 403);
    }
    if (!tenantId) deny('Tenant context required for tenant-scoped requirements');
    body.tenantId = tenantId;
    body.scope = DirectoryScope.TENANT;
  }
  // Client users never reach here for writes — routes enforce
  return body;
}

export async function recordRequirementHistory(input: {
  requirementId: string;
  version: number;
  snapshot: unknown;
  changedById?: string | null;
  changeReason?: string | null;
}) {
  await prisma.payerRequirementHistory.create({
    data: {
      requirementId: input.requirementId,
      version: input.version,
      snapshot: input.snapshot as any,
      changedById: input.changedById || null,
      changeReason: input.changeReason || null
    }
  });
}

export async function bumpRequirementVersion(
  requirementId: string,
  actorId: string,
  reason?: string | null
) {
  const before = await prisma.payerRequirement.findUnique({ where: { id: requirementId } });
  if (!before) deny('Requirement not found', 404);
  await recordRequirementHistory({
    requirementId,
    version: before.version,
    snapshot: before,
    changedById: actorId,
    changeReason: reason || 'Version bump before material update'
  });
  return prisma.payerRequirement.update({
    where: { id: requirementId },
    data: { version: before.version + 1 }
  });
}
