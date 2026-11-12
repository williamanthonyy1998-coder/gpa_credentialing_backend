import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { Role } from '@prisma/client';
import { assertCaseTransition, assertEnrollmentTransition, allowedCaseTransitions, daysConsumed } from '../services/workflow';
import {
  assertResourceRecordAccess,
  getOrgRestrictionIds,
  orgListWhereForResource
} from '../services/orgAccess';
import { profileCompletion } from '../services/profileCompletion';
import { notifyUser } from '../services/notifications';
import { generateApplicationNo } from '../services/enrollments';
import {
  andWhere,
  assertRelatedRecordsSameTenant,
  ensureTenantProvider,
  listWhereForResource,
  requireTenantContext
} from '../services/tenantAccess';
import {
  assertCredentialCategoryCodeAssignable,
  assertPayerPlanAssignable,
  normalizeAddressStateField,
  normalizeLicenseFields,
  normalizeProviderSpecialtyFields,
  syncProviderSpecialtyJoin
} from '../services/directoryIntegration';
import { validateNpi } from '../services/npiValidation';
import { canWriteTenantRecords } from '../services/clients';

const router = Router();
const PLATFORM_RESOURCES = new Set(['payers', 'plans', 'employees']);
const TENANT_RESOURCES = new Set([
  'organizations', 'practices', 'facilities', 'providers', 'providerOrganizations',
  'licenses', 'documents', 'cases', 'enrollments', 'tasks'
]);

function requireTenantForResource(req: AuthRequest, resource: string) {
  if (PLATFORM_RESOURCES.has(resource)) return null;
  if (!TENANT_RESOURCES.has(resource)) return null;
  requireTenantContext(req.tenantContext);
  return req.tenantContext!.tenantId as string;
}

/** GPA staff write roles + client users with writable tenant roles. */
function assertCanModify(req: AuthRequest) {
  const role = req.user!.role;
  if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role)) {
    const err: any = new Error('Your role cannot modify records');
    err.status = 403;
    throw err;
  }
  if (role === Role.CLIENT_USER) {
    requireTenantContext(req.tenantContext);
    if (!canWriteTenantRecords(req.tenantContext!.tenantRole)) {
      const err: any = new Error('Your role cannot modify records');
      err.status = 403;
      throw err;
    }
  }
}
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
  if (resource === 'documents' && (role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER)) {
    delete copy.notes;
  }
  if (resource === 'licenses' && (role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER || role === Role.READ_ONLY || role === Role.AUDITOR)) {
    if (copy.number) {
      const s = String(copy.number);
      copy.number = s.length <= 4 ? '****' : `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
      copy.numberMasked = true;
    }
    delete copy.reviewerNotes;
    delete copy.verifiedById;
  }
  return copy;
}
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    requireTenantContext(req.tenantContext);
    const organizationId = String(req.query.organizationId || '').trim();
    if (organizationId) {
      await assertRelatedRecordsSameTenant(req.tenantContext!.tenantId!, { organizationId });
    }
    const rows = await prisma.auditEvent.findMany({
      where: {
        tenantId: req.tenantContext!.tenantId!,
        ...(organizationId ? { organizationId } : {})
      },
      select: {
        id: true, action: true, entityType: true, entityId: true, ipAddress: true, createdAt: true,
        actor: { select: { name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    res.json(rows);
  } catch (e) { next(e); }
});
const schemas: Record<string, z.ZodTypeAny> = {
  organizations: z.object({ legalName: z.string().min(2), dba: z.string().optional().nullable(), taxId: z.string().optional().nullable(), establishedAt: z.coerce.date().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().email().optional().or(z.literal('')).nullable(), mailingAddress: z.any().optional(), ownership: z.any().optional(), bankName: z.string().optional().nullable(), bankAccountTitle: z.string().optional().nullable(), bankAccountNumber: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankContactName: z.string().optional().nullable(), bankContactPhone: z.string().optional().nullable(), bankContactEmail: z.string().optional().nullable() }),
  practices: z.object({ organizationId: z.string().min(1), name: z.string().min(2), legalName: z.string().optional().nullable(), npi: z.string().optional().nullable(), taxId: z.string().optional().nullable(), dba: z.string().optional().nullable(), taxonomyCode: z.string().optional().nullable(), establishedAt: z.coerce.date().optional().nullable(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().optional().nullable(), mailingAddress: z.any().optional(), primaryAddress: z.any().optional(), bankName: z.string().optional().nullable(), bankAccountTitle: z.string().optional().nullable(), bankAccountNumber: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankContactName: z.string().optional().nullable(), bankContactPhone: z.string().optional().nullable(), bankContactEmail: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  facilities: z.object({ practiceId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), name: z.string().min(2), npi: z.string().optional().nullable(), contactName: z.string().optional().nullable(), contactTitle: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().optional().nullable(), address: z.any().optional(), schedule: z.any().optional(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  providers: z.object({ firstName: z.string().min(1), middleName: z.string().optional().nullable(), lastName: z.string().min(1), npi: z.string().optional().nullable(), dateOfBirth: z.coerce.date().optional().nullable(), placeOfBirth: z.string().optional().nullable(), ssn: z.string().optional().nullable(), citizenship: z.string().optional().nullable(), gender: z.string().optional().nullable(), email: z.string().email().optional().or(z.literal('')).nullable(), homePhone: z.string().optional().nullable(), workPhone: z.string().optional().nullable(), address: z.any().optional(), primarySpecialty: z.string().optional().nullable(), secondarySpecialty: z.string().optional().nullable(), primarySpecialtyId: z.string().optional().nullable(), secondarySpecialtyId: z.string().optional().nullable(), taxonomyCode: z.string().optional().nullable(), professionalType: z.string().optional().nullable(), supervisorName: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  providerOrganizations: z.object({ providerId: z.string().min(1), organizationId: z.string().min(1), affiliationTitle: z.string().optional().nullable(), effectiveAt: z.coerce.date().optional().nullable(), endAt: z.coerce.date().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  licenses: z.object({ providerId: z.string().min(1), type: z.string().min(1).optional(), licenseTypeId: z.string().optional().nullable(), number: z.string().optional().nullable(), state: z.string().optional().nullable(), usStateId: z.string().optional().nullable(), issuedAt: z.coerce.date().optional().nullable(), expiresAt: z.coerce.date().optional().nullable(), status: z.enum(['MISSING','RECEIVED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED']).optional(), issuingBody: z.string().optional().nullable(), notes: z.string().optional().nullable() }).refine((v) => Boolean(v.type || v.licenseTypeId), { message: 'License type is required', path: ['type'] }),
  documents: z.object({ title: z.string().min(1), type: z.string().min(1), category: z.string().optional().nullable(), status: z.enum(['MISSING','RECEIVED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED']).optional(), storageKey: z.string().optional().nullable(), originalName: z.string().optional().nullable(), mimeType: z.string().optional().nullable(), sizeBytes: z.number().int().nonnegative().optional().nullable(), issuedAt: z.coerce.date().optional().nullable(), expiresAt: z.coerce.date().optional().nullable(), verifiedAt: z.coerce.date().optional().nullable(), verifiedBy: z.string().optional().nullable(), notes: z.string().optional().nullable(), ignored: z.boolean().optional(), required: z.boolean().optional(), reportingRequired: z.boolean().optional(), warningDays: z.coerce.number().int().positive().optional().nullable(), policyNumber: z.string().optional().nullable(), perOccurrence: z.coerce.number().nonnegative().optional().nullable(), aggregate: z.coerce.number().nonnegative().optional().nullable(), insuranceCompany: z.string().optional().nullable(), namedInsured: z.string().optional().nullable(), bankName: z.string().optional().nullable(), bankTitle: z.string().optional().nullable(), bankRoutingNumber: z.string().optional().nullable(), bankAccountType: z.enum(['Checking','Savings','Other']).optional().nullable(), bankPhoneNumber: z.string().optional().nullable(), bankAccountHolder: z.string().optional().nullable(), providerId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), facilityId: z.string().optional().nullable() }),
  cases: z.object({ caseNumber: z.string().min(1), providerId: z.string().min(1), practiceId: z.string().optional().nullable(), status: z.enum(['DRAFT','INFORMATION_NEEDED','UNDER_REVIEW','VERIFICATION_PENDING','READY_FOR_APPROVAL','APPROVED','REJECTED','ON_HOLD']).optional(), assignedTo: z.string().optional().nullable(), dueAt: z.coerce.date().optional().nullable(), submittedAt: z.coerce.date().optional().nullable(), decisionAt: z.coerce.date().optional().nullable(), decisionBy: z.string().optional().nullable(), decisionReason: z.string().optional().nullable(), checklist: z.any().optional(), notes: z.string().optional().nullable() }),
  payers: z.object({ name: z.string().min(2), legalName: z.string().optional().nullable(), payerCode: z.string().optional().nullable(), payerType: z.string().optional().nullable(), website: z.string().optional().nullable(), phone: z.string().optional().nullable(), fax: z.string().optional().nullable(), email: z.string().email().optional().or(z.literal('')).nullable(), address: z.any().optional(), notes: z.string().optional().nullable(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional() }),
  plans: z.object({ payerId: z.string().min(1), name: z.string().min(1), planCode: z.string().optional().nullable(), planType: z.string().optional().nullable(), stateApplicability: z.string().optional().nullable(), metadata: z.any().optional(), status: z.enum(['ACTIVE','INACTIVE','PENDING','ARCHIVED']).optional(), checklist: z.any().optional() }),
  enrollments: z.object({ applicationNo: z.string().optional().nullable(), subject: z.string().optional().nullable(), providerId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), facilityId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), payerPlanId: z.string().min(1), status: z.enum(['NOT_STARTED','PREPARING','READY_TO_SUBMIT','SUBMITTED','ACKNOWLEDGED','PAYER_REVIEW','ADDITIONAL_INFORMATION_NEEDED','APPROVED','EFFECTIVE','DENIED','WITHDRAWN','TERMINATED','CLOSED']).optional(), assignedTo: z.string().optional().nullable(), dueAt: z.coerce.date().optional().nullable(), submittedAt: z.coerce.date().optional().nullable(), referenceNo: z.string().optional().nullable(), lastFollowUpAt: z.coerce.date().optional().nullable(), nextFollowUpAt: z.coerce.date().optional().nullable(), effectiveAt: z.coerce.date().optional().nullable(), decisionAt: z.coerce.date().optional().nullable(), decisionReason: z.string().optional().nullable(), checklist: z.any().optional(), notes: z.string().optional().nullable(), highlighted: z.boolean().optional() }),
  tasks: z.object({ title: z.string().min(2), description: z.string().optional().nullable(), status: z.enum(['OPEN','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED']).optional(), priority: z.enum(['LOW','NORMAL','HIGH','URGENT']).optional(), dueAt: z.coerce.date().optional().nullable(), assignedToId: z.string().optional().nullable(), organizationId: z.string().optional().nullable(), practiceId: z.string().optional().nullable(), facilityId: z.string().optional().nullable(), providerId: z.string().optional().nullable(), caseId: z.string().optional().nullable(), enrollmentId: z.string().optional().nullable() })
};
const delegates: Record<string, any> = { employees: prisma.user, organizations: prisma.organization, practices: prisma.practice, facilities: prisma.facility, providers: prisma.provider, providerOrganizations: prisma.providerOrganization, licenses: prisma.license, documents: prisma.document, cases: prisma.credentialingCase, payers: prisma.payer, plans: prisma.payerPlan, enrollments: prisma.enrollmentApplication, tasks: prisma.task };
const includes: Record<string, any> = {
  organizations: { practices: { select: { id: true, name: true, status: true } }, facilities: { select: { id: true, name: true, status: true } }, providerAffiliations: { select: { id: true, providerId: true, status: true } }, enrollments: { select: { id: true, status: true } } },
  practices: { organization: { select: { id: true, legalName: true } }, owners: true, _count: { select: { facilities: true, providers: true } } }, facilities: { practice: { select: { id: true, name: true } }, organization: { select: { id: true, legalName: true } }, contacts: true, _count: { select: { providers: true } } },
  providerOrganizations: { provider: { select: { id: true, firstName: true, lastName: true, npi: true } }, organization: { select: { id: true, legalName: true } } },
  providers: {
    licenses: { include: { licenseType: true, usState: true } },
    organizations: { include: { organization: true } },
    practices: { include: { practice: true } },
    facilities: { include: { facility: true } },
    primarySpecialtyRef: { select: { id: true, name: true, code: true, status: true } },
    secondarySpecialtyRef: { select: { id: true, name: true, code: true, status: true } },
    specialties: { include: { specialty: { select: { id: true, name: true, code: true, status: true } } } }
  },
  licenses: {
    provider: { select: { id: true, firstName: true, lastName: true } },
    licenseType: { select: { id: true, name: true, code: true, status: true } },
    usState: { select: { id: true, name: true, abbreviation: true, status: true } }
  },
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
    if (q && resource === 'providers') where = { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }, { primarySpecialty: { contains: q, mode: 'insensitive' } }] };
    const specialtyId = String(req.query.specialtyId || '').trim();
    if (specialtyId && resource === 'providers') {
      where = Object.keys(where).length
        ? { AND: [where, { OR: [{ primarySpecialtyId: specialtyId }, { secondarySpecialtyId: specialtyId }, { specialties: { some: { specialtyId } } }] }] }
        : { OR: [{ primarySpecialtyId: specialtyId }, { secondarySpecialtyId: specialtyId }, { specialties: { some: { specialtyId } } }] };
    }
    const statusFilter = String(req.query.status || '').trim().toUpperCase();
    if (statusFilter && ['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED'].includes(statusFilter)) {
      if (['payers', 'plans', 'providers', 'organizations', 'practices', 'facilities'].includes(resource)) {
        where = Object.keys(where).length ? { AND: [where, { status: statusFilter }] } : { status: statusFilter };
      }
    }
    const payerIdFilter = String(req.query.payerId || '').trim();
    if (payerIdFilter && resource === 'plans') {
      where = Object.keys(where).length ? { AND: [where, { payerId: payerIdFilter }] } : { payerId: payerIdFilter };
    }
    if (q && resource === 'organizations') where = { OR: [{ legalName: { contains: q, mode: 'insensitive' } }, { dba: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'practices') where = { OR: [{ name: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] };
    if (q && ['payers','plans'].includes(resource)) where = { name: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'licenses') where = { OR: [{ type: { contains: q, mode: 'insensitive' } }, { number: { contains: q, mode: 'insensitive' } }, { state: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'documents') where = { OR: [{ title: { contains: q, mode: 'insensitive' } }, { type: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'cases') where = { caseNumber: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'enrollments') where = { OR: [{ applicationNo: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }, { referenceNo: { contains: q, mode: 'insensitive' } }] };
    if (q && resource === 'facilities') where = { name: { contains: q, mode: 'insensitive' } };
    if (q && resource === 'providerOrganizations') where = { OR: [{ organization: { legalName: { contains: q, mode: 'insensitive' } } }, { provider: { firstName: { contains: q, mode: 'insensitive' } } }, { provider: { lastName: { contains: q, mode: 'insensitive' } } }] };

    const tenantId = requireTenantForResource(req as AuthRequest, resource);
    if (tenantId) {
      const tenantWhere = listWhereForResource(resource, tenantId);
      where = andWhere(where, tenantWhere || undefined) as any;
      // SEC-09: org-restricted clients only see records in their organizations
      const orgRestriction = await getOrgRestrictionIds(
        (req as AuthRequest).user!.id,
        (req as AuthRequest).user!.role,
        (req as AuthRequest).tenantContext
      );
      if (orgRestriction) {
        const orgWhere = orgListWhereForResource(resource, orgRestriction);
        if (orgWhere) where = andWhere(where, orgWhere) as any;
      }
    } else if (TENANT_RESOURCES.has(resource)) {
      return res.status(403).json({ error: 'Tenant context required' });
    }

    const organizationId = String(req.query.organizationId || '').trim();
    if (organizationId) {
      if (tenantId) await assertRelatedRecordsSameTenant(tenantId, { organizationId });
      // Do not trust query org alone for ACL — still constrained by orgRestriction above

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
    requireTenantForResource(req, resource);
    try {
      await assertResourceRecordAccess(req.user!.id, req.user!.role, resource, req.params.id, req.tenantContext);
    } catch (accessErr: any) {
      if (accessErr?.status) return res.status(accessErr.status).json({ error: accessErr.message });
      throw accessErr;
    }
    const row = await model.findUnique({ where: { id: req.params.id }, include: includes[resource] });
    if (!row) return res.status(404).json({ error: 'Record not found' });
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
    try { assertCanModify(req); } catch (e: any) { if (e?.status) return res.status(e.status).json({ error: e.message }); throw e; }
    if (req.user!.role === Role.CLIENT_USER && PLATFORM_RESOURCES.has(resource)) {
      return res.status(403).json({ error: 'Client users cannot modify platform reference data' });
    }
    const tenantId = requireTenantForResource(req, resource);
    const data = cleanData(schema.parse(req.body));
    if ('tenantId' in data) delete data.tenantId;
    if (resource === 'organizations' && tenantId) data.tenantId = tenantId;
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
      if (tenantId) data.tenantId = tenantId;
    }
    if (tenantId) {
      await assertRelatedRecordsSameTenant(tenantId, {
        organizationId: data.organizationId,
        practiceId: data.practiceId,
        facilityId: data.facilityId,
        providerId: data.providerId,
        enrollmentId: data.enrollmentId,
        caseId: data.caseId
      });
    }
    if (['documents', 'cases', 'tasks'].includes(resource) && tenantId) data.tenantId = tenantId;
    if (('ssn' in data || 'bankAccountNumber' in data || 'bankRoutingNumber' in data) && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers or banking details' });
    if (resource === 'tasks') data.createdById = req.user!.id;
    if (resource === 'plans' && !data.status) data.status = 'ACTIVE';
    if (resource === 'providers') {
      if (data.npi) {
        const npiCheck = validateNpi(String(data.npi));
        if (!npiCheck.ok) return res.status(400).json({ error: npiCheck.reason || 'Invalid NPI' });
        data.npi = npiCheck.digits;
      }
      Object.assign(data, await normalizeProviderSpecialtyFields(data, { forCreate: true }));
      if (data.address) data.address = await normalizeAddressStateField(data.address);
    }
    if (resource === 'licenses') {
      Object.assign(data, await normalizeLicenseFields(data, { forCreate: true }));
      if (!data.type) return res.status(400).json({ error: 'License type is required' });
      // Phase 3B: stamp tenant ownership; never create as verified via generic resource API
      if (tenantId) data.tenantId = tenantId;
      if (data.status === 'VERIFIED' || data.verificationStatus === 'VERIFIED') {
        return res.status(400).json({
          error: 'Use POST /api/provider-licenses/:id/verify — licenses cannot be created as verified'
        });
      }
      data.verificationStatus = data.verificationStatus || 'NOT_SUBMITTED';
      if (data.status === 'VERIFIED') delete data.status;
    }
    if (resource === 'practices') {
      if (data.mailingAddress) data.mailingAddress = await normalizeAddressStateField(data.mailingAddress);
      if (data.primaryAddress) data.primaryAddress = await normalizeAddressStateField(data.primaryAddress);
    }
    if (resource === 'facilities' && data.address) data.address = await normalizeAddressStateField(data.address);
    if (resource === 'organizations' && data.mailingAddress) data.mailingAddress = await normalizeAddressStateField(data.mailingAddress);
    if (resource === 'enrollments' && data.payerPlanId) {
      await assertPayerPlanAssignable(String(data.payerPlanId), { requireActive: true });
    }
    if (resource === 'documents' && data.category) {
      await assertCredentialCategoryCodeAssignable(String(data.category), tenantId, { forCreate: true });
    }
    const row = await model.create({ data, include: includes[resource] });
    if (resource === 'providers' && tenantId) await ensureTenantProvider(tenantId, row.id);
    if (resource === 'providers') {
      await syncProviderSpecialtyJoin(row.id, row.primarySpecialtyId, row.secondarySpecialtyId);
    }
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
    try { assertCanModify(req); } catch (e: any) { if (e?.status) return res.status(e.status).json({ error: e.message }); throw e; }
    if (req.user!.role === Role.CLIENT_USER && PLATFORM_RESOURCES.has(resource)) {
      return res.status(403).json({ error: 'Client users cannot modify platform reference data' });
    }
    const tenantId = requireTenantForResource(req, resource);
    const data = cleanData((schema as z.AnyZodObject).partial().parse(req.body));
    if ('tenantId' in data) delete data.tenantId;
    if (resource === 'enrollments') delete data.applicationNo;
    if (resource === 'facilities' || resource === 'enrollments') {
      const existing = await model.findUnique({ where: { id: req.params.id } }); if (!existing) return res.status(404).json({ error: 'Record not found' }); const merged = { ...existing, ...data };
      if (resource === 'facilities') { if (!merged.practiceId && !merged.organizationId) return res.status(400).json({ error: 'Select an organization or practice for this facility' }); if (merged.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: merged.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (merged.organizationId && merged.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Facility organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; } }
      if (resource === 'enrollments') { if (!merged.providerId && !merged.organizationId && !merged.practiceId && !merged.facilityId) return res.status(400).json({ error: 'Enrollment must be linked to a provider, organization, practice, or facility' }); if (merged.practiceId) { const practice = await prisma.practice.findUnique({ where: { id: merged.practiceId }, select: { organizationId: true } }); if (!practice) return res.status(400).json({ error: 'Selected practice was not found' }); if (merged.organizationId && merged.organizationId !== practice.organizationId) return res.status(400).json({ error: 'Enrollment organization must match the selected practice organization' }); if (!data.organizationId) data.organizationId = practice.organizationId; } if (merged.facilityId) { const facility = await prisma.facility.findUnique({ where: { id: merged.facilityId }, select: { organizationId: true, practice: { select: { organizationId: true } } } }); if (!facility) return res.status(400).json({ error: 'Selected facility was not found' }); const facilityOrg = facility.organizationId || facility.practice?.organizationId; if (merged.organizationId && facilityOrg && merged.organizationId !== facilityOrg) return res.status(400).json({ error: 'Enrollment organization must match the selected facility organization' }); if (!merged.organizationId && facilityOrg && !data.organizationId) data.organizationId = facilityOrg; } }
    }
    if (('ssn' in data || 'bankAccountNumber' in data || 'bankRoutingNumber' in data) && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify sensitive identifiers or banking details' });
    const before = await model.findUnique({ where: { id: req.params.id } }); if (!before) return res.status(404).json({ error: 'Record not found' });
    try {
      await assertResourceRecordAccess(req.user!.id, req.user!.role, resource, req.params.id, req.tenantContext);
      if (tenantId) {
        await assertRelatedRecordsSameTenant(tenantId, {
          organizationId: data.organizationId ?? before.organizationId,
          practiceId: data.practiceId ?? before.practiceId,
          facilityId: data.facilityId ?? before.facilityId,
          providerId: data.providerId ?? before.providerId,
          enrollmentId: data.enrollmentId ?? before.enrollmentId,
          caseId: data.caseId ?? before.caseId
        });
      }
      if (resource === 'cases' && data.status && data.status !== before.status) assertCaseTransition(before.status, data.status, req.user!.role);
      if (resource === 'enrollments' && data.status && data.status !== before.status) assertEnrollmentTransition(before.status, data.status, req.user!.role);
    } catch (accessErr: any) {
      if (accessErr?.status) return res.status(accessErr.status).json({ error: accessErr.message });
      throw accessErr;
    }
    if (resource === 'providers') {
      if (data.npi) {
        const npiCheck = validateNpi(String(data.npi));
        if (!npiCheck.ok) return res.status(400).json({ error: npiCheck.reason || 'Invalid NPI' });
        data.npi = npiCheck.digits;
      }
      Object.assign(data, await normalizeProviderSpecialtyFields(data, { forCreate: false }));
      if (data.address) data.address = await normalizeAddressStateField(data.address);
    }
    if (resource === 'licenses') {
      Object.assign(data, await normalizeLicenseFields(data, { forCreate: false }));
      // Prevent lifecycle bypass via generic PATCH
      if ('verificationStatus' in data || data.status === 'VERIFIED') {
        return res.status(400).json({
          error: 'Use /api/provider-licenses/:id/submit|verify|reject for license lifecycle changes'
        });
      }
      delete data.verifiedAt;
      delete data.verifiedById;
      delete data.tenantId;
    }
    if (resource === 'practices') {
      if (data.mailingAddress) data.mailingAddress = await normalizeAddressStateField(data.mailingAddress);
      if (data.primaryAddress) data.primaryAddress = await normalizeAddressStateField(data.primaryAddress);
    }
    if (resource === 'facilities' && data.address) data.address = await normalizeAddressStateField(data.address);
    if (resource === 'organizations' && data.mailingAddress) data.mailingAddress = await normalizeAddressStateField(data.mailingAddress);
    if (resource === 'enrollments') {
      if (
        'status' in data
        || 'submittedAt' in data
        || 'effectiveAt' in data
        || 'decisionAt' in data
        || 'acknowledgedAt' in data
      ) {
        return res.status(400).json({
          error: 'Use /api/enrollments/:id/prepare|ready|submit|acknowledge|approve|effective|reject|terminate for lifecycle changes',
          code: 'LIFECYCLE_ENDPOINT_REQUIRED'
        });
      }
      if (data.payerPlanId && data.payerPlanId !== before.payerPlanId) {
        await assertPayerPlanAssignable(String(data.payerPlanId), { requireActive: true });
      }
    }
    if (resource === 'documents' && data.category) {
      await assertCredentialCategoryCodeAssignable(String(data.category), tenantId, { forCreate: true });
    }
    const row = await model.update({ where: { id: req.params.id }, data, include: includes[resource] });
    if (resource === 'providers' && ('primarySpecialtyId' in data || 'secondarySpecialtyId' in data || 'primarySpecialty' in data || 'secondarySpecialty' in data)) {
      await syncProviderSpecialtyJoin(row.id, row.primarySpecialtyId, row.secondarySpecialtyId);
    }
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
    requireTenantForResource(req, resource);
    const before = await model.findUnique({ where: { id: req.params.id } }); if (!before) return res.status(404).json({ error: 'Record not found' });
    try {
      await assertResourceRecordAccess(req.user!.id, req.user!.role, resource, req.params.id, req.tenantContext);
    } catch (accessErr: any) {
      if (accessErr?.status) return res.status(accessErr.status).json({ error: accessErr.message });
      throw accessErr;
    }
    await model.delete({ where: { id: req.params.id } }); await audit(req, 'DELETE', resource, req.params.id, before, undefined); res.status(204).end();
  } catch (e) { next(e); }
});
export default router;
