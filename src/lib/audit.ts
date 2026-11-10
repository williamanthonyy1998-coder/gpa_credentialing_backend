import { prisma } from './prisma';
import { AuthRequest } from '../middleware/auth';
function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const output: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(ssn|bankAccountNumber|bankRoutingNumber|bankPhoneNumber|bankTitle|bankAccountHolder|passwordHash|policyNumber|perOccurrence|aggregate|storageKey|signedUrl)$/i.test(key)) output[key] = '[REDACTED]';
    else output[key] = redact(item);
  }
  return output;
}
export async function audit(req: AuthRequest, action: string, entityType: string, entityId?: string, before?: unknown, after?: unknown) {
  let organizationId: string | undefined;
  const snapshot: any = (after || before) as any;
  organizationId = snapshot?.organizationId || undefined;
  if (entityType === 'organizations') organizationId = entityId;
  if (!organizationId && entityType === 'cases' && snapshot?.practiceId) organizationId = (await prisma.practice.findUnique({ where: { id: snapshot.practiceId }, select: { organizationId: true } }))?.organizationId;
  if (!organizationId && entityType === 'tasks' && snapshot?.enrollmentId) organizationId = (await prisma.enrollmentApplication.findUnique({ where: { id: snapshot.enrollmentId }, select: { organizationId: true } }))?.organizationId || undefined;
  if (!organizationId && entityType === 'tasks' && snapshot?.caseId) organizationId = (await prisma.credentialingCase.findUnique({ where: { id: snapshot.caseId }, select: { practice: { select: { organizationId: true } } } }))?.practice?.organizationId;
  await prisma.auditEvent.create({ data: {
    actorId: req.user?.id, organizationId, action, entityType, entityId,
    before: redact(before) as any, after: redact(after) as any,
    ipAddress: req.ip
  }});
}
