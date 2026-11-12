import {
  namesAreExactNormalized,
  normalizeCode,
  normalizeDirectoryName,
  taxIdFingerprint,
  tokenSimilarity
} from './textNormalize';

export type DuplicateStrength = 'EXACT' | 'STRONG' | 'POSSIBLE';

export type DuplicateCandidate = {
  strength: DuplicateStrength;
  leftId: string;
  rightId: string;
  leftLabel: string;
  rightLabel: string;
  reason: string;
  score: number;
  directoryType: string;
  tenantId?: string | null;
  /** Safe metadata only — never raw Tax ID. */
  meta?: Record<string, unknown>;
};

export type NamedRecord = {
  id: string;
  name?: string | null;
  legalName?: string | null;
  code?: string | null;
  payerCode?: string | null;
  planCode?: string | null;
  abbreviation?: string | null;
  taxId?: string | null;
  status?: string | null;
  tenantId?: string | null;
  payerId?: string | null;
};

function labelOf(r: NamedRecord): string {
  return r.name || r.legalName || r.code || r.abbreviation || r.id;
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Compare two named directory records with domain-aware rules.
 * Exact: normalized name/code equality.
 * Strong: high token overlap or matching code with similar name.
 * Possible: moderate token overlap — human review required.
 */
export function classifyNameDuplicate(
  left: NamedRecord,
  right: NamedRecord,
  opts: {
    directoryType: string;
    exactFields?: Array<'name' | 'legalName' | 'code' | 'abbreviation'>;
    strongThreshold?: number;
    possibleThreshold?: number;
  }
): DuplicateCandidate | null {
  if (left.id === right.id) return null;
  const strongThreshold = opts.strongThreshold ?? 0.85;
  const possibleThreshold = opts.possibleThreshold ?? 0.6;
  const fields = opts.exactFields || ['name', 'code'];

  for (const field of fields) {
    const lv = (left as any)[field];
    const rv = (right as any)[field];
    if (field === 'code' || field === 'abbreviation') {
      const lc = normalizeCode(lv);
      const rc = normalizeCode(rv);
      if (lc && lc === rc) {
        return {
          strength: 'EXACT',
          leftId: left.id,
          rightId: right.id,
          leftLabel: labelOf(left),
          rightLabel: labelOf(right),
          reason: `Identical ${field}`,
          score: 1,
          directoryType: opts.directoryType,
          tenantId: left.tenantId ?? right.tenantId ?? null
        };
      }
    } else if (namesAreExactNormalized(lv, rv)) {
      return {
        strength: 'EXACT',
        leftId: left.id,
        rightId: right.id,
        leftLabel: labelOf(left),
        rightLabel: labelOf(right),
        reason: `Identical normalized ${field}`,
        score: 1,
        directoryType: opts.directoryType,
        tenantId: left.tenantId ?? right.tenantId ?? null
      };
    }
  }

  const leftName = left.name || left.legalName || '';
  const rightName = right.name || right.legalName || '';
  const sim = tokenSimilarity(leftName, rightName);
  if (sim >= strongThreshold) {
    return {
      strength: 'STRONG',
      leftId: left.id,
      rightId: right.id,
      leftLabel: labelOf(left),
      rightLabel: labelOf(right),
      reason: `Strong name similarity (${sim.toFixed(2)})`,
      score: sim,
      directoryType: opts.directoryType,
      tenantId: left.tenantId ?? right.tenantId ?? null
    };
  }
  if (sim >= possibleThreshold) {
    return {
      strength: 'POSSIBLE',
      leftId: left.id,
      rightId: right.id,
      leftLabel: labelOf(left),
      rightLabel: labelOf(right),
      reason: `Possible name similarity (${sim.toFixed(2)}) — review required`,
      score: sim,
      directoryType: opts.directoryType,
      tenantId: left.tenantId ?? right.tenantId ?? null
    };
  }
  return null;
}

export function findDuplicatePairs(
  rows: NamedRecord[],
  opts: {
    directoryType: string;
    exactFields?: Array<'name' | 'legalName' | 'code' | 'abbreviation'>;
    sameTenantOnly?: boolean;
    /** When set, only compare rows sharing this payerId (plans). */
    groupBy?: 'payerId' | 'tenantId';
    includeTaxId?: boolean;
  }
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const seen = new Set<string>();

  const groups = new Map<string, NamedRecord[]>();
  for (const row of rows) {
    let key = 'all';
    if (opts.groupBy === 'payerId') key = row.payerId || 'none';
    if (opts.groupBy === 'tenantId') key = row.tenantId || 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (opts.sameTenantOnly && (a.tenantId || null) !== (b.tenantId || null)) continue;

        const key = pairKey(a.id, b.id);
        if (seen.has(key)) continue;

        if (opts.includeTaxId) {
          const fa = taxIdFingerprint(a.taxId);
          const fb = taxIdFingerprint(b.taxId);
          if (fa && fb && fa === fb) {
            seen.add(key);
            out.push({
              strength: 'STRONG',
              leftId: a.id,
              rightId: b.id,
              leftLabel: labelOf(a),
              rightLabel: labelOf(b),
              reason: 'Matching Tax ID fingerprint (secure comparison)',
              score: 0.95,
              directoryType: opts.directoryType,
              tenantId: a.tenantId ?? null,
              meta: { taxIdMatch: true }
            });
            continue;
          }
        }

        const candidate = classifyNameDuplicate(a, b, {
          directoryType: opts.directoryType,
          exactFields: opts.exactFields
        });
        if (candidate) {
          seen.add(key);
          out.push(candidate);
        }
      }
    }
  }

  return out.sort((x, y) => y.score - x.score);
}

export function duplicateIssueType(strength: DuplicateStrength) {
  if (strength === 'EXACT') return 'DUPLICATE_EXACT' as const;
  if (strength === 'STRONG') return 'DUPLICATE_STRONG' as const;
  return 'DUPLICATE_POSSIBLE' as const;
}

export function duplicateFingerprint(directoryType: string, leftId: string, rightId: string) {
  const [a, b] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  return `dup:${directoryType}:${a}:${b}`;
}

export { normalizeDirectoryName, normalizeCode };
