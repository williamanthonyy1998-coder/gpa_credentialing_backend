import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { AuthRequest } from '../middleware/auth';

const REDACT_KEYS = /^(ssn|taxId|bankAccountNumber|bankRoutingNumber|bankPhoneNumber|bankTitle|bankAccountHolder|passwordHash|policyNumber|perOccurrence|aggregate|storageKey|signedUrl|token|tokenHash|rawToken|invitationToken|accessToken|refreshToken)$/i;

function isDecimalLike(value: unknown): value is { toNumber: () => number; toString: () => string } {
  if (value == null || typeof value !== 'object') return false;
  if (Prisma.Decimal.isDecimal(value)) return true;
  // Duck-type decimal.js instances when multiple copies break instanceof / isDecimal.
  const v = value as Record<string, unknown>;
  return typeof (v as any).toNumber === 'function'
    && typeof (v as any).toFixed === 'function'
    && 's' in v && 'e' in v && 'd' in v;
}

/** Convert Prisma/JSON payloads into JSON-safe values (Decimals, BigInts, Dates, etc.). */
function redact(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (isDecimalLike(value)) {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : value.toString();
  }
  if (Array.isArray(value)) return value.map(redact);

  const output: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const item = (value as any)[key];
    if (typeof item === 'function') continue;
    if (REDACT_KEYS.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      const next = redact(item);
      if (next !== undefined) output[key] = next;
    }
  }
  return output;
}

export async function audit(req: AuthRequest, action: string, entityType: string, entityId?: string, before?: unknown, after?: unknown) {
  let organizationId: string | undefined;
  const snapshot: any = (after || before) as any;
  organizationId = snapshot?.organizationId || undefined;
  if (entityType === 'organizations') organizationId = entityId;
  if (!organizationId && snapshot?.practiceId) {
    organizationId = (await prisma.practice.findUnique({ where: { id: snapshot.practiceId }, select: { organizationId: true } }))?.organizationId;
  }
  if (!organizationId && entityType === 'tasks' && snapshot?.enrollmentId) {
    organizationId = (await prisma.enrollmentApplication.findUnique({ where: { id: snapshot.enrollmentId }, select: { organizationId: true } }))?.organizationId || undefined;
  }
  if (!organizationId && entityType === 'tasks' && snapshot?.caseId) {
    organizationId = (await prisma.credentialingCase.findUnique({ where: { id: snapshot.caseId }, select: { practice: { select: { organizationId: true } } } }))?.practice?.organizationId;
  }
  const tenantId = req.tenantContext?.tenantId || undefined;
  await prisma.auditEvent.create({ data: {
    actorId: req.user?.id,
    tenantId,
    organizationId,
    action,
    entityType,
    entityId,
    before: redact(before) as any,
    after: redact(after) as any,
    ipAddress: req.ip
  }});
}
