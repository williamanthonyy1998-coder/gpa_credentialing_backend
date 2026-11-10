import fs from 'node:fs';
import path from 'node:path';
import { isValidAbaRoutingNumber, normalizeRoutingNumber } from './bankingValidation';

export type ExtractedBankingField = {
  value: string | null;
  confidence: number | null;
};

export type BankingExtractionResult = {
  ok: boolean;
  method: 'pdf-text' | 'none';
  message?: string;
  fields: {
    bankName: ExtractedBankingField;
    bankTitle: ExtractedBankingField;
    bankRoutingNumber: ExtractedBankingField;
    bankPhoneNumber: ExtractedBankingField;
    bankAccountType: ExtractedBankingField;
    bankAccountHolder: ExtractedBankingField;
    issuedAt: ExtractedBankingField;
    documentType: ExtractedBankingField;
  };
};

const EMPTY: ExtractedBankingField = { value: null, confidence: null };

function emptyResult(message: string, method: BankingExtractionResult['method'] = 'none'): BankingExtractionResult {
  return {
    ok: false,
    method,
    message,
    fields: {
      bankName: { ...EMPTY },
      bankTitle: { ...EMPTY },
      bankRoutingNumber: { ...EMPTY },
      bankPhoneNumber: { ...EMPTY },
      bankAccountType: { ...EMPTY },
      bankAccountHolder: { ...EMPTY },
      issuedAt: { ...EMPTY },
      documentType: { ...EMPTY }
    }
  };
}

function field(value: string | null, confidence: number | null): ExtractedBankingField {
  if (value === null || value === undefined || value === '') return { ...EMPTY };
  return { value, confidence };
}

function normalizeDate(raw: string): string | null {
  const cleaned = raw.trim().replace(/[./]/g, '-');
  const mdy = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, '0');
    const dd = mdy[2].padStart(2, '0');
    let yyyy = mdy[3];
    if (yyyy.length === 2) yyyy = Number(yyyy) > 70 ? `19${yyyy}` : `20${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  }
  const ymd = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function firstMatch(text: string, patterns: RegExp[]): { value: string; confidence: number } | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) return { value: m[1].trim(), confidence: 0.7 };
  }
  return null;
}

function findRouting(text: string): ExtractedBankingField {
  const labeled = firstMatch(text, [
    /Routing\s*(?:Number|No\.?|#)?\s*[:#]?\s*(\d{9})\b/i,
    /ABA\s*(?:Number|No\.?|#)?\s*[:#]?\s*(\d{9})\b/i,
    /RTN\s*[:#]?\s*(\d{9})\b/i
  ]);
  if (labeled) {
    const digits = normalizeRoutingNumber(labeled.value);
    if (digits && isValidAbaRoutingNumber(digits)) return field(digits, labeled.confidence);
  }
  // MICR-style: only accept 9-digit sequences that pass ABA checksum — never invent
  const candidates = text.match(/\b\d{9}\b/g) || [];
  for (const c of candidates) {
    if (isValidAbaRoutingNumber(c)) return field(c, 0.55);
  }
  return { ...EMPTY };
}

function findAccountType(text: string): ExtractedBankingField {
  if (/\bchecking\b/i.test(text) && !/\bsavings\b/i.test(text)) return field('Checking', 0.6);
  if (/\bsavings\b/i.test(text) && !/\bchecking\b/i.test(text)) return field('Savings', 0.6);
  if (/\baccount\s*type\s*[:#]?\s*(checking|savings|other)\b/i.test(text)) {
    const m = text.match(/\baccount\s*type\s*[:#]?\s*(checking|savings|other)\b/i);
    if (m?.[1]) {
      const v = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      return field(v === 'Checking' || v === 'Savings' || v === 'Other' ? v : null, 0.72);
    }
  }
  return { ...EMPTY };
}

export function extractBankingFieldsFromText(text: string, hintType?: string | null): BankingExtractionResult {
  if (!text || !text.trim()) return emptyResult('No readable text was found in the document.');

  const normalized = text.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');

  const bankName = firstMatch(normalized, [
    /Bank\s*Name\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,80})/i,
    /(?:Financial\s+Institution|Depository)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,80})/i,
    /\b([A-Z][A-Za-z0-9 &.,'-]{2,50}\s+Bank(?:\s+(?:N\.?A\.?|National|Corporation|Corp\.?))?)\b/
  ]);

  const bankTitle = firstMatch(normalized, [
    /(?:Account\s+Title|Account\s+Name|Bank\s+Title)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i,
    /Payable\s+to\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i
  ]);

  const holder = firstMatch(normalized, [
    /(?:Account\s+Holder|Business\s+Name|Customer\s+Name|Payee)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i,
    /Named\s+(?:on\s+)?Account\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i
  ]);

  const phone = firstMatch(normalized, [
    /(?:Bank\s+)?(?:Phone|Tel(?:ephone)?|Contact)\s*(?:Number|No\.?)?\s*[:#]?\s*(\+?[\d\s().\-]{7,20})/i
  ]);

  const issued = firstMatch(normalized, [
    /(?:Issued|Issue\s+Date|Letter\s+Date|Date)\s*[:#]?\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i
  ]);

  let documentType: ExtractedBankingField = { ...EMPTY };
  if (/voided?\s+check/i.test(normalized) || hintType === 'Voided Check') {
    documentType = field('Voided Check', 0.65);
  } else if (/bank\s+letter|letter\s+of\s+credit|banking\s+letter/i.test(normalized) || hintType === 'Bank Letter') {
    documentType = field('Bank Letter', 0.65);
  }

  const result: BankingExtractionResult = {
    ok: true,
    method: 'pdf-text',
    fields: {
      bankName: bankName ? field(bankName.value.replace(/\n.*/, '').slice(0, 120), bankName.confidence) : { ...EMPTY },
      bankTitle: bankTitle ? field(bankTitle.value.replace(/\n.*/, '').slice(0, 120), bankTitle.confidence) : { ...EMPTY },
      bankRoutingNumber: findRouting(normalized),
      bankPhoneNumber: phone ? field(phone.value.replace(/\n.*/, '').trim().slice(0, 32), phone.confidence) : { ...EMPTY },
      bankAccountType: findAccountType(normalized),
      bankAccountHolder: holder ? field(holder.value.replace(/\n.*/, '').slice(0, 120), holder.confidence) : { ...EMPTY },
      issuedAt: issued ? field(normalizeDate(issued.value), issued.confidence) : { ...EMPTY },
      documentType
    }
  };

  const anyValue = Object.values(result.fields).some(f => f.value !== null);
  if (!anyValue) {
    return {
      ...result,
      ok: false,
      message: 'Document text was readable, but no banking fields could be identified. Enter values manually.'
    };
  }
  return result;
}

export async function extractBankingFromFile(
  fullPath: string,
  mimeType?: string | null,
  hintType?: string | null
): Promise<BankingExtractionResult> {
  const ext = path.extname(fullPath).toLowerCase();
  const isPdf = mimeType === 'application/pdf' || ext === '.pdf';
  const isImage = ['image/jpeg', 'image/png'].includes(String(mimeType || '')) || ['.jpg', '.jpeg', '.png'].includes(ext);

  if (isImage) {
    return emptyResult(
      'Image OCR is not enabled in the local private-processing pipeline. Preview the image and enter banking values manually.'
    );
  }

  if (!isPdf) {
    return emptyResult('Unsupported file type for extraction. Upload a PDF or enter values manually.');
  }

  if (!fs.existsSync(fullPath)) {
    return emptyResult('Stored file was not found for extraction.');
  }

  try {
    const pdfParseModule: any = await import('pdf-parse');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const buffer = fs.readFileSync(fullPath);
    const parsed = await pdfParse(buffer);
    const text = String(parsed?.text || '');
    if (!text.trim()) {
      return emptyResult('PDF contained no extractable text (may be a scanned image). Enter values manually.');
    }
    return extractBankingFieldsFromText(text, hintType);
  } catch (err: any) {
    return emptyResult(`PDF text extraction failed: ${err?.message || 'unknown error'}. Enter values manually.`);
  }
}
