/**
 * Phase 5B — automation policy resolution and admin CRUD helpers.
 * Policies are additive configuration; they never auto-change official enrollment statuses.
 */
import {
  AutomationPolicyKind,
  Prisma,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';

export type PolicyConfig = {
  intervalsDays?: number[];
  defaultIntervalDays?: number;
  thresholdsDays?: number[];
  windowsDays?: number[];
  targetRoles?: string[];
  channels?: string[];
  slaTargetDays?: number;
  dueSoonDays?: number;
  atRiskDays?: number;
  assignmentRole?: string;
  escalateOverdueTaskDays?: number;
  emailEnabled?: boolean;
  [key: string]: unknown;
};

export const DEFAULT_POLICY_SEEDS: Array<{
  kind: AutomationPolicyKind;
  name: string;
  description: string;
  config: PolicyConfig;
}> = [
  {
    kind: AutomationPolicyKind.FOLLOW_UP_INTERVAL,
    name: 'Default enrollment follow-up',
    description: 'Schedule next payer follow-up using configurable intervals.',
    config: { defaultIntervalDays: 7, intervalsDays: [3, 7, 14] }
  },
  {
    kind: AutomationPolicyKind.ESCALATION,
    name: 'Default pending escalation',
    description: 'Escalate pending applications at day thresholds without changing status.',
    config: { thresholdsDays: [7, 14, 30], targetRoles: ['CREDENTIALING_SPECIALIST', 'CREDENTIALING_MANAGER', 'ADMIN'] }
  },
  {
    kind: AutomationPolicyKind.SLA,
    name: 'Default enrollment SLA',
    description: 'Track turnaround against target days from creation/submission.',
    config: { slaTargetDays: 30, dueSoonDays: 7, atRiskDays: 3 }
  },
  {
    kind: AutomationPolicyKind.EXPIRY_ALERT,
    name: 'Default credential expiry alerts',
    description: 'Alert windows before license/credential/revalidation expiry.',
    config: { windowsDays: [90, 60, 30, 15, 7, 0], targetRoles: ['CREDENTIALING_SPECIALIST', 'CREDENTIALING_MANAGER'] }
  },
  {
    kind: AutomationPolicyKind.TASK_ASSIGNMENT,
    name: 'Default task assignment',
    description: 'Prefer organization employees with matching role; never grants ACL.',
    config: { assignmentRole: 'CREDENTIALING_SPECIALIST', escalateOverdueTaskDays: 3 }
  },
  {
    kind: AutomationPolicyKind.NOTIFICATION,
    name: 'Default notification channels',
    description: 'In-app always; email when configured.',
    config: { channels: ['IN_APP', 'EMAIL'], emailEnabled: true }
  }
];

export function canManageAutomationPolicies(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER;
}

export function canRunAutomationJobs(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.APPROVER
  );
}

export function canReadAutomation(role: Role) {
  return canRunAutomationJobs(role);
}

function deny(message: string, status = 400): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}

export function validatePolicyConfig(kind: AutomationPolicyKind, config: unknown): PolicyConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    deny('config must be an object');
  }
  const c = config as PolicyConfig;
  const positiveInts = (arr: unknown, label: string) => {
    if (arr == null) return;
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 3650)) {
      deny(`${label} must be an array of non-negative integers`);
    }
  };
  if (kind === AutomationPolicyKind.FOLLOW_UP_INTERVAL) {
    positiveInts(c.intervalsDays, 'intervalsDays');
    if (c.defaultIntervalDays != null && (!Number.isInteger(c.defaultIntervalDays) || c.defaultIntervalDays < 1)) {
      deny('defaultIntervalDays must be a positive integer');
    }
  }
  if (kind === AutomationPolicyKind.ESCALATION) {
    positiveInts(c.thresholdsDays, 'thresholdsDays');
  }
  if (kind === AutomationPolicyKind.SLA) {
    if (c.slaTargetDays != null && (!Number.isInteger(c.slaTargetDays) || c.slaTargetDays < 1)) {
      deny('slaTargetDays must be a positive integer');
    }
  }
  if (kind === AutomationPolicyKind.EXPIRY_ALERT) {
    positiveInts(c.windowsDays, 'windowsDays');
  }
  return c;
}

/** Most specific enabled policy wins: payer+org > org > payer > tenant > global seed. */
export async function resolvePolicy(input: {
  kind: AutomationPolicyKind;
  tenantId: string;
  organizationId?: string | null;
  payerId?: string | null;
}): Promise<{ id: string | null; config: PolicyConfig; name: string; source: string }> {
  const rows = await prisma.automationPolicy.findMany({
    where: {
      kind: input.kind,
      enabled: true,
      OR: [
        { tenantId: input.tenantId },
        { tenantId: null }
      ]
    },
    orderBy: { updatedAt: 'desc' },
    take: 100
  });

  const score = (r: typeof rows[0]) => {
    let s = 0;
    if (r.tenantId === input.tenantId) s += 10;
    if (r.organizationId && r.organizationId === input.organizationId) s += 40;
    else if (r.organizationId) return -1;
    if (r.payerId && r.payerId === input.payerId) s += 30;
    else if (r.payerId) return -1;
    return s;
  };

  let best: typeof rows[0] | null = null;
  let bestScore = -1;
  for (const r of rows) {
    const s = score(r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }

  if (best) {
    return {
      id: best.id,
      config: (best.config || {}) as PolicyConfig,
      name: best.name,
      source: 'database'
    };
  }

  const seed = DEFAULT_POLICY_SEEDS.find((s) => s.kind === input.kind)!;
  return { id: null, config: seed.config, name: seed.name, source: 'default' };
}

export async function ensureDefaultPoliciesForTenant(tenantId: string) {
  for (const seed of DEFAULT_POLICY_SEEDS) {
    const existing = await prisma.automationPolicy.findFirst({
      where: { tenantId, kind: seed.kind, name: seed.name, organizationId: null, payerId: null }
    });
    if (!existing) {
      await prisma.automationPolicy.create({
        data: {
          tenantId,
          kind: seed.kind,
          name: seed.name,
          description: seed.description,
          enabled: true,
          config: seed.config as Prisma.InputJsonValue
        }
      });
    }
  }
}

export async function listPolicies(input: {
  tenantId: string;
  kind?: AutomationPolicyKind;
  organizationId?: string;
}) {
  return prisma.automationPolicy.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {})
    },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }]
  });
}

export async function upsertPolicy(input: {
  tenantId: string;
  actorRole: Role;
  id?: string;
  organizationId?: string | null;
  payerId?: string | null;
  kind: AutomationPolicyKind;
  name: string;
  description?: string | null;
  enabled?: boolean;
  config: unknown;
}) {
  if (!canManageAutomationPolicies(input.actorRole)) deny('Insufficient permissions', 403);
  const config = validatePolicyConfig(input.kind, input.config);
  if (input.organizationId) {
    const org = await prisma.organization.findFirst({
      where: { id: input.organizationId, tenantId: input.tenantId }
    });
    if (!org) deny('Organization not found in tenant', 404);
  }
  if (input.payerId) {
    const payer = await prisma.payer.findUnique({ where: { id: input.payerId } });
    if (!payer) deny('Payer not found', 404);
  }

  if (input.id) {
    const existing = await prisma.automationPolicy.findFirst({
      where: { id: input.id, tenantId: input.tenantId }
    });
    if (!existing) deny('Policy not found', 404);
    return prisma.automationPolicy.update({
      where: { id: existing.id },
      data: {
        organizationId: input.organizationId === undefined ? existing.organizationId : input.organizationId,
        payerId: input.payerId === undefined ? existing.payerId : input.payerId,
        name: input.name,
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        config: config as Prisma.InputJsonValue
      }
    });
  }

  return prisma.automationPolicy.create({
    data: {
      tenantId: input.tenantId,
      organizationId: input.organizationId || null,
      payerId: input.payerId || null,
      kind: input.kind,
      name: input.name,
      description: input.description || null,
      enabled: input.enabled !== false,
      config: config as Prisma.InputJsonValue
    }
  });
}
