import {
  DirectoryScope,
  Prisma,
  RecordStatus,
  Role
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import {
  assertRelatedRecordsSameTenant,
  denyAccess,
  denyNotFound,
  requireTenantContext,
  type TenantAuthContext
} from './tenantAccess';

export const DIRECTORY_RESOURCE_NAMES = [
  'usStates',
  'specialties',
  'licenseTypes',
  'degreeTypes',
  'educationTypes',
  'residencyTypes',
  'fellowshipTypes',
  'boardCertificationCategories',
  'certificationTypes',
  'credentialCategories',
  'payerContacts',
  'billingEntities',
  'payerRequirements'
] as const;

export type DirectoryResource = (typeof DIRECTORY_RESOURCE_NAMES)[number];

type ResourceScope = 'platform' | 'tenant' | 'hybrid';

type ResourceConfig = {
  scope: ResourceScope;
  delegate: keyof typeof prisma;
  entityType: string;
  searchFields: string[];
  uniqueFields?: string[];
  sortDefault?: Prisma.Enumerable<Record<string, 'asc' | 'desc'>>;
};

const recordStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED']);

const codeNameSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  description: z.string().optional().nullable(),
  status: recordStatusSchema.optional()
});

export const directorySchemas: Record<DirectoryResource, z.ZodTypeAny> = {
  usStates: z.object({
    name: z.string().min(1).max(128),
    abbreviation: z.string().min(2).max(2).transform((v) => v.toUpperCase()),
    fipsCode: z.string().optional().nullable(),
    status: recordStatusSchema.optional()
  }),
  specialties: z.object({
    name: z.string().min(1).max(256),
    code: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    status: recordStatusSchema.optional()
  }),
  licenseTypes: codeNameSchema.extend({
    profession: z.string().optional().nullable(),
    applicableStateCodes: z.any().optional()
  }),
  degreeTypes: codeNameSchema,
  educationTypes: codeNameSchema,
  residencyTypes: codeNameSchema,
  fellowshipTypes: codeNameSchema,
  boardCertificationCategories: codeNameSchema,
  certificationTypes: codeNameSchema,
  credentialCategories: z.object({
    scope: z.enum(['PLATFORM', 'TENANT']).optional(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    description: z.string().optional().nullable(),
    requiredDefault: z.boolean().optional(),
    tracksExpiration: z.boolean().optional(),
    defaultWarningDays: z.coerce.number().int().positive().optional().nullable(),
    applicableProviderTypes: z.any().optional(),
    applicableSpecialties: z.any().optional(),
    documentTypes: z.any().optional(),
    sortOrder: z.coerce.number().int().optional(),
    status: recordStatusSchema.optional()
  }),
  payerContacts: z.object({
    payerId: z.string().min(1),
    payerPlanId: z.string().optional().nullable(),
    name: z.string().min(1).max(256),
    department: z.string().optional().nullable(),
    jobTitle: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    fax: z.string().optional().nullable(),
    email: z.string().email().optional().or(z.literal('')).nullable(),
    address: z.any().optional(),
    contactType: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    status: recordStatusSchema.optional()
  }),
  billingEntities: z.object({
    organizationId: z.string().optional().nullable(),
    legalName: z.string().min(2).max(256),
    dba: z.string().optional().nullable(),
    taxId: z.string().optional().nullable(),
    npi: z.string().optional().nullable(),
    entityType: z.string().optional().nullable(),
    billingAddress: z.any().optional(),
    mailingAddress: z.any().optional(),
    contactName: z.string().optional().nullable(),
    contactTitle: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    fax: z.string().optional().nullable(),
    email: z.string().email().optional().or(z.literal('')).nullable(),
    status: recordStatusSchema.optional()
  }),
  payerRequirements: z.object({
    scope: z.enum(['PLATFORM', 'TENANT']).optional(),
    payerId: z.string().optional().nullable(),
    payerPlanId: z.string().optional().nullable(),
    code: z.string().optional().nullable(),
    title: z.string().min(1).max(512),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    requirementKind: z.string().optional().nullable(),
    isRequired: z.boolean().optional(),
    enrollmentTypes: z.any().optional(),
    appliesToProviderTypes: z.any().optional(),
    appliesToSpecialties: z.any().optional(),
    appliesToStates: z.any().optional(),
    appliesToFacility: z.boolean().optional(),
    appliesToGroup: z.boolean().optional(),
    documentCategoryCode: z.string().optional().nullable(),
    tracksExpiration: z.boolean().optional(),
    conditions: z.any().optional().nullable(),
    effectiveFrom: z.coerce.date().optional().nullable(),
    effectiveTo: z.coerce.date().optional().nullable(),
    source: z.string().optional().nullable(),
    sourceReference: z.string().optional().nullable(),
    sourceVerifiedAt: z.coerce.date().optional().nullable(),
    instructions: z.string().optional().nullable(),
    sortOrder: z.coerce.number().int().optional(),
    status: recordStatusSchema.optional(),
    metadata: z.any().optional()
  })
};

const RESOURCE_CONFIG: Record<DirectoryResource, ResourceConfig> = {
  usStates: {
    scope: 'platform',
    delegate: 'usState',
    entityType: 'usStates',
    searchFields: ['name', 'abbreviation']
  },
  specialties: {
    scope: 'platform',
    delegate: 'specialty',
    entityType: 'specialties',
    searchFields: ['name', 'code'],
    uniqueFields: ['name']
  },
  licenseTypes: {
    scope: 'platform',
    delegate: 'licenseType',
    entityType: 'licenseTypes',
    searchFields: ['code', 'name', 'profession'],
    uniqueFields: ['code']
  },
  degreeTypes: { scope: 'platform', delegate: 'degreeType', entityType: 'degreeTypes', searchFields: ['code', 'name'], uniqueFields: ['code'] },
  educationTypes: { scope: 'platform', delegate: 'educationType', entityType: 'educationTypes', searchFields: ['code', 'name'], uniqueFields: ['code'] },
  residencyTypes: { scope: 'platform', delegate: 'residencyType', entityType: 'residencyTypes', searchFields: ['code', 'name'], uniqueFields: ['code'] },
  fellowshipTypes: { scope: 'platform', delegate: 'fellowshipType', entityType: 'fellowshipTypes', searchFields: ['code', 'name'], uniqueFields: ['code'] },
  boardCertificationCategories: {
    scope: 'platform',
    delegate: 'boardCertificationCategory',
    entityType: 'boardCertificationCategories',
    searchFields: ['code', 'name'],
    uniqueFields: ['code']
  },
  certificationTypes: {
    scope: 'platform',
    delegate: 'certificationType',
    entityType: 'certificationTypes',
    searchFields: ['code', 'name'],
    uniqueFields: ['code']
  },
  credentialCategories: {
    scope: 'hybrid',
    delegate: 'credentialCategory',
    entityType: 'credentialCategories',
    searchFields: ['code', 'name'],
    sortDefault: [{ sortOrder: 'asc' }, { code: 'asc' }]
  },
  payerContacts: {
    scope: 'tenant',
    delegate: 'payerContact',
    entityType: 'payerContacts',
    searchFields: ['name', 'email', 'department', 'jobTitle']
  },
  billingEntities: {
    scope: 'tenant',
    delegate: 'billingEntity',
    entityType: 'billingEntities',
    searchFields: ['legalName', 'dba', 'npi', 'taxId']
  },
  payerRequirements: {
    scope: 'hybrid',
    delegate: 'payerRequirement',
    entityType: 'payerRequirements',
    searchFields: ['title', 'code', 'description'],
    sortDefault: [{ sortOrder: 'asc' }, { title: 'asc' }]
  }
};

function delegateFor(resource: DirectoryResource) {
  return (prisma as any)[RESOURCE_CONFIG[resource].delegate];
}

export function isDirectoryResource(name: string): name is DirectoryResource {
  return (DIRECTORY_RESOURCE_NAMES as readonly string[]).includes(name);
}

/**
 * Platform catalog writes (GPA staff): User.role ADMIN or CREDENTIALING_MANAGER.
 * Does not require X-Platform-Access — operational GPA workflows use global catalogs directly.
 * Tenant-owned catalogs require an active tenant context (requireTenantContext).
 */
export function assertPlatformDirectoryWrite(ctx: TenantAuthContext | undefined | null, platformRole: Role) {
  if (!ctx) denyAccess('Authentication required', 401);
  const gpaWriter =
    platformRole === Role.ADMIN || platformRole === Role.CREDENTIALING_MANAGER;
  if (!gpaWriter) denyAccess('Insufficient permissions for platform directory changes');
}

export function assertTenantDirectoryWrite(ctx: TenantAuthContext | undefined | null) {
  requireTenantContext(ctx);
}

export function assertDirectoryReadAllowed(_ctx: TenantAuthContext | undefined | null) {
  // Any authenticated user may read ACTIVE platform directories (enforced in list filters).
}

export async function canHardDelete(resource: DirectoryResource, id: string): Promise<boolean> {
  if (resource === 'specialties') {
    const [links, primary, secondary] = await Promise.all([
      prisma.providerSpecialty.count({ where: { specialtyId: id } }),
      prisma.provider.count({ where: { primarySpecialtyId: id } }),
      prisma.provider.count({ where: { secondarySpecialtyId: id } })
    ]);
    return links === 0 && primary === 0 && secondary === 0;
  }
  if (resource === 'licenseTypes') {
    const used = await prisma.license.count({ where: { licenseTypeId: id } });
    return used === 0;
  }
  if (resource === 'usStates') {
    const used = await prisma.license.count({ where: { usStateId: id } });
    return used === 0;
  }
  if (resource === 'credentialCategories') {
    return false;
  }
  if (resource === 'payerContacts' || resource === 'billingEntities') {
    return true;
  }
  return true;
}

function buildListWhere(
  resource: DirectoryResource,
  options: {
    q?: string;
    status?: RecordStatus;
    tenantId?: string | null;
    scopeFilter?: DirectoryScope;
  }
): Record<string, unknown> {
  const cfg = RESOURCE_CONFIG[resource];
  const where: Record<string, unknown> = {};

  if (cfg.scope === 'platform') {
    if (options.status) where.status = options.status;
    else where.status = RecordStatus.ACTIVE;
  } else if (cfg.scope === 'tenant') {
    if (!options.tenantId) denyAccess('Tenant context required');
    where.tenantId = options.tenantId;
    if (options.status) where.status = options.status;
  } else if (cfg.scope === 'hybrid') {
    if (options.scopeFilter === DirectoryScope.TENANT) {
      if (!options.tenantId) denyAccess('Tenant context required');
      where.scope = DirectoryScope.TENANT;
      where.tenantId = options.tenantId;
    } else if (options.scopeFilter === DirectoryScope.PLATFORM) {
      where.scope = DirectoryScope.PLATFORM;
      where.tenantId = null;
    } else {
      const or: Record<string, unknown>[] = [
        { scope: DirectoryScope.PLATFORM, tenantId: null }
      ];
      if (options.tenantId) {
        or.push({ scope: DirectoryScope.TENANT, tenantId: options.tenantId });
      }
      where.OR = or;
    }
    if (options.status) where.status = options.status;
    else if (!options.scopeFilter || options.scopeFilter === DirectoryScope.PLATFORM) {
      // default: when listing all hybrid without tenant, platform ACTIVE only
      if (!options.tenantId) where.status = RecordStatus.ACTIVE;
    }
  }

  const q = options.q?.trim();
  if (q && cfg.searchFields.length) {
    const searchOr = cfg.searchFields.map((field) => ({
      [field]: { contains: q, mode: 'insensitive' as const }
    }));
    return { AND: [where, { OR: searchOr }] };
  }
  return where;
}

async function assertDuplicateFree(
  resource: DirectoryResource,
  data: Record<string, unknown>,
  excludeId?: string
) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg.uniqueFields?.length) return;

  for (const field of cfg.uniqueFields) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    const where: Record<string, unknown> =
      resource === 'specialties' && field === 'name'
        ? { name: { equals: String(value), mode: 'insensitive' } }
        : { [field]: value };
    if (excludeId) where.NOT = { id: excludeId };
    const existing = await delegateFor(resource).findFirst({ where, select: { id: true } });
    if (existing) {
      const err: any = new Error(`A ${resource} record with this ${field} already exists`);
      err.status = 409;
      err.code = 'DUPLICATE';
      throw err;
    }
  }

  if (resource === 'credentialCategories') {
    const scope = (data.scope as DirectoryScope) || DirectoryScope.PLATFORM;
    const tenantId = (data.tenantId as string | null) ?? null;
    const code = String(data.code || '');
    const catWhere: Prisma.CredentialCategoryWhereInput =
      scope === DirectoryScope.PLATFORM
        ? { scope: DirectoryScope.PLATFORM, tenantId: null, code }
        : { scope: DirectoryScope.TENANT, tenantId: tenantId!, code };
    if (excludeId) catWhere.id = { not: excludeId };
    const dup = await prisma.credentialCategory.findFirst({ where: catWhere, select: { id: true } });
    if (dup) {
      const err: any = new Error('Credential category code already exists for this scope');
      err.status = 409;
      throw err;
    }
  }
}

async function stampTenantScopedCreate(
  resource: DirectoryResource,
  data: Record<string, unknown>,
  tenantId: string
) {
  if (RESOURCE_CONFIG[resource].scope === 'tenant') {
    data.tenantId = tenantId;
  }
  if (resource === 'payerContacts') {
    await assertRelatedRecordsSameTenant(tenantId, {});
    const payer = await prisma.payer.findUnique({ where: { id: String(data.payerId) }, select: { id: true } });
    if (!payer) denyNotFound();
    if (data.payerPlanId) {
      const plan = await prisma.payerPlan.findUnique({
        where: { id: String(data.payerPlanId) },
        select: { id: true, payerId: true }
      });
      if (!plan || plan.payerId !== data.payerId) denyNotFound();
    }
  }
  if (resource === 'billingEntities') {
    if (data.organizationId) {
      await assertRelatedRecordsSameTenant(tenantId, { organizationId: String(data.organizationId) });
    }
    data.tenantId = tenantId;
  }
  if (resource === 'credentialCategories' && (!data.scope || data.scope === DirectoryScope.TENANT)) {
    data.scope = DirectoryScope.TENANT;
    data.tenantId = tenantId;
  }
  if (resource === 'payerRequirements' && data.scope === DirectoryScope.TENANT) {
    data.tenantId = tenantId;
  }
}

export async function listDirectoryRecords(
  resource: DirectoryResource,
  query: { q?: string; status?: RecordStatus; page?: number; pageSize?: number; scope?: DirectoryScope },
  ctx: TenantAuthContext | undefined | null
) {
  const cfg = RESOURCE_CONFIG[resource];
  const tenantId = ctx?.tenantId ?? null;
  if (cfg.scope === 'tenant') requireTenantContext(ctx);

  const page = Math.max(1, query.page || 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize || 50));
  const where = buildListWhere(resource, {
    q: query.q,
    status: query.status,
    tenantId,
    scopeFilter: query.scope
  });

  const model = delegateFor(resource);
  const orderBy = cfg.sortDefault || { createdAt: 'desc' };
  const [total, data] = await Promise.all([
    model.count({ where }),
    model.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize })
  ]);
  return { data, total, page, pageSize };
}

export async function getDirectoryRecord(
  resource: DirectoryResource,
  id: string,
  ctx: TenantAuthContext | undefined | null
) {
  const cfg = RESOURCE_CONFIG[resource];
  const row = await delegateFor(resource).findUnique({ where: { id } });
  if (!row) denyNotFound();

  if (cfg.scope === 'tenant') {
    requireTenantContext(ctx);
    if (row.tenantId !== ctx!.tenantId) denyNotFound();
  }
  if (cfg.scope === 'hybrid') {
    if (row.scope === DirectoryScope.TENANT) {
      requireTenantContext(ctx);
      if (row.tenantId !== ctx!.tenantId) denyNotFound();
    }
  }
  return row;
}

export async function createDirectoryRecord(
  resource: DirectoryResource,
  raw: unknown,
  ctx: TenantAuthContext | undefined | null,
  platformRole: Role
) {
  const cfg = RESOURCE_CONFIG[resource];
  const schema = directorySchemas[resource];
  const data = schema.parse(raw) as Record<string, unknown>;

  if (cfg.scope === 'platform') {
    assertPlatformDirectoryWrite(ctx, platformRole);
    data.status = data.status || RecordStatus.ACTIVE;
  } else if (cfg.scope === 'tenant') {
    assertTenantDirectoryWrite(ctx);
    await stampTenantScopedCreate(resource, data, ctx!.tenantId!);
  } else {
    const scope = (data.scope as DirectoryScope) || DirectoryScope.PLATFORM;
    if (scope === DirectoryScope.PLATFORM) {
      assertPlatformDirectoryWrite(ctx, platformRole);
      data.scope = DirectoryScope.PLATFORM;
      data.tenantId = null;
    } else {
      assertTenantDirectoryWrite(ctx);
      data.scope = DirectoryScope.TENANT;
      await stampTenantScopedCreate(resource, data, ctx!.tenantId!);
    }
  }

  await assertDuplicateFree(resource, data);
  return delegateFor(resource).create({ data });
}

export async function updateDirectoryRecord(
  resource: DirectoryResource,
  id: string,
  raw: unknown,
  ctx: TenantAuthContext | undefined | null,
  platformRole: Role
) {
  const existing = await getDirectoryRecord(resource, id, ctx);
  const schema = (directorySchemas[resource] as z.ZodObject<any>).partial();
  const data = schema.parse(raw) as Record<string, unknown>;
  delete data.tenantId;
  if (resource === 'credentialCategories' || resource === 'payerRequirements') {
    delete data.scope;
  }

  const cfg = RESOURCE_CONFIG[resource];
  if (cfg.scope === 'platform' || (existing.scope === DirectoryScope.PLATFORM)) {
    assertPlatformDirectoryWrite(ctx, platformRole);
  } else {
    assertTenantDirectoryWrite(ctx);
  }

  await assertDuplicateFree(resource, { ...existing, ...data }, id);
  return delegateFor(resource).update({ where: { id }, data });
}

export async function deleteDirectoryRecord(
  resource: DirectoryResource,
  id: string,
  ctx: TenantAuthContext | undefined | null,
  platformRole: Role
) {
  const existing = await getDirectoryRecord(resource, id, ctx);
  const cfg = RESOURCE_CONFIG[resource];

  if (cfg.scope === 'platform' || existing.scope === DirectoryScope.PLATFORM) {
    assertPlatformDirectoryWrite(ctx, platformRole);
  } else {
    assertTenantDirectoryWrite(ctx);
  }

  const hard = await canHardDelete(resource, id);
  if (!hard || resource === 'credentialCategories') {
    return delegateFor(resource).update({
      where: { id },
      data: { status: RecordStatus.INACTIVE }
    });
  }
  await delegateFor(resource).delete({ where: { id } });
  return null;
}

export async function resolveCredentialCategories(tenantId: string | null) {
  const rows = await prisma.credentialCategory.findMany({
    where: {
      status: RecordStatus.ACTIVE,
      OR: [
        { scope: DirectoryScope.PLATFORM, tenantId: null },
        ...(tenantId ? [{ scope: DirectoryScope.TENANT, tenantId }] : [])
      ]
    },
    orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }]
  });
  return rows;
}

export async function linkBillingEntityPractice(
  billingEntityId: string,
  practiceId: string,
  ctx: TenantAuthContext | undefined | null
) {
  requireTenantContext(ctx);
  const entity = await prisma.billingEntity.findFirst({
    where: { id: billingEntityId, tenantId: ctx!.tenantId! },
    select: { id: true }
  });
  if (!entity) denyNotFound();
  await assertRelatedRecordsSameTenant(ctx!.tenantId!, { practiceId });
  return prisma.billingEntityPractice.upsert({
    where: { billingEntityId_practiceId: { billingEntityId, practiceId } },
    create: { billingEntityId, practiceId },
    update: {}
  });
}

export async function unlinkBillingEntityPractice(
  billingEntityId: string,
  practiceId: string,
  ctx: TenantAuthContext | undefined | null
) {
  requireTenantContext(ctx);
  const entity = await prisma.billingEntity.findFirst({
    where: { id: billingEntityId, tenantId: ctx!.tenantId! },
    select: { id: true }
  });
  if (!entity) denyNotFound();
  await prisma.billingEntityPractice.deleteMany({
    where: { billingEntityId, practiceId }
  });
}

export function getDirectoryEntityType(resource: DirectoryResource): string {
  return RESOURCE_CONFIG[resource].entityType;
}
