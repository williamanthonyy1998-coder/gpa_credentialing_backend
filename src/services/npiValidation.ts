/**
 * NPI format + Luhn checksum (CMS standard for 10-digit NPIs).
 * Does not call NPPES or claim external government verification.
 */

export type NpiValidationResult = {
  raw: string;
  digits: string;
  validFormat: boolean;
  validChecksum: boolean;
  ok: boolean;
  reason?: string;
};

export function digitsOnly(value: string | null | undefined): string {
  return String(value || '').replace(/\D/g, '');
}

/** Luhn check with NPI prefix 80840 as required by CMS. */
export function npiLuhnValid(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const full = `80840${digits}`;
  let sum = 0;
  let alternate = false;
  for (let i = full.length - 1; i >= 0; i -= 1) {
    let n = Number(full[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function validateNpi(value: string | null | undefined): NpiValidationResult {
  const raw = String(value || '').trim();
  if (!raw) {
    return { raw, digits: '', validFormat: false, validChecksum: false, ok: false, reason: 'empty' };
  }
  const digits = digitsOnly(raw);
  if (digits.length !== 10) {
    return {
      raw,
      digits,
      validFormat: false,
      validChecksum: false,
      ok: false,
      reason: 'NPI must be exactly 10 digits'
    };
  }
  if (!/^[12]\d{9}$/.test(digits)) {
    return {
      raw,
      digits,
      validFormat: false,
      validChecksum: false,
      ok: false,
      reason: 'NPI must start with 1 (individuals) or 2 (organizations)'
    };
  }
  const validChecksum = npiLuhnValid(digits);
  return {
    raw,
    digits,
    validFormat: true,
    validChecksum,
    ok: validChecksum,
    reason: validChecksum ? undefined : 'NPI checksum failed'
  };
}
