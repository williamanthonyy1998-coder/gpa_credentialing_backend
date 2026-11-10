import fs from 'node:fs';
import path from 'node:path';

export type ExtractedInsuranceField = {
  value: string | number | null;
  confidence: number | null;
};

export type InsuranceExtractionResult = {
  ok: boolean;
  method: 'pdf-text' | 'none';
  message?: string;
  fields: {
    insuranceCompany: ExtractedInsuranceField;
    policyNumber: ExtractedInsuranceField;
    issuedAt: ExtractedInsuranceField;
    expiresAt: ExtractedInsuranceField;
    perOccurrence: ExtractedInsuranceField;
    aggregate: ExtractedInsuranceField;
    namedInsured: ExtractedInsuranceField;
    documentType: ExtractedInsuranceField;
  };
};

const EMPTY: ExtractedInsuranceField = { value: null, confidence: null };

function emptyResult(message: string, method: InsuranceExtractionResult['method'] = 'none'): InsuranceExtractionResult {
  return {
    ok: false,
    method,
    message,
    fields: {
      insuranceCompany: { ...EMPTY },
      policyNumber: { ...EMPTY },
      issuedAt: { ...EMPTY },
      expiresAt: { ...EMPTY },
      perOccurrence: { ...EMPTY },
      aggregate: { ...EMPTY },
      namedInsured: { ...EMPTY },
      documentType: { ...EMPTY }
    }
  };
}

function field(value: string | number | null, confidence: number | null): ExtractedInsuranceField {
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

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function firstMatch(text: string, patterns: RegExp[]): { value: string; confidence: number } | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) return { value: m[1].trim(), confidence: 0.72 };
  }
  return null;
}

export function extractInsuranceFieldsFromText(text: string): InsuranceExtractionResult {
  if (!text || !text.trim()) return emptyResult('No readable text was found in the document.');

  const normalized = text.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');

  const policy = firstMatch(normalized, [
    /Policy\s*(?:Number|No\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{4,})/i,
    /\bPolicy\s+([A-Z0-9][A-Z0-9\-\/]{5,})\b/i
  ]);

  const company = firstMatch(normalized, [
    /(?:Insurance\s+Company|Insurer|Carrier|Underwriter)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,80})/i,
    /\b([A-Z][A-Za-z0-9 &.,'-]{2,60}\s+(?:Insurance|Assurance|Indemnity|Mutual)(?:\s+Company)?)\b/
  ]);

  const named = firstMatch(normalized, [
    /Named\s+Insured\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i,
    /Insured(?:'s)?\s+Name\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 &.,'-]{2,100})/i
  ]);

  const effective = firstMatch(normalized, [
    /(?:Effective|Issued|Policy\s+Effective|Inception)\s*(?:Date)?\s*[:#]?\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i
  ]);

  const expiration = firstMatch(normalized, [
    /(?:Expiration|Expiry|Expires|Policy\s+Expiration|Termination)\s*(?:Date)?\s*[:#]?\s*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i
  ]);

  const occurrence = firstMatch(normalized, [
    /(?:Per\s+Occurrence|Each\s+Occurrence|Occurrence\s+Limit|Limit\s+Per\s+Occurrence)\s*[:#]?\s*\$?\s*([0-9,]+\.?\d*)/i
  ]);

  const aggregate = firstMatch(normalized, [
    /(?:General\s+Aggregate|Aggregate\s+Limit|Policy\s+Aggregate|Aggregate)\s*[:#]?\s*\$?\s*([0-9,]+\.?\d*)/i
  ]);

  let documentType: ExtractedInsuranceField = { ...EMPTY };
  if (/professional\s+liability|malpractice|errors?\s+and\s+omissions|\bE&O\b/i.test(normalized)) {
    documentType = field('Professional Liability Insurance', 0.65);
  } else if (/general\s+liability|\bCGL\b|commercial\s+general/i.test(normalized)) {
    documentType = field('General Liability Insurance', 0.65);
  }

  const issuedAt = effective ? field(normalizeDate(effective.value), effective.confidence) : { ...EMPTY };
  const expiresAt = expiration ? field(normalizeDate(expiration.value), expiration.confidence) : { ...EMPTY };

  const result: InsuranceExtractionResult = {
    ok: true,
    method: 'pdf-text',
    fields: {
      insuranceCompany: company ? field(company.value.replace(/\n.*/, '').slice(0, 120), company.confidence) : { ...EMPTY },
      policyNumber: policy ? field(policy.value.slice(0, 64), policy.confidence) : { ...EMPTY },
      issuedAt,
      expiresAt,
      perOccurrence: occurrence ? field(parseMoney(occurrence.value), occurrence.confidence) : { ...EMPTY },
      aggregate: aggregate ? field(parseMoney(aggregate.value), aggregate.confidence) : { ...EMPTY },
      namedInsured: named ? field(named.value.replace(/\n.*/, '').slice(0, 120), named.confidence) : { ...EMPTY },
      documentType
    }
  };

  const anyValue = Object.values(result.fields).some(f => f.value !== null);
  if (!anyValue) {
    return {
      ...result,
      ok: false,
      message: 'Document text was readable, but no insurance fields could be identified. Enter values manually.'
    };
  }
  return result;
}

export async function extractInsuranceFromFile(fullPath: string, mimeType?: string | null): Promise<InsuranceExtractionResult> {
  const ext = path.extname(fullPath).toLowerCase();
  const isPdf = mimeType === 'application/pdf' || ext === '.pdf';
  const isImage = ['image/jpeg', 'image/png'].includes(String(mimeType || '')) || ['.jpg', '.jpeg', '.png'].includes(ext);

  if (isImage) {
    return emptyResult(
      'Image OCR is not enabled in the local private-processing pipeline. Preview the image and enter policy values manually.'
    );
  }

  if (!isPdf) {
    return emptyResult('Unsupported file type for extraction. Upload a PDF or enter values manually.');
  }

  if (!fs.existsSync(fullPath)) {
    return emptyResult('Stored file was not found for extraction.');
  }

  try {
    // pdf-parse is CommonJS; dynamic import keeps startup light when unused.
    const pdfParseModule: any = await import('pdf-parse');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const buffer = fs.readFileSync(fullPath);
    const parsed = await pdfParse(buffer);
    const text = String(parsed?.text || '');
    if (!text.trim()) {
      return emptyResult('PDF contained no extractable text (may be a scanned image). Enter values manually.');
    }
    return extractInsuranceFieldsFromText(text);
  } catch (err: any) {
    return emptyResult(`PDF text extraction failed: ${err?.message || 'unknown error'}. Enter values manually.`);
  }
}
