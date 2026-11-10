export const BANK_ACCOUNT_TYPES = ['Checking', 'Savings', 'Other'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** ABA routing number checksum (9 digits). */
export function isValidAbaRoutingNumber(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const digits = String(raw).replace(/\D/g, '');
  if (!/^\d{9}$/.test(digits)) return false;
  if (digits === '000000000') return false;
  const d = digits.split('').map(Number);
  const checksum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    (d[2] + d[5] + d[8]);
  return checksum % 10 === 0;
}

export function normalizeRoutingNumber(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  return String(raw).replace(/\D/g, '');
}

/**
 * Accept common US phone formats; store a cleaned display-friendly value.
 * Allows optional leading +, digits, spaces, dashes, parentheses, and ext.
 */
export function isValidBankPhone(raw: string | null | undefined): boolean {
  if (raw == null || raw === '') return true; // optional unless caller requires
  const trimmed = String(raw).trim();
  if (trimmed.length < 7 || trimmed.length > 32) return false;
  if (!/^\+?[\d\s().\-#]+(?:(?:ext|x)\.?\s*\d{1,6})?$/i.test(trimmed)) return false;
  const withoutExt = trimmed.replace(/(?:ext|x)\.?\s*\d{1,6}$/i, '');
  const digits = withoutExt.replace(/\D/g, '');
  // Allow 7–15 digits (NANP or international)
  return digits.length >= 7 && digits.length <= 15;
}

export function normalizeBankPhone(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  return String(raw).trim().replace(/\s+/g, ' ').slice(0, 32);
}

export function isValidBankAccountType(raw: string | null | undefined): boolean {
  if (raw == null || raw === '') return true;
  return (BANK_ACCOUNT_TYPES as readonly string[]).includes(String(raw));
}

export function routingValidationMessage(): string {
  return 'Routing number must be a valid 9-digit ABA routing number';
}

export function phoneValidationMessage(): string {
  return 'Bank phone number must be a valid phone format (7–15 digits)';
}

export function accountTypeValidationMessage(): string {
  return 'Account type must be Checking, Savings, or Other';
}
