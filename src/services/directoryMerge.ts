import { RecordStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type MergeableDirectory = 'specialties' | 'licenseTypes' | 'billingEntities' | 'credentialCategories';

function deny(message: string, status = 400): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}

export function assertMergeAllowed(
  directoryType: string,
  role: Role
): asserts directoryType is MergeableDirectory {
  const mergeable = new Set(['specialties', 'licenseTypes', 'billingEntities', 'credentialCategories']);
  if (!mergeable.has(directoryType)) {
    deny(
      `Safe merge is not available for ${directoryType}. Mark candidates as distinct or resolve manually.`,
      400
    );
  }
  if (directoryType === 'specialties' || directoryType === 'licenseTypes') {
    if (!([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(role)) {
      deny('Only platform administrators can merge global directory records', 403);
    }
  }
  if (directoryType === 'payers' || directoryType === 'plans') {
    deny('Payer and plan records cannot be merged through this workflow', 400);
  }
}

export type MergePreview = {
  directoryType: MergeableDirectory;
  survivorId: string;
  retiredId: string;
  dryRun: true;
  survivor: Record<string, unknown>;
  retired: Record<string, unknown>;
  differences: Array<{ field: string; survivor: unknown; retired: unknown }>;
  relationshipCounts: Record<string, number>;
  actions: string[];
  blockers: string[];
};

async function loadPair(directoryType: MergeableDirectory, survivorId: string, retiredId: string) {
  if (survivorId === retiredId) deny('Survivor and retired records must be different');
  if (directoryType === 'specialties') {
    const [survivor, retired] = await Promise.all([
      prisma.specialty.findUnique({ where: { id: survivorId } }),
      prisma.specialty.findUnique({ where: { id: retiredId } })
    ]);
    if (!survivor || !retired) deny('Specialty not found', 404);
    return { survivor, retired, tenantId: null as string | null };
  }
  if (directoryType === 'licenseTypes') {
    const [survivor, retired] = await Promise.all([
      prisma.licenseType.findUnique({ where: { id: survivorId } }),
      prisma.licenseType.findUnique({ where: { id: retiredId } })
    ]);
    if (!survivor || !retired) deny('License type not found', 404);
    return { survivor, retired, tenantId: null };
  }
  if (directoryType === 'billingEntities') {
    const [survivor, retired] = await Promise.all([
      prisma.billingEntity.findUnique({
        where: { id: survivorId },
        include: { practices: true }
      }),
      prisma.billingEntity.findUnique({
        where: { id: retiredId },
        include: { practices: true }
      })
    ]);
    if (!survivor || !retired) deny('Billing entity not found', 404);
    if (survivor.tenantId !== retired.tenantId) {
      deny('Cannot merge billing entities across tenants', 403);
    }
    return { survivor, retired, tenantId: survivor.tenantId };
  }
  const [survivor, retired] = await Promise.all([
    prisma.credentialCategory.findUnique({ where: { id: survivorId } }),
    prisma.credentialCategory.findUnique({ where: { id: retiredId } })
  ]);
  if (!survivor || !retired) deny('Credential category not found', 404);
  if (survivor.scope !== retired.scope || survivor.tenantId !== retired.tenantId) {
    deny('Cannot merge credential categories across scopes or tenants', 403);
  }
  return { survivor, retired, tenantId: survivor.tenantId };
}

function diffFields(survivor: any, retired: any, fields: string[]) {
  const differences: MergePreview['differences'] = [];
  for (const field of fields) {
    const a = survivor[field];
    const b = retired[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push({ field, survivor: a ?? null, retired: b ?? null });
    }
  }
  return differences;
}

export async function previewDirectoryMerge(input: {
  directoryType: string;
  survivorId: string;
  retiredId: string;
  role: Role;
  tenantId: string | null;
}): Promise<MergePreview> {
  assertMergeAllowed(input.directoryType, input.role);
  const directoryType = input.directoryType as MergeableDirectory;
  const { survivor, retired, tenantId } = await loadPair(directoryType, input.survivorId, input.retiredId);
  if (directoryType === 'billingEntities' || directoryType === 'credentialCategories') {
    if (!input.tenantId || tenantId !== input.tenantId) {
      deny('Tenant context does not match merge targets', 403);
    }
  }

  const blockers: string[] = [];
  const actions: string[] = [];
  const relationshipCounts: Record<string, number> = {};
  let differences: MergePreview['differences'] = [];

  if (directoryType === 'specialties') {
    differences = diffFields(survivor, retired, ['name', 'code', 'description', 'status']);
    const [joinCount, primaryCount, secondaryCount] = await Promise.all([
      prisma.providerSpecialty.count({ where: { specialtyId: retired.id } }),
      prisma.provider.count({ where: { primarySpecialtyId: retired.id } }),
      prisma.provider.count({ where: { secondarySpecialtyId: retired.id } })
    ]);
    relationshipCounts.providerSpecialtyLinks = joinCount;
    relationshipCounts.primarySpecialtyProviders = primaryCount;
    relationshipCounts.secondarySpecialtyProviders = secondaryCount;
    actions.push('Reassign ProviderSpecialty links to survivor');
    actions.push('Update provider primarySpecialtyId / secondarySpecialtyId');
    actions.push('Deactivate retired specialty (never hard-delete)');
  } else if (directoryType === 'licenseTypes') {
    differences = diffFields(survivor, retired, ['name', 'code', 'description', 'profession', 'status']);
    const licenseCount = await prisma.license.count({ where: { licenseTypeId: retired.id } });
    relationshipCounts.licenses = licenseCount;
    actions.push('Reassign licenses.licenseTypeId to survivor');
    actions.push('Deactivate retired license type');
  } else if (directoryType === 'billingEntities') {
    differences = diffFields(survivor, retired, ['legalName', 'dba', 'npi', 'entityType', 'status', 'organizationId']);
    // taxId intentionally omitted from diffs to avoid exposure — show presence only
    if (Boolean((survivor as any).taxId) !== Boolean((retired as any).taxId)) {
      differences.push({ field: 'taxIdPresent', survivor: Boolean((survivor as any).taxId), retired: Boolean((retired as any).taxId) });
    }
    relationshipCounts.practiceLinks = (retired as any).practices?.length || 0;
    actions.push('Move practice links to survivor (skip duplicates)');
    actions.push('Deactivate retired billing entity');
  } else {
    differences = diffFields(survivor, retired, ['code', 'name', 'description', 'status', 'tracksExpiration']);
    const docs = await prisma.document.count({ where: { category: (retired as any).code } });
    relationshipCounts.documentsByCode = docs;
    actions.push('Rewrite document.category codes from retired → survivor');
    actions.push('Deactivate retired category');
    if ((survivor as any).code === (retired as any).code) {
      blockers.push('Categories already share the same code');
    }
  }

  return {
    directoryType,
    survivorId: survivor.id,
    retiredId: retired.id,
    dryRun: true,
    survivor: sanitizePreviewRecord(directoryType, survivor),
    retired: sanitizePreviewRecord(directoryType, retired),
    differences,
    relationshipCounts,
    actions,
    blockers
  };
}

function sanitizePreviewRecord(directoryType: MergeableDirectory, row: any) {
  const copy = { ...row };
  delete copy.taxId;
  delete copy.practices;
  if (directoryType === 'billingEntities') {
    copy.taxIdPresent = Boolean(row.taxId);
  }
  return copy;
}

export async function commitDirectoryMerge(input: {
  directoryType: string;
  survivorId: string;
  retiredId: string;
  role: Role;
  tenantId: string | null;
  confirm: boolean;
}) {
  if (!input.confirm) deny('Explicit confirmation is required to commit a merge');
  const preview = await previewDirectoryMerge(input);
  if (preview.blockers.length) deny(`Merge blocked: ${preview.blockers.join('; ')}`);

  const directoryType = preview.directoryType;

  return prisma.$transaction(async (tx) => {
    if (directoryType === 'specialties') {
      const links = await tx.providerSpecialty.findMany({ where: { specialtyId: preview.retiredId } });
      for (const link of links) {
        const existing = await tx.providerSpecialty.findUnique({
          where: { providerId_specialtyId: { providerId: link.providerId, specialtyId: preview.survivorId } }
        });
        if (existing) {
          await tx.providerSpecialty.update({
            where: { id: existing.id },
            data: {
              isPrimary: existing.isPrimary || link.isPrimary,
              isSecondary: existing.isSecondary || link.isSecondary
            }
          });
          await tx.providerSpecialty.delete({ where: { id: link.id } });
        } else {
          await tx.providerSpecialty.update({
            where: { id: link.id },
            data: { specialtyId: preview.survivorId }
          });
        }
      }
      await tx.provider.updateMany({
        where: { primarySpecialtyId: preview.retiredId },
        data: { primarySpecialtyId: preview.survivorId }
      });
      await tx.provider.updateMany({
        where: { secondarySpecialtyId: preview.retiredId },
        data: { secondarySpecialtyId: preview.survivorId }
      });
      const survivor = await tx.specialty.findUniqueOrThrow({ where: { id: preview.survivorId } });
      await tx.provider.updateMany({
        where: { primarySpecialtyId: preview.survivorId },
        data: { primarySpecialty: survivor.name }
      });
      await tx.provider.updateMany({
        where: { secondarySpecialtyId: preview.survivorId },
        data: { secondarySpecialty: survivor.name }
      });
      await tx.specialty.update({
        where: { id: preview.retiredId },
        data: { status: RecordStatus.INACTIVE }
      });
    } else if (directoryType === 'licenseTypes') {
      await tx.license.updateMany({
        where: { licenseTypeId: preview.retiredId },
        data: { licenseTypeId: preview.survivorId }
      });
      const survivor = await tx.licenseType.findUniqueOrThrow({ where: { id: preview.survivorId } });
      await tx.license.updateMany({
        where: { licenseTypeId: preview.survivorId },
        data: { type: survivor.name }
      });
      await tx.licenseType.update({
        where: { id: preview.retiredId },
        data: { status: RecordStatus.INACTIVE }
      });
    } else if (directoryType === 'billingEntities') {
      const links = await tx.billingEntityPractice.findMany({ where: { billingEntityId: preview.retiredId } });
      for (const link of links) {
        await tx.billingEntityPractice.upsert({
          where: {
            billingEntityId_practiceId: {
              billingEntityId: preview.survivorId,
              practiceId: link.practiceId
            }
          },
          create: { billingEntityId: preview.survivorId, practiceId: link.practiceId },
          update: {}
        });
        await tx.billingEntityPractice.delete({
          where: {
            billingEntityId_practiceId: {
              billingEntityId: preview.retiredId,
              practiceId: link.practiceId
            }
          }
        });
      }
      await tx.billingEntity.update({
        where: { id: preview.retiredId },
        data: { status: RecordStatus.INACTIVE }
      });
    } else {
      const retired = await tx.credentialCategory.findUniqueOrThrow({ where: { id: preview.retiredId } });
      const survivor = await tx.credentialCategory.findUniqueOrThrow({ where: { id: preview.survivorId } });
      await tx.document.updateMany({
        where: { category: retired.code, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
        data: { category: survivor.code }
      });
      await tx.credentialCategory.update({
        where: { id: preview.retiredId },
        data: { status: RecordStatus.INACTIVE }
      });
    }

    return {
      directoryType,
      survivorId: preview.survivorId,
      retiredId: preview.retiredId,
      committed: true,
      relationshipCounts: preview.relationshipCounts,
      actions: preview.actions
    };
  });
}
