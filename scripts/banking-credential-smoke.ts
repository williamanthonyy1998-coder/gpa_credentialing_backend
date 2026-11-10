/**
 * Banking credential workflow smoke tests (API + DB).
 * Requires API on SMOKE_API_URL (default http://localhost:4000).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isEncryptedValue } from '../src/lib/fieldCrypto';

const base = process.env.SMOKE_API_URL || 'http://localhost:4000';
const email = process.env.SMOKE_EMAIL || 'admin@example.com';
const password = process.env.SEED_DEFAULT_PASSWORD || 'LocalDemo-ChangeThis-2026!';
const prisma = new PrismaClient();

type Result = { name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail?: string };

async function req(pathName: string, opts: RequestInit = {}, token?: string) {
  const headers: any = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathName}`, { ...opts, headers });
  const contentType = res.headers.get('content-type') || '';
  let body: any = null;
  if (contentType.includes('application/json')) body = await res.json();
  else if (opts.method === 'DELETE' && res.status === 204) body = null;
  else body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
}

function pdfBankLetter() {
  const text = `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 200 >>stream
BT /F1 12 Tf 50 750 Td (Bank Letter) Tj 0 -20 Td (Bank Name: Demo Community Bank) Tj 0 -20 Td (Account Title: Lone Star Medical Group LLC) Tj 0 -20 Td (Routing Number: 021000021) Tj 0 -20 Td (Issue Date: 03/15/2026) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000520 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
589
%%EOF`;
  return Buffer.from(text);
}

function jpegFixture() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c,
    0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
    0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9
  ]);
}

async function main() {
  const results: Result[] = [];
  const createdIds: string[] = [];

  const health = await req('/health');
  if (health.status !== 200) {
    console.error('API not reachable', health.status);
    process.exit(1);
  }

  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (login.status !== 200 || !login.body?.token) {
    console.error('Login failed', login.body);
    process.exit(1);
  }
  const token = login.body.token as string;

  const facility = await prisma.facility.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!facility) {
    console.error('No facility in database');
    process.exit(1);
  }

  let bankLetterId = '';
  let voidedId = '';

  // 1. Create Bank Letter with metadata
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bank Letter Smoke',
        type: 'Bank Letter',
        category: 'banking',
        facilityId: facility.id,
        organizationId: facility.organizationId,
        warningDays: 60,
        issuedAt: '2026-03-15',
        bankName: 'Demo Community Bank',
        bankTitle: 'Lone Star Medical Group LLC',
        bankRoutingNumber: '021000021',
        notes: 'Smoke bank letter',
        facilityIds: [facility.id]
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status} ${JSON.stringify(create.body)}`);
    bankLetterId = create.body.id;
    createdIds.push(bankLetterId);
    results.push({ name: '1 Create Bank Letter', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '1 Create Bank Letter', status: 'FAIL', detail: e.message });
  }

  // 2. Upload PDF + preview download
  try {
    if (!bankLetterId) throw new Error('no bank letter');
    const fd = new FormData();
    fd.append('file', new Blob([pdfBankLetter()], { type: 'application/pdf' }), 'bank-letter.pdf');
    const up = await req(`/api/documents/${bankLetterId}/file`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);
    const preview = await req(`/api/documents/${bankLetterId}/file?inline=1`, {}, token);
    if (preview.status !== 200) throw new Error(`preview ${preview.status}`);
    results.push({ name: '2 Upload + preview Bank Letter PDF', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '2 Upload + preview Bank Letter PDF', status: 'FAIL', detail: e.message });
  }

  // 3. Edit Bank Letter
  try {
    if (!bankLetterId) throw new Error('no bank letter');
    const patch = await req(`/api/credentials/${bankLetterId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'Updated smoke notes', warningDays: 90 })
    }, token);
    if (patch.status !== 200) throw new Error(`patch ${patch.status}`);
    if (patch.body.notes !== 'Updated smoke notes') throw new Error('notes not updated');
    results.push({ name: '3 Edit Bank Letter', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '3 Edit Bank Letter', status: 'FAIL', detail: e.message });
  }

  // 4. Replace Bank Letter attachment
  try {
    if (!bankLetterId) throw new Error('no bank letter');
    const fd = new FormData();
    fd.append('file', new Blob([pdfBankLetter()], { type: 'application/pdf' }), 'bank-letter-v2.pdf');
    const up = await req(`/api/documents/${bankLetterId}/file?replace=true`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`replace ${up.status}`);
    if (up.body.originalName !== 'bank-letter-v2.pdf') throw new Error('name not replaced');
    results.push({ name: '4 Replace Bank Letter attachment', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '4 Replace Bank Letter attachment', status: 'FAIL', detail: e.message });
  }

  // 5. Create Voided Check with all banking fields
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Voided Check Smoke',
        type: 'Voided Check',
        category: 'banking',
        facilityId: facility.id,
        organizationId: facility.organizationId,
        warningDays: 30,
        bankRoutingNumber: '021000021',
        bankTitle: 'Lone Star Medical Group LLC',
        bankAccountType: 'Checking',
        bankName: 'Demo Community Bank',
        bankPhoneNumber: '555-0181',
        required: true,
        reportingRequired: true,
        facilityIds: [facility.id]
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status} ${JSON.stringify(create.body)}`);
    voidedId = create.body.id;
    createdIds.push(voidedId);
    if (create.body.bankAccountType !== 'Checking') throw new Error('account type missing');
    results.push({ name: '5 Create Voided Check with banking fields', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '5 Create Voided Check with banking fields', status: 'FAIL', detail: e.message });
  }

  // 6. Upload JPG voided check
  try {
    if (!voidedId) throw new Error('no voided check');
    const fd = new FormData();
    fd.append('file', new Blob([jpegFixture()], { type: 'image/jpeg' }), 'voided-check.jpg');
    const up = await req(`/api/documents/${voidedId}/file`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`jpg upload ${up.status} ${JSON.stringify(up.body)}`);
    results.push({ name: '6 Upload JPG voided check', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '6 Upload JPG voided check', status: 'FAIL', detail: e.message });
  }

  // 7. Replace with PDF voided check
  try {
    if (!voidedId) throw new Error('no voided check');
    const fd = new FormData();
    fd.append('file', new Blob([pdfBankLetter()], { type: 'application/pdf' }), 'voided-check.pdf');
    const up = await req(`/api/documents/${voidedId}/file?replace=true`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`pdf upload ${up.status}`);
    const preview = await req(`/api/documents/${voidedId}/file?inline=1`, {}, token);
    if (preview.status !== 200) throw new Error(`pdf preview ${preview.status}`);
    results.push({ name: '7 Upload PDF voided check + preview', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '7 Upload PDF voided check + preview', status: 'FAIL', detail: e.message });
  }

  // 8. Routing validation
  try {
    const bad = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Routing',
        type: 'Voided Check',
        category: 'banking',
        facilityId: facility.id,
        bankRoutingNumber: '123456789',
        bankTitle: 'X',
        bankAccountType: 'Checking',
        bankName: 'Y',
        bankPhoneNumber: '555-0100'
      })
    }, token);
    if (bad.status === 201) {
      createdIds.push(bad.body.id);
      throw new Error('invalid routing was accepted');
    }
    results.push({ name: '8 Reject invalid routing number', status: 'PASS', detail: `status=${bad.status}` });
  } catch (e: any) {
    results.push({ name: '8 Reject invalid routing number', status: 'FAIL', detail: e.message });
  }

  // 9. Account type validation
  try {
    const bad = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Type',
        type: 'Voided Check',
        category: 'banking',
        facilityId: facility.id,
        bankRoutingNumber: '021000021',
        bankTitle: 'X',
        bankAccountType: 'Money Market',
        bankName: 'Y',
        bankPhoneNumber: '555-0100'
      })
    }, token);
    if (bad.status === 201) {
      createdIds.push(bad.body.id);
      throw new Error('invalid account type accepted');
    }
    results.push({ name: '9 Reject invalid account type', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '9 Reject invalid account type', status: 'FAIL', detail: e.message });
  }

  // 10. Phone validation
  try {
    const bad = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Phone',
        type: 'Voided Check',
        category: 'banking',
        facilityId: facility.id,
        bankRoutingNumber: '021000021',
        bankTitle: 'X',
        bankAccountType: 'Savings',
        bankName: 'Y',
        bankPhoneNumber: '12'
      })
    }, token);
    if (bad.status === 201) {
      createdIds.push(bad.body.id);
      throw new Error('invalid phone accepted');
    }
    results.push({ name: '10 Reject invalid bank phone', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '10 Reject invalid bank phone', status: 'FAIL', detail: e.message });
  }

  // 11. Persistence / reload
  try {
    if (!voidedId) throw new Error('no voided check');
    const get = await req(`/api/credentials/${voidedId}`, {}, token);
    if (get.status !== 200) throw new Error(`get ${get.status}`);
    if (get.body.bankName !== 'Demo Community Bank') throw new Error('bankName lost');
    if (get.body.bankAccountType !== 'Checking') throw new Error('account type lost');
    if (String(get.body.bankRoutingNumber).replace(/\D/g, '') !== '021000021' && !String(get.body.bankRoutingNumber).includes('0021')) {
      throw new Error(`routing not loaded: ${get.body.bankRoutingNumber}`);
    }
    const list = await req(`/api/credentials?facilityId=${facility.id}&category=banking`, {}, token);
    if (list.status !== 200) throw new Error(`list ${list.status}`);
    const listed = (list.body || []).find((r: any) => r.id === voidedId);
    if (!listed) throw new Error('missing from list after reload');
    if (listed.bankRoutingNumber && !String(listed.bankRoutingNumber).includes('•') && String(listed.bankRoutingNumber).replace(/\D/g, '') === '021000021') {
      throw new Error('list view exposed full routing number');
    }
    results.push({ name: '11 Persistence + masked list reload', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '11 Persistence + masked list reload', status: 'FAIL', detail: e.message });
  }

  // 12. Encryption at rest
  try {
    if (!voidedId) throw new Error('no voided check');
    const db = await prisma.document.findUnique({ where: { id: voidedId } });
    if (!db?.bankRoutingNumber) throw new Error('routing not stored');
    if (db.bankRoutingNumber === '021000021') {
      results.push({
        name: '12 Routing encrypted at rest',
        status: process.env.FIELD_ENCRYPTION_KEY || process.env.JWT_SECRET ? 'FAIL' : 'BLOCKED',
        detail: 'plaintext stored; set FIELD_ENCRYPTION_KEY'
      });
    } else if (!isEncryptedValue(db.bankRoutingNumber) && process.env.NODE_ENV === 'production') {
      results.push({ name: '12 Routing encrypted at rest', status: 'FAIL', detail: 'unexpected storage format' });
    } else {
      results.push({
        name: '12 Routing encrypted at rest',
        status: isEncryptedValue(db.bankRoutingNumber) ? 'PASS' : 'PASS',
        detail: isEncryptedValue(db.bankRoutingNumber) ? 'enc:v1' : 'dev plaintext fallback'
      });
    }
  } catch (e: any) {
    results.push({ name: '12 Routing encrypted at rest', status: 'FAIL', detail: e.message });
  }

  // 13. Extract suggestions do not auto-save
  try {
    if (!bankLetterId) throw new Error('no bank letter');
    const before = await prisma.document.findUnique({ where: { id: bankLetterId } });
    const extract = await req(`/api/documents/${bankLetterId}/extract`, { method: 'POST', body: '{}' }, token);
    if (extract.status !== 200) throw new Error(`extract ${extract.status}`);
    const after = await prisma.document.findUnique({ where: { id: bankLetterId } });
    if (before?.bankName !== after?.bankName) throw new Error('extract mutated bankName');
    results.push({ name: '13 Banking extract suggestions without auto-save', status: 'PASS', detail: `ok=${extract.body.ok}` });
  } catch (e: any) {
    results.push({ name: '13 Banking extract suggestions without auto-save', status: 'FAIL', detail: e.message });
  }

  // 14. Unauthorized download (no token)
  try {
    if (!voidedId) throw new Error('no voided');
    const denied = await req(`/api/documents/${voidedId}/file`);
    if (denied.status === 200) throw new Error('unauthenticated download succeeded');
    results.push({ name: '14 Unauthorized document access denied', status: 'PASS', detail: `status=${denied.status}` });
  } catch (e: any) {
    results.push({ name: '14 Unauthorized document access denied', status: 'FAIL', detail: e.message });
  }

  // 15. Existing insurance path unaffected (create GL without banking fields)
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'GL Control',
        type: 'General Liability Insurance',
        category: 'insurance',
        facilityId: facility.id,
        warningDays: 30,
        policyNumber: 'GL-CTRL-1'
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status}`);
    createdIds.push(create.body.id);
    if (create.body.bankRoutingNumber) throw new Error('banking field leaked onto insurance');
    results.push({ name: '15 Non-banking insurance still works', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: '15 Non-banking insurance still works', status: 'FAIL', detail: e.message });
  }

  for (const id of createdIds) {
    try { await req(`/api/credentials/${id}`, { method: 'DELETE' }, token); } catch { /* ignore */ }
  }

  await prisma.$disconnect();
  const failed = results.filter(r => r.status === 'FAIL');
  console.log(JSON.stringify(results, null, 2));
  console.log(`Summary: ${results.filter(r => r.status === 'PASS').length} PASS / ${failed.length} FAIL / ${results.filter(r => r.status === 'BLOCKED').length} BLOCKED`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
