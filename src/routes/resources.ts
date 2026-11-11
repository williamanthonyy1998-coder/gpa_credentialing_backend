import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { Role } from '@prisma/client';
import { assertCaseTransition, assertEnrollmentTransition, allowedCaseTransitions, daysConsumed } from '../services/workflow';
import { assertResourceRecordAccess } from '../services/orgAccess';
import { profileCompletion } from '../services/profileCompletion';
import { notifyUser } from '../services/notifications';
import { generateApplicationNo } from '../services/enrollments';

const router = Router();
function sanitizeRow(row: any, role: Role, resource: string) {
  if (!row) return row;
  if (role === Role.ADMIN) return row;
  const copy = { ...row };
  if (resource === 'providers' && role !== Role.CREDENTIALING_MANAGER) delete copy.ssn;
  if (resource === 'organizations') {
    delete copy.bankAccountNumber;
    delete copy.bankRoutingNumber;
    if (role !== Role.CREDENTIALING_MANAGER) delete copy.taxId;
  }
  if (resource === 'practices') {
    delete copy.bankAccountNumber;
    delete copy.bankRoutingNumber;
    if (role !== Role.CREDENTIALING_MANAGER) delete copy.taxId;
  }
  if (resource === 'documents' && role !== Role.CREDENTIALING_MANAGER) {
    if (copy.bankRoutingNumber) {
      const digits = String(copy.bankRoutingNumber).replace(/\D/g, '');
      copy.bankRoutingNumber = digits.length >= 4 ? `••••${digits.slice(-4)}` : '[REDACTED]';
    }
  }
  return copy;
}
router.get('/audit', async (req, res, next) => { try { const organizationId = String(req.query.organizationId || '').trim(); const rows = await prisma.auditEvent.findMany({ where: organizationId ? { organizationId } : {}, select: { id: true, action: true, entityType: true, entityId: true, ipAddress: true, createdAt: true, actor: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }); res.json(rows); } catch (e) { next(e); } });
const schemas: Record<string, z.ZodTypeAny> = {
  organizations: z.object({ legalName: z.string().min(2), dba: z.string().optional().nullable(), taxId: z.string().optional().nullable(), establishedAt: z.coerce.date().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().email().optional().or(z.literal('')).nullable(), mailingAddress: z.any().optional(), ownership: z.any().optional(), bankName: z.string().optional().nullable(), bankAccountTitle: z.string().optional().nullable(), bankAccountNumber: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankContactName: z.string().optional().nullable(), bankContactPhone: z.string().optional().nullable(), bankContactEmail: z.string().optional().nullable() }),
  practices: z.object({ organizationId: z.string().min(1), name: z.string().min(2), legalName: z.string().optional().nullable(), npi: z.string().optional().nullable(), taxId: z.string().optional().nullable(), dba: z.string().optional().nullable(), taxonomyCode: z.string().optional().nullable(), establishedAt: z.coerce.date().optional().nullable(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().optional().nullable(), mailingAddress: z.any().optional(), primaryAddress: z.any().optional(), bankName: z.string().optional().nullable(), bankAccountTitle: z.string().optional().nullable(), bankAccountNumber: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankContactName: z.string().optional().nullable(), bankContactPhone: z.string().optional().nullable(), bankContactEmail: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  facilities: z.object({ practiceId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), name: z.string().min(2), npi: z.string().optional().nullable(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().optional().nullable(), address: z.any().optional(), schedule: z.any().optional(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  providers: z.object({ firstName: z.string().min(1), middleName: z.string().optional().nullable(), lastName: z.string().min(1), npi: z.string().optional().nullable(), dateOfBirth: z.coerce.date().optional().nullable(), placeOfBirth: z.string().optional().nullable(), ssn: z.string().optional().nullable(), citizenship: z.string().optional().nullable(), gender: z.string().optional().nullable(), email: z.string().email().optional().or(z.literal('')).nullable(), homePhone: z.string().optional().nullable(), workPhone: z.string().optional().nullable(), address: z.any().optional(), primarySpecialty: z.string().optional().nullable(), secondarySpecialty: z.string().optional().nullable(), taxonomyCode: z.string().optional().nullable(), professionalType: z.string().optional().nullable(), supervisorName: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  providerOrganizations: z.object({ providerId: z.string().min(1), organizationId: z.string().min(1), affiliationTitle: z.string().optional().nullable(), effectiveAt: z.coerce.date().optional().nullable(), endAt: z.coerce.date().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  licenses: z.object({ providerId: z.string().min(1), type: z.string().min(1), number: z.string().optional().nullable(), state: z.string().optional().nullable(), issuedAt: z.coerce.date().optional().nullable(), expiresAt: z.coerce.date().optional().nullable(), status: z.enum(['MISSING','RECEIVED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED']).optional(), issuingBody: z.string().optional().nullable(), notes: z.string().optional().nullable() }),
  documents: z.object({ title: z.string().min(1), type: z.string().min(1), category: z.string().optional().nullable(), status: z.enum(['MISSING','RECEIVED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED']).optional(), storageKey: z.string().optional().nullable(), originalName: z.string().optional().nullable(), mimeType: z.string().optional().nullable(), sizeBytes: z.number().int().nonnegative().optional().nullable(), issuedAt: z.coerce.date().optional().nullable(), expiresAt: z.coerce.date().optional().nullable(), verifiedAt: z.coerce.date().optional().nullable(), verifiedBy: z.string().optional().nullable(), notes: z.string().optional().nullable(), ignored: z.boolean().optional(), required: z.boolean().optional(), reportingRequired: z.boolean().optional(), warningDays: z.coerce.number().int().positive().optional().nullable(), policyNumber: z.string().optional().nullable(), perOccurrence: z.coerce.number().nonnegative().optional().nullable(), aggregate: z.coerce.number().nonnegative().optional().nullable(), insuranceCompany: z.string().optional().nullable(), namedInsured: z.string().optional().nullable(), bankName: z.string().optional().nullable(), bankTitle: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankAccountType: z.enum(['Checking','Savings','Other']).optional().nullable(), bankPhoneNumber: z.string().optional().nullable(), bankAccountHolder: z.string().optional().nullable(), providerId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), facilityId: z.string().optional().nullable() }),
  cases: z.object({ caseNumber: z.string().min(1), providerId: z.string().min(1), practiceId: z.string().optional().nullable(), status: z.enum(['DRAFT','INFORMATION_NEEDED','UNDER_REVIEW','VERIFICATION_PENDING','READY_FOR_APPROVAL','APPROVED','REJECTED','ON_HOLD']).optional(), assignedTo: z.string().optional().nullable(), dueAt: z.coerce.date().optional().nullable(), submittedAt: z.coerce.date().optional().nullable(), decisionAt: z.coerce.date().optional().nullable(), decisionBy: z.string().optional().nullable(), decisionReason: z.string().optional().nullable(), checklist: z.any().optional(), notes: z.string().optional().nullable() }),
  payers: z.object({ name: z.string().min(2), payerCode: z.string().optional().nullable(), website: z.string().optional().nullable(), phone: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  plans: z.object({ payerId: z.string().min(1), name: z.string().min(1), planType: z.string().optional().nullable(), checklist: z.any().optional() }),
  enrollments: z.object({ applicationNo: z.string().optional().nullable(), subject: z.string().optional().nullable(), providerId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), facilityId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), payerPlanId: z.string().min(1), status: z.enum(['NOT_STARTED','PREPARING','READY_TO_SUBMIT','SUBMITTED','PAYER_REVIEW','ADDITIONAL_INFORMATION_NEEDED','APPROVED','DENIED','WITHDRAWN']).optional(), assignedTo: z.string().optional().nullable(), dueAt: z.coerce.date().optional().nullable(), submittedAt: z.coerce.date().optional().nullable(), referenceNo: z.string().optional().nullable(), lastFollowUpAt: z.coerce.date().optional().nullable(), nextFollowUpAt: z.coerce.date().optional().nullable(), effectiveAt: z.coerce.date().optional().nullable(), decisionAt: z.coerce.date().optional().nullable(), decisionReason: z.string().optional().nullable(), checklist: z.any().optional(), notes: z.string().optional().nullable(), highlighted: z.boolean().optional() }),
  tasks: z.object({ title: z.string().min(2), description: z.string().optional().nullable(), status: z.enum(['OPEN','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED']).optional(), priority: z.enum(['LOW','NORMAL','HIGH','URGENT']).optional(), dueAt: z.coerce.date().optional().nullable(), assignedToId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), facilityId: z.string().optional().nullable(), providerId: z.string().optional().nullable(), caseId: z.string().optional().nullable(), enrollmentId: z.string().optional().nullable() })
};
const delegates: Record<string, any> = { employees: prisma.user, organizations: prisma.organization, practices: prisma.practice, facilities: prisma.facility, providers: prisma.provider, providerOrganizations: prisma.providerOrganization, licenses: prisma.license, documents: prisma.document, cases: prisma.credentialingCase, payers: prisma.payer, plans: prisma.payerPlan, enrollments: prisma.enrollmentApplication, tasks: prisma.task };
const includes: Record<string, any> = {
  organizations: { practices: { select: { id: true, name: true, status: true } }, facilities: { select: { id: true, name: true, status: true } }, providerAffiliations: { select: { id: true, providerId: true, status: true } }, enrollments: { select: { id: true, status: true } } },
  practices: { organization: { select: { id: true, legalName: true } }, owners: true, _count: { select: { facilities: true, providers: true } } }, facilities: { practice: { select: { id: true, name: true } }, organization: { select: { id: true, legalName: true } }, contacts: true, _count: { select: { providers: true } } },
  providerOrganizations: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } }, organization: { select: { id: true, legalName: true } } },
  providers: { licenses: true, organizations: { include: { organization: true } }, practices: { include: { practice: true } }, facilities: { include: { facility: true } } },
  licenses: { provider: { select: { id: true, firstName: true, lastName: true } } },
  documents: { provider: { select: { id: true, firstName: true, lastName: true } }, organization: { select: { id: true, legalName: true } }, practice: { select: { id: true, name: true } }, facility: { select: { id: true, name: true } } },
  cases: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } }, practice: { select: { id: true, name: true } }, statusHistory: { orderBy: { createdAt: 'desc' }, take: 30 } },
  plans: { payer: { select: { id: true, name: true } } }, enrollments: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } }, organization: { select: { id: true, legalName: true } }, facility: { select: { id: true, name: true } }, practice: { select: { id: true, name: true } }, payerPlan: { include: { payer: true } }, statusHistory: { orderBy: { createdAt: 'desc' }, take: 30 } },
  tasks: { assignedTo: { select: { id: true, name: true, email: true } }, organization: { select: { id: true, legalName: true } }, practice: { select: { id: true, name: true } }, facility: { select: { id: true, name: true } }, provider: { select: { id: true, firstName: true, lastName: true } }, credentialingCase: { select: { id: true, caseNumber: true } }, enrollment: { select: { id: true, applicationNo: true } }, comments: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' }, take: 20 } }
};
const mapPath: Record<string,string> = { cases: 'credentialingCase', plans: 'payerPlan' };
function cleanData(data: any) { const out = { ...data }; for (const k of Object.keys(out)) if (out[k] === '') out[k] = null; return out; }
router.get('/:resource', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource; const model = delegates[resource];
    if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const q = String(req.query.q || '').trim(); const take = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    let where: any = {};
    if (q && resource === 'providers') where = { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] };
    if (q && resource === 'organizations') where = { OR: [{ legalName: { contains: q, mode: 'insensitive' } }, { dba: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'practices') where = { OR: [{ name: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] };
    if (q && ['payers','plans'].includes(resource)) where = { name: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'licenses') where = { OR: [{ type: { contains: q, mode: 'insensitive' } }, { number: { contains: q, mode: 'insensitive' } }, { state: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'documents') where = { OR: [{ title: { contains: q, mode: 'insensitive' } }, { type: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'cases') where = { caseNumber: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'enrollments') where = { OR: [{ applicationNo: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }, { referenceNo: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'facilities') where = { name: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'providerOrganizations') where = { OR: [{ organization: { legalName: { contains: q, mode: 'insensitive' } } }, { provider: { firstName: { contains: q, mode: 'insensitive' } } }, { provider: { lastName: { contains: q, mode: 'insensitive' } } }] };
    const organizationId = String(req.query.organizationId || '').trim();
    if (organizationId) {
      const scoped: Record<string, any> = {
        practices: { organizationId },
        facilities: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] },
        providerOrganizations: { organizationId },
        providers: {
          OR: [
            { organizations: { some: { organizationId } } },
            { practices: { some: { practice: { is: { organizationId } } } } },
            { facilities: { some: { facility: { is: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] } } } } }
          ]
        },
        licenses: {
          provider: {
            is: {
              OR: [
                { organizations: { some: { organizationId } } },
                { practices: { some: { practice: { is: { organizationId } } } } },
                { facilities: { some: { facility: { is: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] } } } } }
              ]
            }
          }
        },
        documents: {
          OR: [
            { organizationId },
            { practice: { is: { organizationId } } },
            { facility: { is: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] } } },
            { provider: { is: { organizations: { some: { organizationId } } } } }
          ]
        },
        cases: {
          OR: [
            { practice: { is: { organizationId } } },
            { provider: { is: { organizations: { some: { organizationId } } } } }
          ]
        },
        enrollments: {
          OR: [
            { organizationId },
            { practice: { is: { organizationId } } },
            { facility: { is: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] } } },
            { provider: { is: { organizations: { some: { organizationId } } } } }
          ]
        },
        plans: { enrollments: { some: { organizationId } } },
        payers: { plans: { some: { enrollments: { some: { organizationId } } } } },
        tasks: {
          OR: [
            { credentialingCase: { is: { OR: [{ practice: { is: { organizationId } } }, { provider: { is: { organizations: { some: { organizationId } } } } }] } } },
            { enrollment: { is: { OR: [{ organizationId }, { practice: { is: { organizationId } } }, { provider: { is: { organizations: { some: { organizationId } } } } }] } } }
          ]
        }
      };

      if (scoped[resource]) where = Object.keys(where).length ? { AND: [where, scoped[resource]] } : scoped[resource];
    }
    const pageParam = req.query.page;
    const wantsPagination = pageParam !== undefined && String(pageParam).length > 0;
    const page = Math.max(1, Number(pageParam) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || take));
    const orderBy = { createdAt: 'desc' as const };
    if (wantsPagination) {
      const [total, rows] = await Promise.all([
        model.count({ where }),
        model.findMany({ where, include: includes[resource], orderBy, skip: (page - 1) * pageSize, take: pageSize })
      ]);
      const data = rows.map((row: any) => {
        if (resource === 'employees') { const { passwordHash, ...safe } = row; return safe; }
        return sanitizeRow(row, (req as AuthRequest).user!.role, resource);
      });
      return res.json({ data, total, page, pageSize });
    }
    const rows = await model.findMany({ where, include: includes[resource], orderBy, take });
    res.json(rows.map((row: any) => {
      if (resource === 'employees') { const { passwordHash, ...safe } = row; return safe; }
      return sanitizeRow(row, (req as AuthRequest).user!.role, resource);
    }));
  } catch (e) { next(e); }
});
router.get('/:resource/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource; const model = delegates[resource];
    if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const row = await model.findUnique({ where: { id: req.params.id }, include: includes[resource] });
    if (!row) return res.status(404).json({ error: 'Record not found' });
    try {
      await assertResourceRecordAccess(req.user!.id, req.user!.role, resource, req.params.id);
    } catch (accessErr: any) {
      if (accessErr?.status) return res.status(accessErr.status).json({ error: accessErr.message });
      throw accessErr;
    }
    if (resource === 'employees') { const { passwordHash, ...safe } = row as any; return res.json(safe); }
    let out: any = sanitizeRow(row, req.user!.role, resource);
    if (resource === 'cases') out = { ...out, allowedTransitions: allowedCaseTransitions(row.status, req.user!.role) };
    if (resource === 'enrollments') {
      out = { ...out, daysConsumed: daysConsumed(row.submittedAt || row.createdAt) };
    }
    const completionMap: Record<string, 'organization' | 'practice' | 'facility' | 'provider'> = {
      organizations: 'organization', practices: 'practice', facilities: 'facility', providers: 'provider'
    };
    if (completionMap[resource]) out = { ...out, completion: profileCompletion(completionMap[resource], row) };
    res.json(out);
  } catch (e) { next(e); }
});
router.post('/:resource', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource; const model = delegates[resource]; const schema = schemas[resource];
    if (!model || !schema) return res.status(404).json({ error: 'Unknown resource' });
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = cleanData(schema.parse(req.body));
    if (resource === 'facilities') {
      if (!data.practiceId && !data.organizationId) return res.status(400).json({ error: 'Select an organization or practice for this facility' });
      if (data.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: data.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (data.organizationId && data.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Facility organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; }
    }
    if (resource === 'enrollments') {
      // Application numbers are always generated on the server.
      delete data.applicationNo;
      if (!data.organizationId && data.providerId && !data.practiceId && !data.facilityId) {
        const affiliations = await prisma.providerOrganization.findMany({ where: { providerId: data.providerId, status: 'ACTIVE', OR: [{ endAt: null }, { endAt: { gt: new Date() } }] }, select: { organizationId: true }, take: 2 });
        if (affiliations.length === 1) data.organizationId = affiliations[0].organizationId;
      }
      if (!data.providerId && !data.organizationId && !data.practiceId && !data.facilityId) return res.status(400).json({ error: 'Enrollment must be linked to a provider, organization, practice, or facility' });
      if (data.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: data.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (data.organizationId && data.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Enrollment organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; }
      if (data.facilityId) { const facility = await prisma.facility.findUnique({ where: { id: data.facilityId }, select: { organizationId: true, practice: { select: { organizationId: true } } } }); if (!facility) return res.status(400).json({ error: 'Selected facility was not found' }); const facilityOrg = facility.organizationId || facility.practice?.organizationId; if (data.organizationId && facilityOrg && data.organizationId !== facilityOrg) return res.status(400).json({ error: 'Enrollment organization must match the selected facility organization' }); if (!data.organizationId && facilityOrg) data.organizationId = facilityOrg; }
      data.applicationNo = await generateApplicationNo();
    }
    if (('ssn' in data || 'bankAccountNumber' in data || 'bankRoutingNumber' in data) && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers or banking details' });
    if (resource === 'tasks') data.createdById = req.user!.id;
    const row = await model.create({ data, include: includes[resource] });
    if (resource === 'cases') await prisma.statusHistory.create({ data: { caseId: row.id, toStatus: row.status, changedBy: req.user!.id, reason: 'Case created' } });
    if (resource === 'enrollments') await prisma.statusHistory.create({ data: { enrollmentId: row.id, toStatus: row.status, changedBy: req.user!.id, reason: 'Enrollment created' } });
    await audit(req, 'CREATE', resource, row.id, undefined, row);
    res.status(201).json(sanitizeRow(row, req.user!.role, resource));
  } catch (e) { next(e); }
});
router.patch('/:resource/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource; const model = delegates[resource]; const schema = schemas[resource];
    if (!model || !schema) return res.status(404).json({ error: 'Unknown resource' });
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const data = cleanData((schema as z.AnyZodObject).partial().parse(req.body));
    if (resource === 'enrollments') delete data.applicationNo;
    if (resource === 'facilities' || resource === 'enrollments') {
      const existing = await model.findUnique({ where: { id: req.params.id } }); if (!existing) return res.status(404).json({ error: 'Record not found' }); const merged = { ...existing, ...data };
      if (resource === 'facilities') { if (!merged.practiceId && !merged.organizationId) return res.status(400).json({ error: 'Select an organization or practice for this facility' }); if (merged.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: merged.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (merged.organizationId && merged.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Facility organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; } }
      if (resource === 'enrollments') { if (!merged.providerId && !merged.organizationId && !merged.practiceId && !merged.facilityId) return res.status(400).json({ error: 'Enrollment must be linked to a provider, organization, practice, or facility' }); if (merged.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: merged.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (merged.organizationId && merged.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Enrollment organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; } if (merged.facilityId) { const facility = await prisma.facility.findUnique({ where: { id: merged.facilityId }, select: { organizationId: true, practice: { select: { organizationId: true } } } }); if (!facility) return res.status(400).json({ error: 'Selected facility was not found' }); const facilityOrg = facility.organizationId || facility.practice?.organizationId; if (merged.organizationId && facilityOrg && merged.organizationId !== facilityOrg) return res.status(400).json({ error: 'Enrollment organization must match the selected facility organization' }); if (!merged.organizationId && facilityOrg && !data.organizationId) data.organizationId = facilityOrg; } }
    }
    if (('ssn' in data || 'bankAccountNumber' in data || 'bankRoutingNumber' in data) && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers or banking details' });
    const before = await model.findUnique({ where: { id: req.params.id } }); if (!before) return res.status(404).json({ error: 'Record not found' });
    try {
      await assertResourceRecordAccess(req.user!.id, req.user!.role, resource, req.params.id);
      if (resource === 'cases' && data.status && data.status !== before.status) assertCaseTransition(before.status, data.status, req.user!.role);
      if (resource === 'enrollments' && data.status && data.status !== before.status) assertEnrollmentTransition(before.status, data.status, req.user!.role);
    } catch (accessErr: any) {
      if (accessErr?.status) return res.status(accessErr.status).json({ error: accessErr.message });
      throw accessErr;
    }
    const row = await model.update({ where: { id: req.params.id }, data, include: includes[resource] });
    if (resource === 'cases' && data.status && data.status !== before.status) await prisma.statusHistory.create({ data: { caseId: row.id, fromStatus: before.status, toStatus: data.status, changedBy: req.user!.id, reason: data.decisionReason || 'Status updated' } });
    if (resource === 'enrollments' && data.status && data.status !== before.status) await prisma.statusHistory.create({ data: { enrollmentId: row.id, fromStatus: before.status, toStatus: data.status, changedBy: req.user!.id, reason: data.decisionReason || 'Status updated' } });
    if (resource === 'tasks' && data.assignedToId && data.assignedToId !== before.assignedToId) {
      await notifyUser({
        userId: data.assignedToId,
        title: 'Task assigned',
        body: row.title,
        type: 'task',
        entityType: 'tasks',
        entityId: row.id,
        href: '/tasks'
      });
    }
    await audit(req, 'UPDATE', resource, row.id, before, row);
    res.json(sanitizeRow(row, req.user!.role, resource));
  } catch (e) { next(e); }
});
router.delete('/:resource/:id', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const resource = req.params.resource; const model = delegates[resource];
    if (!model || !schemas[resource]) return res.status(404).json({ error: 'Unknown resource' });
    const before = await model.findUnique({ where: { id: req.params.id } }); if (!before) return res.status(404).json({ error: 'Record not found' });
    await model.delete({ where: { id: req.params.id } }); await audit(req, 'DELETE', resource, req.params.id, before, undefined); res.status(204).end();
  } catch (e) { next(e); }
});
export default router;
