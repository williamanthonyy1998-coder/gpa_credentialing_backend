import { Prisma, RecordStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  DuplicateCandidate,
  duplicateFingerprint,
  duplicateIssueType,
  findDuplicatePairs
} from './duplicateDetection';
import { validateNpi } from './npiValidation';
import { normalizeCode, normalizeDirectoryName, normalizeStateAbbrev, taxIdLast4 } from './textNormalize';
import { profileCompletion } from './profileCompletion';

export type QualityFinding = {
  issueType: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  directoryType: string;
  recordId?: string | null;
  relatedRecordId?: string | null;
  fingerprint: string;
  title: string;
  description?: string;
  details?: Record<string, unknown>;
  tenantId?: string | null;
};

export type QualityAuditSummary = {
  generatedAt: string;
  tenantId: string | null;
  platformAccess: boolean;
  counts: {
    specialties: { total: number; active: number; inactive: number };
    usStates: { total: number; active: number; inactive: number };
    licenseTypes: { total: number; active: number; inactive: number };
    payers: { total: number; active: number; inactive: number };
    plans: { total: number; active: number; inactive: number };
    billingEntities: { total: number; active: number; inactive: number };
    credentialCategories: { total: number; active: number; inactive: number };
  };
  findings: {
    duplicates: number;
    brokenRelationships: number;
    unmappedLegacy: number;
    missingRequired: number;
    npiIssues: number;
    other: number;
    total: number;
  };
  items: QualityFinding[];
};

function statusCounts(rows: { status: RecordStatus }[]) {
  const total = rows.length;
  const active = rows.filter((r) => r.status === RecordStatus.ACTIVE).length;
  const inactive = total - active;
  return { total, active, inactive };
}

function findingFromDuplicate(c: DuplicateCandidate): QualityFinding {
  return {
    issueType: duplicateIssueType(c.strength),
    severity: c.strength === 'EXACT' ? 'HIGH' : c.strength === 'STRONG' ? 'MEDIUM' : 'LOW',
    directoryType: c.directoryType,
    recordId: c.leftId,
    relatedRecordId: c.rightId,
    fingerprint: duplicateFingerprint(c.directoryType, c.leftId, c.rightId),
    title: `${c.strength} duplicate: ${c.leftLabel} ↔ ${c.rightLabel}`,
    description: c.reason,
    details: { score: c.score, meta: c.meta || null },
    tenantId: c.tenantId ?? null
  };
}

async function auditSpecialties(): Promise<QualityFinding[]> {
  const rows = await prisma.specialty.findMany({
    select: { id: true, name: true, code: true, status: true }
  });
  const findings: QualityFinding[] = [];
  for (const r of rows) {
    if (!String(r.name || '').trim()) {
      findings.push({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'specialties',
        recordId: r.id,
        fingerprint: `missing:specialties:name:${r.id}`,
        title: 'Specialty missing name',
        tenantId: null
      });
    }
    if (![RecordStatus.ACTIVE, RecordStatus.INACTIVE, RecordStatus.PENDING, RecordStatus.ARCHIVED].includes(r.status)) {
      findings.push({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'MEDIUM',
        directoryType: 'specialties',
        recordId: r.id,
        fingerprint: `status:specialties:${r.id}`,
        title: `Specialty has unexpected status ${r.status}`,
        tenantId: null
      });
    }
  }
  findings.push(
    ...findDuplicatePairs(
      rows.map((r) => ({ id: r.id, name: r.name, code: r.code, status: r.status })),
      { directoryType: 'specialties', exactFields: ['name', 'code'] }
    ).map(findingFromDuplicate)
  );

  // Provider specialty FK / join conflicts
  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      primarySpecialtyId: true,
      secondarySpecialtyId: true,
      specialties: { select: { specialtyId: true, isPrimary: true, isSecondary: true } }
    }
  });
  const specialtyIds = new Set(rows.map((r) => r.id));
  for (const p of providers) {
    if (p.primarySpecialtyId && !specialtyIds.has(p.primarySpecialtyId)) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'CRITICAL',
        directoryType: 'providers',
        recordId: p.id,
        fingerprint: `broken:provider:primarySpecialty:${p.id}`,
        title: 'Provider primarySpecialtyId points to missing specialty',
        tenantId: null
      });
    }
    if (p.secondarySpecialtyId && !specialtyIds.has(p.secondarySpecialtyId)) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'HIGH',
        directoryType: 'providers',
        recordId: p.id,
        fingerprint: `broken:provider:secondarySpecialty:${p.id}`,
        title: 'Provider secondarySpecialtyId points to missing specialty',
        tenantId: null
      });
    }
    const primaries = p.specialties.filter((s) => s.isPrimary);
    if (primaries.length > 1) {
      findings.push({
        issueType: 'SPECIALTY_CONFLICT',
        severity: 'HIGH',
        directoryType: 'providers',
        recordId: p.id,
        fingerprint: `conflict:provider:multiPrimary:${p.id}`,
        title: 'Provider has multiple primary specialty join rows',
        details: { count: primaries.length },
        tenantId: null
      });
    }
    if (p.primarySpecialtyId) {
      const joinPrimary = p.specialties.find((s) => s.isPrimary);
      if (joinPrimary && joinPrimary.specialtyId !== p.primarySpecialtyId) {
        findings.push({
          issueType: 'SPECIALTY_CONFLICT',
          severity: 'HIGH',
          directoryType: 'providers',
          recordId: p.id,
          fingerprint: `conflict:provider:fkJoin:${p.id}`,
          title: 'Primary specialty FK conflicts with ProviderSpecialty join',
          details: { fk: p.primarySpecialtyId, join: joinPrimary.specialtyId },
          tenantId: null
        });
      }
    }
  }
  return findings;
}

async function auditStates(): Promise<QualityFinding[]> {
  const rows = await prisma.usState.findMany({
    select: { id: true, name: true, abbreviation: true, status: true }
  });
  const findings: QualityFinding[] = [];
  for (const r of rows) {
    const abbr = normalizeStateAbbrev(r.abbreviation);
    if (!/^[A-Z]{2}$/.test(abbr)) {
      findings.push({
        issueType: 'INVALID_REFERENCE',
        severity: 'HIGH',
        directoryType: 'usStates',
        recordId: r.id,
        fingerprint: `invalid:usStates:abbr:${r.id}`,
        title: `Invalid state abbreviation "${r.abbreviation}"`,
        tenantId: null
      });
    }
  }
  findings.push(
    ...findDuplicatePairs(
      rows.map((r) => ({ id: r.id, name: r.name, abbreviation: r.abbreviation, status: r.status })),
      { directoryType: 'usStates', exactFields: ['abbreviation', 'name'] }
    ).map(findingFromDuplicate)
  );

  const licenses = await prisma.license.findMany({
    select: { id: true, state: true, usStateId: true }
  });
  const byAbbr = new Map(rows.map((r) => [normalizeStateAbbrev(r.abbreviation), r.id]));
  const byName = new Map(rows.map((r) => [normalizeDirectoryName(r.name), r.id]));
  const stateIds = new Set(rows.map((r) => r.id));
  for (const l of licenses) {
    if (l.usStateId && !stateIds.has(l.usStateId)) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'HIGH',
        directoryType: 'licenses',
        recordId: l.id,
        fingerprint: `broken:license:usState:${l.id}`,
        title: 'License usStateId points to missing state',
        tenantId: null
      });
    }
    if (l.state && !l.usStateId) {
      const abbr = normalizeStateAbbrev(l.state);
      const nameKey = normalizeDirectoryName(l.state);
      if (!byAbbr.has(abbr) && !byName.has(nameKey)) {
        findings.push({
          issueType: 'UNMAPPED_LEGACY',
          severity: 'MEDIUM',
          directoryType: 'licenses',
          recordId: l.id,
          fingerprint: `unmapped:license:state:${l.id}`,
          title: 'License state free-text cannot be mapped safely',
          details: { statePreview: String(l.state).slice(0, 40) },
          tenantId: null
        });
      }
    }
  }
  return findings;
}

async function auditLicenseTypes(): Promise<QualityFinding[]> {
  const rows = await prisma.licenseType.findMany({
    select: { id: true, name: true, code: true, status: true, applicableStateCodes: true }
  });
  const findings: QualityFinding[] = [];
  for (const r of rows) {
    if (!String(r.name || '').trim()) {
      findings.push({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'licenseTypes',
        recordId: r.id,
        fingerprint: `missing:licenseTypes:name:${r.id}`,
        title: 'License type missing display name',
        tenantId: null
      });
    }
    const codes = r.applicableStateCodes;
    if (codes != null && !Array.isArray(codes) && typeof codes !== 'object') {
      findings.push({
        issueType: 'INVALID_REFERENCE',
        severity: 'LOW',
        directoryType: 'licenseTypes',
        recordId: r.id,
        fingerprint: `invalid:licenseTypes:applicability:${r.id}`,
        title: 'License type has unexpected state applicability shape',
        tenantId: null
      });
    }
  }
  findings.push(
    ...findDuplicatePairs(
      rows.map((r) => ({ id: r.id, name: r.name, code: r.code, status: r.status })),
      { directoryType: 'licenseTypes', exactFields: ['code', 'name'] }
    ).map(findingFromDuplicate)
  );

  const licenses = await prisma.license.findMany({
    select: { id: true, type: true, licenseTypeId: true, licenseType: { select: { name: true } } }
  });
  const typeIds = new Set(rows.map((r) => r.id));
  for (const l of licenses) {
    if (l.licenseTypeId && !typeIds.has(l.licenseTypeId)) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'HIGH',
        directoryType: 'licenses',
        recordId: l.id,
        fingerprint: `broken:license:type:${l.id}`,
        title: 'License licenseTypeId points to missing type',
        tenantId: null
      });
    }
    if (l.licenseTypeId && l.licenseType?.name && l.type) {
      if (normalizeDirectoryName(l.licenseType.name) !== normalizeDirectoryName(l.type)) {
        findings.push({
          issueType: 'INCONSISTENT_STATUS',
          severity: 'LOW',
          directoryType: 'licenses',
          recordId: l.id,
          fingerprint: `mismatch:license:typeString:${l.id}`,
          title: 'License type ID name mismatches legacy type string',
          details: { legacyType: String(l.type).slice(0, 80) },
          tenantId: null
        });
      }
    }
  }
  return findings;
}

async function auditPayersAndPlans(): Promise<QualityFinding[]> {
  const payers = await prisma.payer.findMany({
    select: { id: true, name: true, payerCode: true, status: true }
  });
  const plans = await prisma.payerPlan.findMany({
    select: {
      id: true,
      name: true,
      planCode: true,
      payerId: true,
      status: true,
      stateApplicability: true,
      payer: { select: { id: true, status: true, name: true } }
    }
  });
  const findings: QualityFinding[] = [];
  findings.push(
    ...findDuplicatePairs(
      payers.map((p) => ({ id: p.id, name: p.name, code: p.payerCode, status: p.status })),
      { directoryType: 'payers', exactFields: ['name', 'code'] }
    ).map(findingFromDuplicate)
  );
  findings.push(
    ...findDuplicatePairs(
      plans.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.planCode,
        payerId: p.payerId,
        status: p.status
      })),
      { directoryType: 'plans', exactFields: ['name', 'code'], groupBy: 'payerId' }
    ).map(findingFromDuplicate)
  );

  const payerIds = new Set(payers.map((p) => p.id));
  for (const plan of plans) {
    if (!payerIds.has(plan.payerId) || !plan.payer) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'CRITICAL',
        directoryType: 'plans',
        recordId: plan.id,
        fingerprint: `broken:plan:payer:${plan.id}`,
        title: 'Payer plan linked to missing payer',
        tenantId: null
      });
    } else if (plan.status === RecordStatus.ACTIVE && plan.payer.status !== RecordStatus.ACTIVE) {
      findings.push({
        issueType: 'INCONSISTENT_STATUS',
        severity: 'MEDIUM',
        directoryType: 'plans',
        recordId: plan.id,
        fingerprint: `status:plan:payerInactive:${plan.id}`,
        title: 'Active plan under inactive payer',
        details: { payerId: plan.payerId },
        tenantId: null
      });
    }
  }

  const enrollments = await prisma.enrollmentApplication.findMany({
    select: {
      id: true,
      payerPlanId: true,
      tenantId: true,
      payerPlan: { select: { id: true, payerId: true } }
    }
  });
  for (const e of enrollments) {
    if (!e.payerPlan) {
      findings.push({
        issueType: 'BROKEN_RELATIONSHIP',
        severity: 'CRITICAL',
        directoryType: 'enrollments',
        recordId: e.id,
        fingerprint: `broken:enrollment:plan:${e.id}`,
        title: 'Enrollment references missing payer plan',
        tenantId: e.tenantId
      });
    }
  }
  return findings;
}

async function auditBillingEntities(tenantId: string | null): Promise<QualityFinding[]> {
  if (!tenantId) return [];
  const rows = await prisma.billingEntity.findMany({
    where: { tenantId },
    select: {
      id: true,
      legalName: true,
      taxId: true,
      status: true,
      tenantId: true,
      organizationId: true,
      organization: { select: { id: true, tenantId: true } },
      practices: { select: { practiceId: true, practice: { select: { organizationId: true, organization: { select: { tenantId: true } } } } } }
    }
  });
  const findings: QualityFinding[] = [];
  findings.push(
    ...findDuplicatePairs(
      rows.map((r) => ({
        id: r.id,
        name: r.legalName,
        legalName: r.legalName,
        taxId: r.taxId,
        tenantId: r.tenantId,
        status: r.status
      })),
      {
        directoryType: 'billingEntities',
        exactFields: ['legalName'],
        sameTenantOnly: true,
        groupBy: 'tenantId',
        includeTaxId: true
      }
    ).map((c) => {
      const f = findingFromDuplicate(c);
      // Never expose tax id — only last4 if we have it on either side
      const left = rows.find((r) => r.id === c.leftId);
      const right = rows.find((r) => r.id === c.rightId);
      f.details = {
        ...(f.details || {}),
        taxIdLast4Left: taxIdLast4(left?.taxId) || undefined,
        taxIdLast4Right: taxIdLast4(right?.taxId) || undefined
      };
      return f;
    })
  );

  for (const r of rows) {
    if (!String(r.legalName || '').trim()) {
      findings.push({
        issueType: 'MISSING_REQUIRED',
        severity: 'HIGH',
        directoryType: 'billingEntities',
        recordId: r.id,
        fingerprint: `missing:billingEntities:legalName:${r.id}`,
        title: 'Billing entity missing legal name',
        tenantId
      });
    }
    if (r.organizationId) {
      if (!r.organization || (r.organization.tenantId && r.organization.tenantId !== tenantId)) {
        findings.push({
          issueType: 'BROKEN_RELATIONSHIP',
          severity: 'CRITICAL',
          directoryType: 'billingEntities',
          recordId: r.id,
          fingerprint: `broken:billingEntities:org:${r.id}`,
          title: 'Billing entity organization is missing or cross-tenant',
          tenantId
        });
      }
    }
    for (const link of r.practices) {
      const practiceTenant = link.practice?.organization?.tenantId;
      if (practiceTenant && practiceTenant !== tenantId) {
        findings.push({
          issueType: 'BROKEN_RELATIONSHIP',
          severity: 'CRITICAL',
          directoryType: 'billingEntities',
          recordId: r.id,
          relatedRecordId: link.practiceId,
          fingerprint: `broken:billingEntities:practice:${r.id}:${link.practiceId}`,
          title: 'Billing entity linked to practice from another tenant',
          tenantId
        });
      }
    }
  }
  return findings;
}

async function auditCredentialCategories(tenantId: string | null): Promise<QualityFinding[]> {
  const rows = await prisma.credentialCategory.findMany({
    where: {
      OR: [
        { scope: 'PLATFORM', tenantId: null },
        ...(tenantId ? [{ scope: 'TENANT' as const, tenantId }] : [])
      ]
    },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      scope: true,
      tenantId: true,
      tracksExpiration: true,
      defaultWarningDays: true
    }
  });
  const findings: QualityFinding[] = [];
  const byScope = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.scope === 'PLATFORM' ? 'PLATFORM' : `TENANT:${r.tenantId}`;
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key)!.push(r);
  }
  for (const group of byScope.values()) {
    findings.push(
      ...findDuplicatePairs(
        group.map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code,
          tenantId: r.tenantId,
          status: r.status
        })),
        { directoryType: 'credentialCategories', exactFields: ['code', 'name'], groupBy: 'tenantId' }
      ).map(findingFromDuplicate)
    );
    for (const r of group) {
      if (r.tracksExpiration && (r.defaultWarningDays == null || r.defaultWarningDays <= 0)) {
        findings.push({
          issueType: 'INVALID_REFERENCE',
          severity: 'LOW',
          directoryType: 'credentialCategories',
          recordId: r.id,
          fingerprint: `invalid:credentialCategories:warning:${r.id}`,
          title: 'Category tracks expiration but warning days are missing/invalid',
          tenantId: r.tenantId
        });
      }
    }
  }

  const docs = await prisma.document.findMany({
    where: tenantId ? { tenantId } : {},
    select: { id: true, category: true, status: true, tenantId: true },
    take: 5000
  });
  const byCode = new Map(rows.map((r) => [normalizeCode(r.code), r]));
  for (const d of docs) {
    const code = normalizeCode(d.category);
    if (!code) continue;
    const cat = byCode.get(code);
    if (!cat) {
      // May be legacy hardcoded — report as unmapped only when not in platform fallback list sense
      findings.push({
        issueType: 'CATEGORY_INCONSISTENCY',
        severity: 'LOW',
        directoryType: 'documents',
        recordId: d.id,
        fingerprint: `cat:doc:missing:${d.id}`,
        title: 'Document category code not found in directory (legacy may still be valid)',
        details: { category: code },
        tenantId: d.tenantId
      });
    } else if (cat.status !== RecordStatus.ACTIVE && d.status !== 'EXPIRED' && d.status !== 'REJECTED') {
      findings.push({
        issueType: 'CATEGORY_INCONSISTENCY',
        severity: 'MEDIUM',
        directoryType: 'documents',
        recordId: d.id,
        relatedRecordId: cat.id,
        fingerprint: `cat:doc:inactive:${d.id}`,
        title: 'Active/open document linked to inactive credential category',
        details: { category: code },
        tenantId: d.tenantId
      });
    }
  }
  return findings;
}

async function auditProviders(tenantId: string | null): Promise<QualityFinding[]> {
  if (!tenantId) return [];
  const links = await prisma.tenantProvider.findMany({
    where: { tenantId },
    select: { providerId: true }
  });
  const ids = links.map((l) => l.providerId);
  if (!ids.length) return [];
  const providers = await prisma.provider.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      npi: true,
      firstName: true,
      lastName: true,
      primarySpecialty: true,
      primarySpecialtyId: true,
      status: true,
      email: true,
      licenses: { select: { id: true, licenseTypeId: true, usStateId: true, type: true } }
    }
  });
  const findings: QualityFinding[] = [];
  const npiMap = new Map<string, string[]>();
  for (const p of providers) {
    if (p.npi) {
      const v = validateNpi(p.npi);
      if (!v.ok) {
        findings.push({
          issueType: 'NPI_INVALID',
          severity: 'HIGH',
          directoryType: 'providers',
          recordId: p.id,
          fingerprint: `npi:invalid:${p.id}`,
          title: `Invalid NPI for provider (${v.reason || 'failed'})`,
          tenantId
        });
      } else {
        const list = npiMap.get(v.digits) || [];
        list.push(p.id);
        npiMap.set(v.digits, list);
      }
    }
    const completion = profileCompletion('provider', p as any);
    if (completion.percent < 50) {
      findings.push({
        issueType: 'MISSING_REQUIRED',
        severity: 'LOW',
        directoryType: 'providers',
        recordId: p.id,
        fingerprint: `complete:provider:${p.id}`,
        title: `Provider profile completion low (${completion.percent}%)`,
        details: { percent: completion.percent },
        tenantId
      });
    }
  }
  for (const [digits, providerIds] of npiMap) {
    if (providerIds.length > 1) {
      // Same tenant duplicate NPI should be impossible due to @unique, but report if present
      findings.push({
        issueType: 'DUPLICATE_EXACT',
        severity: 'CRITICAL',
        directoryType: 'providers',
        recordId: providerIds[0],
        relatedRecordId: providerIds[1],
        fingerprint: `npi:dup:${digits}`,
        title: 'Duplicate NPI within scanned providers',
        description: 'Global NPI uniqueness should prevent this; investigate data integrity',
        details: { providerCount: providerIds.length },
        tenantId
      });
    }
  }

  // Cross-tenant NPI awareness (candidates only — never merge)
  const withNpi = providers.filter((p) => p.npi);
  for (const p of withNpi) {
    const digits = String(p.npi).replace(/\D/g, '');
    if (digits.length !== 10) continue;
    const others = await prisma.provider.findMany({
      where: { npi: p.npi, id: { not: p.id }, NOT: { tenantLinks: { some: { tenantId } } } },
      select: { id: true },
      take: 3
    });
    if (others.length) {
      findings.push({
        issueType: 'DUPLICATE_POSSIBLE',
        severity: 'LOW',
        directoryType: 'providers',
        recordId: p.id,
        relatedRecordId: others[0].id,
        fingerprint: `npi:crossTenant:${digits}:${tenantId}`,
        title: 'Same NPI exists outside this tenant (not mergeable across tenants)',
        description: 'Matching NPI does not authorize cross-tenant provider merge',
        details: { otherCount: others.length },
        tenantId
      });
    }
  }
  return findings;
}

function summarizeFindings(items: QualityFinding[]) {
  const duplicates = items.filter((i) => i.issueType.startsWith('DUPLICATE_')).length;
  const brokenRelationships = items.filter((i) => i.issueType === 'BROKEN_RELATIONSHIP').length;
  const unmappedLegacy = items.filter((i) => i.issueType === 'UNMAPPED_LEGACY').length;
  const missingRequired = items.filter((i) => i.issueType === 'MISSING_REQUIRED').length;
  const npiIssues = items.filter((i) => i.issueType === 'NPI_INVALID').length;
  const other = items.length - duplicates - brokenRelationships - unmappedLegacy - missingRequired - npiIssues;
  return { duplicates, brokenRelationships, unmappedLegacy, missingRequired, npiIssues, other, total: items.length };
}

/**
 * Read-only directory quality audit.
 * Platform catalogs always included; tenant-scoped entities require tenantId.
 */
export async function runDirectoryQualityAudit(opts: {
  tenantId: string | null;
  platformAccess: boolean;
  directoryType?: string;
}): Promise<QualityAuditSummary> {
  const [
    specialties,
    usStates,
    licenseTypes,
    payers,
    plans,
    billingEntities,
    credentialCategories
  ] = await Promise.all([
    prisma.specialty.findMany({ select: { status: true } }),
    prisma.usState.findMany({ select: { status: true } }),
    prisma.licenseType.findMany({ select: { status: true } }),
    prisma.payer.findMany({ select: { status: true } }),
    prisma.payerPlan.findMany({ select: { status: true } }),
    opts.tenantId
      ? prisma.billingEntity.findMany({ where: { tenantId: opts.tenantId }, select: { status: true } })
      : Promise.resolve([]),
    prisma.credentialCategory.findMany({
      where: {
        OR: [
          { scope: 'PLATFORM', tenantId: null },
          ...(opts.tenantId ? [{ scope: 'TENANT' as const, tenantId: opts.tenantId }] : [])
        ]
      },
      select: { status: true }
    })
  ]);

  const items: QualityFinding[] = [];
  const type = opts.directoryType;

  if (!type || type === 'specialties' || type === 'providers') items.push(...(await auditSpecialties()));
  if (!type || type === 'usStates' || type === 'licenses') items.push(...(await auditStates()));
  if (!type || type === 'licenseTypes' || type === 'licenses') items.push(...(await auditLicenseTypes()));
  if (!type || type === 'payers' || type === 'plans' || type === 'enrollments') {
    items.push(...(await auditPayersAndPlans()));
  }
  if ((!type || type === 'billingEntities') && opts.tenantId) {
    items.push(...(await auditBillingEntities(opts.tenantId)));
  }
  if (!type || type === 'credentialCategories' || type === 'documents') {
    items.push(...(await auditCredentialCategories(opts.tenantId)));
  }
  if ((!type || type === 'providers') && opts.tenantId) {
    items.push(...(await auditProviders(opts.tenantId)));
  }

  // Tenant isolation: drop findings for other tenants
  const scoped = items.filter((i) => {
    if (i.tenantId == null) return opts.platformAccess || !i.tenantId;
    return opts.tenantId != null && i.tenantId === opts.tenantId;
  });

  return {
    generatedAt: new Date().toISOString(),
    tenantId: opts.tenantId,
    platformAccess: opts.platformAccess,
    counts: {
      specialties: statusCounts(specialties),
      usStates: statusCounts(usStates),
      licenseTypes: statusCounts(licenseTypes),
      payers: statusCounts(payers),
      plans: statusCounts(plans),
      billingEntities: statusCounts(billingEntities),
      credentialCategories: statusCounts(credentialCategories)
    },
    findings: summarizeFindings(scoped),
    items: scoped
  };
}

export async function persistAuditFindings(
  findings: QualityFinding[],
  opts: { reopenResolved?: boolean } = {}
) {
  let created = 0;
  let updated = 0;
  for (const f of findings) {
    const existing = await prisma.dataQualityIssue.findUnique({ where: { fingerprint: f.fingerprint } });
    if (!existing) {
      await prisma.dataQualityIssue.create({
        data: {
          tenantId: f.tenantId ?? null,
          issueType: f.issueType as any,
          severity: f.severity as any,
          status: 'OPEN',
          directoryType: f.directoryType,
          recordId: f.recordId ?? null,
          relatedRecordId: f.relatedRecordId ?? null,
          fingerprint: f.fingerprint,
          title: f.title,
          description: f.description ?? null,
          details: (f.details || Prisma.JsonNull) as any
        }
      });
      created += 1;
      continue;
    }
    if (existing.status === 'ACCEPTED_LEGITIMATE' || existing.status === 'RESOLVED') {
      if (opts.reopenResolved && existing.status === 'RESOLVED') {
        await prisma.dataQualityIssue.update({
          where: { id: existing.id },
          data: { status: 'REOPENED', title: f.title, description: f.description, details: f.details as any }
        });
        updated += 1;
      }
      continue;
    }
    await prisma.dataQualityIssue.update({
      where: { id: existing.id },
      data: {
        severity: f.severity as any,
        title: f.title,
        description: f.description ?? null,
        details: (f.details || undefined) as any
      }
    });
    updated += 1;
  }
  return { created, updated };
}
