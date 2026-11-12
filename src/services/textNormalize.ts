/** Shared text normalization for duplicate detection (Phase 1C). */

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeCase(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

/** Strip common punctuation used in legal/org names while preserving alphanumerics. */
export function normalizePunctuation(value: string): string {
  return collapseWhitespace(
    value
      .replace(/[.,/#!$%^&*;:{}=\-_`~()'"[\]\\|<>?+@]/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

export function normalizeDirectoryName(value: string | null | undefined): string {
  if (value == null) return '';
  return normalizeCase(normalizePunctuation(String(value)));
}

export function normalizeCode(value: string | null | undefined): string {
  if (value == null) return '';
  return collapseWhitespace(String(value)).toUpperCase();
}

export function normalizeStateAbbrev(value: string | null | undefined): string {
  if (value == null) return '';
  return collapseWhitespace(String(value)).toUpperCase();
}

/** Digits-only fingerprint for Tax ID comparison — never log the raw value. */
export function taxIdFingerprint(value: string | null | undefined): string | null {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 4) return null;
  // SHA-like short stable hash without crypto dependency for equality only.
  let h = 2166136261;
  for (let i = 0; i < digits.length; i += 1) {
    h ^= digits.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tax:${digits.length}:${(h >>> 0).toString(16)}`;
}

export function taxIdLast4(value: string | null | undefined): string | null {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

export function namesAreExactNormalized(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeDirectoryName(a);
  const nb = normalizeDirectoryName(b);
  return Boolean(na) && na === nb;
}

/** Simple token Jaccard for strong/possible duplicate classification. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeDirectoryName(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeDirectoryName(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}
