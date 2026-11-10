import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import {
  DOCUMENT_CATEGORIES,
  WARNING_DAY_OPTIONS,
  computeCredentialAttention,
  credentialInclude,
  encryptBankingFieldsForStorage,
  isBankingCredentialType,
  isInsuranceLiabilityType,
  supportsCredentialAssociations,
  withAttention
} from '../services/credentials';
import {
  accountTypeValidationMessage,
  isValidAbaRoutingNumber,
  isValidBankAccountType,
  isValidBankPhone,
  normalizeBankPhone,
  normalizeRoutingNumber,
  phoneValidationMessage,
  routingValidationMessage
} from '../services/bankingValidation';
import {
  assertOrganizationAccess,
  getAuthorizedOrganizationIds,
  resolveRecordOrganizationId
} from '../services/orgAccess';

const router = Router();

function canWrite(role: Role) {
  return !([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role);
}

const moneySchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Amount must be a non-negative decimal value' });
      return z.NEVER;
    }
    return new Prisma.Decimal(n.toFixed(2));
  });

const warningDaysSchema = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return 30;
    const n = typeof v === 'number' ? v : Number(v);
    if (!WARNING_DAY_OPTIONS.includes(n as any)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Warning days must be 30, 60, 90, or 120' });
      return z.NEVER;
    }
    return n;
  });

const idListSchema = z
  .union([z.array(z.string()), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return [];
    if (Array.isArray(v)) return [...new Set(v.filter(Boolean))];
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return [...new Set(parsed.filter(Boolean))];
    } catch { /* plain string */ }
    return [v];
  });

const routingSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const digits = normalizeRoutingNumber(v);
    if (!digits || !isValidAbaRoutingNumber(digits)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: routingValidationMessage() });
      return z.NEVER;
    }
    return digits;
  });

const bankPhoneSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!isValidBankPhone(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: phoneValidationMessage() });
      return z.NEVER;
    }
    return normalizeBankPhone(v);
  });

const bankAccountTypeSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!isValidBankAccountType(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: accountTypeValidationMessage() });
      return z.NEVER;
    }
    return v;
  });

const docSchema = z.object({
  title: z.string().min(1).max(300),
  type: z.string().min(1).max(200),
  category: z.string().optional().nullable(),
  status: z.enum(['MISSING', 'RECEIVED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']).optional(),
  issuedAt: z.coerce.date().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  ignored: z.boolean().optional(),
  required: z.boolean().optional(),
  reportingRequired: z.boolean().optional(),
  warningDays: warningDaysSchema,
  policyNumber: z.string().max(128).optional().nullable(),
  perOccurrence: moneySchema,
  aggregate: moneySchema,
  insuranceCompany: z.string().max(200).optional().nullable(),
  namedInsured: z.string().max(200).optional().nullable(),
  bankName: z.string().max(200).optional().nullable(),
  bankTitle: z.string().max(200).optional().nullable(),
  bankRoutingNumber: routingSchema,
  bankAccountType: bankAccountTypeSchema,
  bankPhoneNumber: bankPhoneSchema,
  bankAccountHolder: z.string().max(200).optional().nullable(),
  providerId: z.string().optional().nullable(),
  organizationId: z.string().optional().nullable(),
  practiceId: z.string().optional().nullable(),
  facilityId: z.string().optional().nullable(),
  facilityIds: idListSchema,
  providerIds: idListSchema,
  draft: z.boolean().optional()
});

function clean(data: any) {
  const out = { ...data };
  for (const k of Object.keys(out)) if (out[k] === '') out[k] = null;
  return out;
}

function stripAssociationFields(data: any) {
  const {
    facilityIds,
    providerIds,
    draft,
    ...rest
  } = data;
  return { rest, facilityIds, providerIds, draft };
}

async function assertFacilityIdsInOrg(facilityIds: string[], organizationId: string | null | undefined, userId: string, role: Role) {
  if (!facilityIds?.length) return;
  const facilities = await prisma.facility.findMany({
    where: { id: { in: facilityIds } },
    select: { id: true, organizationId: true, practice: { select: { organizationId: true } } }
  });
  if (facilities.length !== facilityIds.length) {
    const err: any = new Error('One or more facilities were not found');
    err.status = 400;
    throw err;
  }
  for (const f of facilities) {
    const orgId = f.organizationId || f.practice?.organizationId || null;
    if (organizationId && orgId && orgId !== organizationId) {
      const err: any = new Error('Cannot attach a facility from another organization');
      err.status = 403;
      throw err;
    }
    await assertOrganizationAccess(userId, role, orgId);
  }
}

async function assertProviderIdsInOrg(providerIds: string[], organizationId: string | null | undefined, userId: string, role: Role) {
  if (!providerIds?.length) return;
  const providers = await prisma.provider.findMany({
    where: { id: { in: providerIds } },
    select: {
      id: true,
      organizations: { select: { organizationId: true } },
      facilities: { select: { facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } } } },
      practices: { select: { practice: { select: { organizationId: true } } } }
    }
  });
  if (providers.length !== providerIds.length) {
    const err: any = new Error('One or more providers were not found');
    err.status = 400;
    throw err;
  }
  const allowedOrgs = await getAuthorizedOrganizationIds(userId, role);
  for (const p of providers) {
    const orgIds = new Set<string>();
    p.organizations.forEach(o => orgIds.add(o.organizationId));
    p.practices.forEach(pp => { if (pp.practice?.organizationId) orgIds.add(pp.practice.organizationId); });
    p.facilities.forEach(pf => {
      const oid = pf.facility?.organizationId || pf.facility?.practice?.organizationId;
      if (oid) orgIds.add(oid);
    });
    if (organizationId && orgIds.size && !orgIds.has(organizationId)) {
      const err: any = new Error('Cannot attach a provider from another organization');
      err.status = 403;
      throw err;
    }
    if (allowedOrgs) {
      const overlap = [...orgIds].some(id => allowedOrgs.includes(id));
      // Providers with no org links are only usable by global/admin users
      if (orgIds.size && !overlap) {
        const err: any = new Error('You are not authorized to attach this provider');
        err.status = 403;
        throw err;
      }
      if (!orgIds.size) {
        const err: any = new Error('You are not authorized to attach this provider');
        err.status = 403;
        throw err;
      }
    }
  }
}

async function syncAssociations(
  tx: Prisma.TransactionClient,
  documentId: string,
  facilityIds: string[] | undefined,
  providerIds: string[] | undefined,
  primaryFacilityId?: string | null,
  primaryProviderId?: string | null
) {
  const facilities = facilityIds !== undefined
    ? [...new Set([...(facilityIds || []), primaryFacilityId].filter(Boolean) as string[])]
    : undefined;
  const providers = providerIds !== undefined
    ? [...new Set([...(providerIds || []), primaryProviderId].filter(Boolean) as string[])]
    : undefined;

  let facilitiesChanged = false;
  let providersChanged = false;

  if (facilities !== undefined) {
    const existing = await tx.documentFacility.findMany({ where: { documentId } });
    const existingIds = new Set(existing.map(e => e.facilityId));
    const nextIds = new Set(facilities);
    const toRemove = [...existingIds].filter(id => !nextIds.has(id));
    const toAdd = [...nextIds].filter(id => !existingIds.has(id));
    if (toRemove.length) {
      await tx.documentFacility.deleteMany({ where: { documentId, facilityId: { in: toRemove } } });
      facilitiesChanged = true;
    }
    if (toAdd.length) {
      await tx.documentFacility.createMany({
        data: toAdd.map(facilityId => ({ documentId, facilityId })),
        skipDuplicates: true
      });
      facilitiesChanged = true;
    }
  }

  if (providers !== undefined) {
    const existing = await tx.documentProvider.findMany({ where: { documentId } });
    const existingIds = new Set(existing.map(e => e.providerId));
    const nextIds = new Set(providers);
    const toRemove = [...existingIds].filter(id => !nextIds.has(id));
    const toAdd = [...nextIds].filter(id => !existingIds.has(id));
    if (toRemove.length) {
      await tx.documentProvider.deleteMany({ where: { documentId, providerId: { in: toRemove } } });
      providersChanged = true;
    }
    if (toAdd.length) {
      await tx.documentProvider.createMany({
        data: toAdd.map(providerId => ({ documentId, providerId })),
        skipDuplicates: true
      });
      providersChanged = true;
    }
  }

  return { facilitiesChanged, providersChanged };
}

function sanitizeTypeSpecificFields(type: string | null | undefined, category: string | null | undefined, data: any) {
  const insurance = isInsuranceLiabilityType(type) || category === 'insurance';
  const banking = isBankingCredentialType(type) || category === 'banking';

  if (!insurance) {
    delete data.policyNumber;
    delete data.perOccurrence;
    delete data.aggregate;
    delete data.insuranceCompany;
    delete data.namedInsured;
  }
  if (!banking) {
    delete data.bankName;
    delete data.bankTitle;
    delete data.bankRoutingNumber;
    delete data.bankAccountType;
    delete data.bankPhoneNumber;
    delete data.bankAccountHolder;
  }
  if (!supportsCredentialAssociations(type, category)) {
    delete data.facilityIds;
    delete data.providerIds;
  }
  return data;
}

function assertBankingWriteAccess(role: Role, data: any) {
  const touchesSensitive =
    'bankRoutingNumber' in data ||
    'bankAccountType' in data ||
    'bankPhoneNumber' in data ||
    'bankTitle' in data ||
    'bankName' in data ||
    'bankAccountHolder' in data;
  if (!touchesSensitive) return;
  if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.CREDENTIALING_SPECIALIST, Role.ENROLLMENT_SPECIALIST] as Role[]).includes(role)) {
    const err: any = new Error('Your role cannot modify banking credential details');
    err.status = 403;
    throw err;
  }
}

function prepareBankingPersistence(type: string | null | undefined, category: string | null | undefined, data: any) {
  if (!(isBankingCredentialType(type) || category === 'banking')) return data;
  return encryptBankingFieldsForStorage(data);
}

function assertVoidedCheckRequired(type: string | null | undefined, data: any, draft?: boolean, existing?: any) {
  if (type !== 'Voided Check' || draft) return;
  const merged = { ...existing, ...data };
  if (!merged.bankRoutingNumber) {
    const err: any = new Error(routingValidationMessage());
    err.status = 400;
    throw err;
  }
  if (!merged.bankTitle) {
    const err: any = new Error('Bank Title is required for Voided Check');
    err.status = 400;
    throw err;
  }
  if (!merged.bankAccountType || !isValidBankAccountType(merged.bankAccountType)) {
    const err: any = new Error(accountTypeValidationMessage());
    err.status = 400;
    throw err;
  }
  if (!merged.bankName) {
    const err: any = new Error('Bank Name is required for Voided Check');
    err.status = 400;
    throw err;
  }
  if (!merged.bankPhoneNumber || !isValidBankPhone(merged.bankPhoneNumber)) {
    const err: any = new Error(phoneValidationMessage());
    err.status = 400;
    throw err;
  }
}

router.get('/categories', (_req, res) => {
  res.json(DOCUMENT_CATEGORIES);
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const category = String(req.query.category || '').trim();
    const organizationId = String(req.query.organizationId || '').trim();
    const practiceId = String(req.query.practiceId || '').trim();
    const facilityId = String(req.query.facilityId || '').trim();
    const providerId = String(req.query.providerId || '').trim();
    const q = String(req.query.q || '').trim();

    const allowedOrgs = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role);
    const where: any = {};
    if (category) where.category = category;
    if (organizationId) {
      await assertOrganizationAccess(req.user!.id, req.user!.role, organizationId);
      where.organizationId = organizationId;
    } else if (allowedOrgs) {
      where.OR = [
        { organizationId: { in: allowedOrgs } },
        { facility: { organizationId: { in: allowedOrgs } } },
        { practice: { organizationId: { in: allowedOrgs } } },
        { organizationId: null, facilityId: null, practiceId: null }
      ];
    }
    if (practiceId) where.practiceId = practiceId;
    if (facilityId) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { facilityId },
            { documentFacilities: { some: { facilityId } } }
          ]
        }
      ];
    }
    if (providerId) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { providerId },
            { documentProviders: { some: { providerId } } }
          ]
        }
      ];
    }
    if (q) {
      where.AND = [
        ...(where.AND || []),
        { OR: [{ title: { contains: q, mode: 'insensitive' } }, { type: { contains: q, mode: 'insensitive' } }, { policyNumber: { contains: q, mode: 'insensitive' } }] }
      ];
    }

    const rows = await prisma.document.findMany({
      where,
      include: credentialInclude,
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    });
    // List views always mask routing numbers
    res.json(rows.map(r => withAttention(r, new Date(), req.user!.role, { maskAlways: true })));
  } catch (e) { next(e); }
});

router.get('/attention', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = String(req.query.organizationId || '').trim();
    const practiceId = String(req.query.practiceId || '').trim();
    const facilityId = String(req.query.facilityId || '').trim();
    const where: any = { ignored: false };
    if (facilityId) {
      where.OR = [
        { facilityId },
        { documentFacilities: { some: { facilityId } } }
      ];
    } else if (practiceId) where.practiceId = practiceId;
    else if (organizationId) {
      await assertOrganizationAccess(req.user!.id, req.user!.role, organizationId);
      where.organizationId = organizationId;
    }
    const rows = await prisma.document.findMany({
      where,
      include: credentialInclude,
      take: 200,
      orderBy: { expiresAt: 'asc' }
    });
    const annotated = rows.map(r => withAttention(r, new Date(), req.user!.role, { maskAlways: true }));
    const expiringSoon = annotated.filter(r => r.attention === 'EXPIRING_SOON');
    const expired = annotated.filter(r => r.attention === 'EXPIRED');
    const missingRequired = annotated.filter(r => r.required && r.attention === 'MISSING');
    res.json({
      expiringSoon,
      expired,
      missingRequired,
      counts: {
        expiringSoon: expiringSoon.length,
        expired: expired.length,
        missingRequired: missingRequired.length
      }
    });
  } catch (e) { next(e); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: credentialInclude
    });
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    const orgId = await resolveRecordOrganizationId('documents', row.id);
    await assertOrganizationAccess(req.user!.id, req.user!.role, orgId);
    await audit(req, 'VIEW', 'documents', row.id, undefined, {
      id: row.id, title: row.title, type: row.type, category: row.category
    });
    res.json(withAttention(row, new Date(), req.user!.role));
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const parsed = clean(docSchema.parse(req.body));
    sanitizeTypeSpecificFields(parsed.type, parsed.category, parsed);
    assertBankingWriteAccess(req.user!.role, parsed);
    const { rest, facilityIds, providerIds, draft } = stripAssociationFields(parsed);
    if (!rest.category) rest.category = 'organization';
    if (rest.warningDays == null) rest.warningDays = 30;
    assertVoidedCheckRequired(rest.type, rest, draft);

    if (rest.organizationId) await assertOrganizationAccess(req.user!.id, req.user!.role, rest.organizationId);
    if (rest.facilityId) {
      const fOrg = await resolveRecordOrganizationId('facilities', rest.facilityId);
      await assertOrganizationAccess(req.user!.id, req.user!.role, fOrg);
      if (!rest.organizationId && fOrg) rest.organizationId = fOrg;
    }

    await assertFacilityIdsInOrg(facilityIds || [], rest.organizationId, req.user!.id, req.user!.role);
    await assertProviderIdsInOrg(providerIds || [], rest.organizationId, req.user!.id, req.user!.role);

    const attention = computeCredentialAttention({ ...rest, storageKey: null });
    if (attention === 'MISSING' && !rest.status) rest.status = 'MISSING';
    if (attention === 'EXPIRED') rest.status = 'EXPIRED';

    const persisted = prepareBankingPersistence(rest.type, rest.category, rest);

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: { ...persisted, createdById: req.user!.id },
        include: credentialInclude
      });
      await syncAssociations(tx, created.id, facilityIds, providerIds, rest.facilityId, rest.providerId);
      return tx.document.findUniqueOrThrow({ where: { id: created.id }, include: credentialInclude });
    });

    await audit(req, 'CREATE', 'documents', row.id, undefined, {
      id: row.id, title: row.title, type: row.type, category: row.category, facilityId: row.facilityId, organizationId: row.organizationId,
      bankName: row.bankName || undefined,
      bankAccountType: row.bankAccountType || undefined,
      hasRouting: Boolean(row.bankRoutingNumber)
    });
    if ((facilityIds && facilityIds.length) || rest.facilityId) {
      await audit(req, 'FACILITY_ASSOCIATIONS_CHANGED', 'documents', row.id, undefined, { facilityIds: facilityIds || (rest.facilityId ? [rest.facilityId] : []) });
    }
    if ((providerIds && providerIds.length) || rest.providerId) {
      await audit(req, 'PROVIDER_ASSOCIATIONS_CHANGED', 'documents', row.id, undefined, { providerIds: providerIds || (rest.providerId ? [rest.providerId] : []) });
    }
    res.status(201).json(withAttention(row, new Date(), req.user!.role));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWrite(req.user!.role)) return res.status(403).json({ error: 'Your role cannot modify records' });
    const parsed = clean(docSchema.partial().parse(req.body));
    const before = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: { documentFacilities: true, documentProviders: true }
    });
    if (!before) return res.status(404).json({ error: 'Document not found' });

    const orgId = await resolveRecordOrganizationId('documents', before.id);
    await assertOrganizationAccess(req.user!.id, req.user!.role, orgId);

    const typeForSanitize = parsed.type ?? before.type;
    const categoryForSanitize = parsed.category ?? before.category;
    sanitizeTypeSpecificFields(typeForSanitize, categoryForSanitize, parsed);
    assertBankingWriteAccess(req.user!.role, parsed);
    const { rest, facilityIds, providerIds, draft } = stripAssociationFields(parsed);

    if (rest.organizationId) await assertOrganizationAccess(req.user!.id, req.user!.role, rest.organizationId);
    const effectiveOrg = rest.organizationId ?? before.organizationId ?? orgId;
    await assertFacilityIdsInOrg(facilityIds || [], effectiveOrg, req.user!.id, req.user!.role);
    await assertProviderIdsInOrg(providerIds || [], effectiveOrg, req.user!.id, req.user!.role);

    assertVoidedCheckRequired(typeForSanitize, rest, draft, before);

    const merged = { ...before, ...rest };
    const attention = computeCredentialAttention(merged);
    if (attention === 'EXPIRED') rest.status = 'EXPIRED';

    const beforeFacilityIds = before.documentFacilities.map(f => f.facilityId).sort();
    const beforeProviderIds = before.documentProviders.map(p => p.providerId).sort();

    const persisted = prepareBankingPersistence(typeForSanitize, categoryForSanitize, rest);

    const row = await prisma.$transaction(async (tx) => {
      await tx.document.update({ where: { id: before.id }, data: persisted });
      const sync = await syncAssociations(
        tx,
        before.id,
        facilityIds,
        providerIds,
        rest.facilityId !== undefined ? rest.facilityId : before.facilityId,
        rest.providerId !== undefined ? rest.providerId : before.providerId
      );
      const updated = await tx.document.findUniqueOrThrow({ where: { id: before.id }, include: credentialInclude });
      return { updated, sync };
    });

    await audit(req, 'UPDATE', 'documents', row.updated.id, {
      id: before.id, title: before.title, type: before.type, ignored: before.ignored, warningDays: before.warningDays,
      hasRouting: Boolean(before.bankRoutingNumber)
    }, {
      id: row.updated.id, title: row.updated.title, type: row.updated.type, ignored: row.updated.ignored, warningDays: row.updated.warningDays,
      bankName: row.updated.bankName || undefined,
      bankAccountType: row.updated.bankAccountType || undefined,
      hasRouting: Boolean(row.updated.bankRoutingNumber)
    });

    if (row.sync.facilitiesChanged) {
      await audit(req, 'FACILITY_ASSOCIATIONS_CHANGED', 'documents', row.updated.id,
        { facilityIds: beforeFacilityIds },
        { facilityIds: row.updated.documentFacilities.map(f => f.facilityId) }
      );
    }
    if (row.sync.providersChanged) {
      await audit(req, 'PROVIDER_ASSOCIATIONS_CHANGED', 'documents', row.updated.id,
        { providerIds: beforeProviderIds },
        { providerIds: row.updated.documentProviders.map(p => p.providerId) }
      );
    }

    res.json(withAttention(row.updated, new Date(), req.user!.role));
  } catch (e) { next(e); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const before = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Document not found' });
    const orgId = await resolveRecordOrganizationId('documents', before.id);
    await assertOrganizationAccess(req.user!.id, req.user!.role, orgId);
    await prisma.document.delete({ where: { id: before.id } });
    await audit(req, 'DELETE', 'documents', before.id, {
      id: before.id, title: before.title, type: before.type, organizationId: before.organizationId
    }, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
