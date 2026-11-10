/**
 * Insurance credential workflow smoke tests (API + DB).
 * Requires API on SMOKE_API_URL (default http://localhost:4000).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

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

function pdfFixture() {
  const text = `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 220 >>stream
BT /F1 12 Tf 50 750 Td (ACME Insurance Company) Tj 0 -20 Td (Named Insured: Demo Medical Group LLC) Tj 0 -20 Td (Policy Number: GL-998877) Tj 0 -20 Td (Effective Date: 01/15/2026) Tj 0 -20 Td (Expiration Date: 01/15/2027) Tj 0 -20 Td (Per Occurrence: $1000000) Tj 0 -20 Td (General Aggregate: $3000000) Tj 0 -20 Td (Commercial General Liability) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000540 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
609
%%EOF`;
  return Buffer.from(text);
}

function jpegFixture() {
  // Minimal valid JPEG (1x1)
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

  const facilities = await prisma.facility.findMany({ take: 3, include: { practice: true } });
  const providers = await prisma.provider.findMany({ take: 3 });
  if (!facilities.length || providers.length < 2) {
    results.push({ name: 'Seed data availability', status: 'BLOCKED', detail: 'Need facilities and >=2 providers' });
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
  const f1 = facilities[0];
  const orgId = f1.organizationId || f1.practice?.organizationId || null;
  // Seed data has one facility per org; create a same-org sibling for multi-select coverage.
  const f2 = await prisma.facility.create({
    data: {
      name: `Smoke Sister Facility ${Date.now()}`,
      practiceId: f1.practiceId,
      organizationId: orgId,
      status: 'ACTIVE'
    }
  });
  const createdFacilityIds = [f2.id];
  // Ensure two providers are affiliated to the same facility/org scope for multi-select.
  let affiliated = await prisma.providerFacility.findMany({
    where: { facilityId: f1.id },
    include: { provider: true },
    take: 2
  });
  if (affiliated.length < 2) {
    const extra = providers.find(p => !affiliated.some(a => a.providerId === p.id)) || providers[1];
    await prisma.providerFacility.upsert({
      where: { providerId_facilityId: { providerId: extra.id, facilityId: f1.id } },
      update: {},
      create: { providerId: extra.id, facilityId: f1.id, approvalStatus: 'Approved' }
    });
    affiliated = await prisma.providerFacility.findMany({
      where: { facilityId: f1.id },
      include: { provider: true },
      take: 2
    });
  }
  const p1 = affiliated[0].provider;
  const p2 = affiliated[1].provider;

  // Test 1: Create GL with associations + PDF
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'GL Policy Smoke Test',
        type: 'General Liability Insurance',
        category: 'insurance',
        facilityId: f1.id,
        organizationId: orgId,
        practiceId: f1.practiceId,
        warningDays: 30,
        policyNumber: 'GL-SMOKE-001',
        perOccurrence: 1000000,
        aggregate: 3000000,
        issuedAt: '2026-01-15T12:00:00.000Z',
        expiresAt: '2026-12-30T12:00:00.000Z',
        required: true,
        reportingRequired: true,
        facilityIds: [f1.id, f2.id],
        providerIds: [p1.id, p2.id]
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status} ${JSON.stringify(create.body)}`);
    createdIds.push(create.body.id);

    const fd = new FormData();
    fd.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'gl-policy.pdf');
    const up = await req(`/api/documents/${create.body.id}/file`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);

    const db = await prisma.document.findUnique({
      where: { id: create.body.id },
      include: { documentFacilities: true, documentProviders: true }
    });
    if (!db?.policyNumber || Number(db.perOccurrence) !== 1000000 || Number(db.aggregate) !== 3000000) {
      throw new Error('DB insurance fields mismatch');
    }
    if (db.documentFacilities.length < 2 || db.documentProviders.length < 2) {
      throw new Error(`Association counts f=${db.documentFacilities.length} p=${db.documentProviders.length}`);
    }
    if (!db.storageKey || db.mimeType !== 'application/pdf') throw new Error('PDF metadata missing');
    results.push({ name: 'Test 1 GL create + PDF + associations', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 1 GL create + PDF + associations', status: 'FAIL', detail: e.message });
  }

  // Test 2: Professional Liability with JPG
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'PL Policy Smoke Test',
        type: 'Professional Liability Insurance',
        category: 'insurance',
        facilityId: f1.id,
        organizationId: orgId,
        warningDays: 60,
        policyNumber: 'PL-SMOKE-002',
        perOccurrence: 500000,
        aggregate: 1500000,
        facilityIds: [f1.id],
        providerIds: [p1.id]
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status}`);
    createdIds.push(create.body.id);
    const fd = new FormData();
    fd.append('file', new Blob([jpegFixture()], { type: 'image/jpeg' }), 'pl-policy.jpg');
    const up = await req(`/api/documents/${create.body.id}/file`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);
    results.push({ name: 'Test 2 PL create + JPG', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 2 PL create + JPG', status: 'FAIL', detail: e.message });
  }

  const primaryId = createdIds[0];

  // Test 3: Reload associations
  try {
    const get = await req(`/api/credentials/${primaryId}`, {}, token);
    if (get.status !== 200) throw new Error(`get ${get.status}`);
    if ((get.body.facilityIds || []).length < 2) throw new Error('facilities not loaded');
    if ((get.body.providerIds || []).length < 2) throw new Error('providers not loaded');
    if (get.body.policyNumber !== 'GL-SMOKE-001') throw new Error('policy number missing');
    results.push({ name: 'Test 3 reload fields/associations', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 3 reload fields/associations', status: 'FAIL', detail: e.message });
  }

  // Test 4: warning days 30 -> 90 changes attention math (unit covered; verify persistence)
  try {
    const patch = await req(`/api/credentials/${primaryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ warningDays: 90 })
    }, token);
    if (patch.status !== 200) throw new Error(`patch ${patch.status}`);
    if (patch.body.warningDays !== 90) throw new Error('warningDays not updated');
    results.push({ name: 'Test 4 warning days update 90', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 4 warning days update 90', status: 'FAIL', detail: e.message });
  }

  // Test 5: replace document
  try {
    const fd = new FormData();
    fd.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'gl-policy-v2.pdf');
    const blocked = await req(`/api/documents/${primaryId}/file`, { method: 'POST', body: fd }, token);
    if (blocked.status !== 409) throw new Error(`expected 409 without replace, got ${blocked.status}`);
    const fd2 = new FormData();
    fd2.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'gl-policy-v2.pdf');
    const replaced = await req(`/api/documents/${primaryId}/file?replace=true`, { method: 'POST', body: fd2 }, token);
    if (replaced.status !== 200) throw new Error(`replace ${replaced.status}`);
    const get = await req(`/api/credentials/${primaryId}`, {}, token);
    if (get.body.originalName !== 'gl-policy-v2.pdf') throw new Error('originalName not updated');
    results.push({ name: 'Test 5 replace document', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 5 replace document', status: 'FAIL', detail: e.message });
  }

  // Test 6: unauthorized facility attachment (fake id)
  try {
    const bad = await req(`/api/credentials/${primaryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ facilityIds: [f1.id, 'facility-does-not-exist-xyz'] })
    }, token);
    if (bad.status === 200) throw new Error('should reject unknown facility');
    results.push({ name: 'Test 6 unauthorized/invalid facility rejected', status: 'PASS', detail: `status ${bad.status}` });
  } catch (e: any) {
    results.push({ name: 'Test 6 unauthorized/invalid facility rejected', status: 'FAIL', detail: e.message });
  }

  // Test 7: unsupported file type
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'malware.exe');
    const up = await req(`/api/documents/${primaryId}/file?replace=true`, { method: 'POST', body: fd }, token);
    if (up.status === 200) throw new Error('exe should be rejected');
    results.push({ name: 'Test 7 unsupported file rejected', status: 'PASS', detail: `status ${up.status}` });
  } catch (e: any) {
    results.push({ name: 'Test 7 unsupported file rejected', status: 'FAIL', detail: e.message });
  }

  // Test 8: preview inline
  try {
    const prev = await req(`/api/documents/${primaryId}/file?inline=1`, {}, token);
    if (prev.status !== 200) throw new Error(`preview ${prev.status}`);
    results.push({ name: 'Test 8 PDF inline preview', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 8 PDF inline preview', status: 'FAIL', detail: e.message });
  }

  // Test 9: OCR extract suggestions (no auto-persist of OCR values)
  try {
    const before = await prisma.document.findUnique({ where: { id: primaryId } });
    const extract = await req(`/api/documents/${primaryId}/extract`, { method: 'POST', body: '{}' }, token);
    if (extract.status !== 200) throw new Error(`extract ${extract.status} ${JSON.stringify(extract.body)}`);
    // OCR must not silently overwrite credential record
    const after = await prisma.document.findUnique({ where: { id: primaryId } });
    if (before?.policyNumber !== after?.policyNumber) throw new Error('OCR mutated credential unexpectedly');
    results.push({
      name: 'Test 9 OCR suggestions without auto-save',
      status: 'PASS',
      detail: `ok=${extract.body.ok} method=${extract.body.method}`
    });
  } catch (e: any) {
    results.push({ name: 'Test 9 OCR suggestions without auto-save', status: 'FAIL', detail: e.message });
  }

  // Test 10: attention endpoint excludes ignored and uses warning days
  try {
    const attn = await req(`/api/credentials/attention?facilityId=${f1.id}`, {}, token);
    if (attn.status !== 200) throw new Error(`attention ${attn.status}`);
    if (!attn.body.counts) throw new Error('counts missing');
    results.push({ name: 'Test 10 credential attention endpoint', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 10 credential attention endpoint', status: 'FAIL', detail: e.message });
  }

  // Test 11: non-insurance credential still works
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bank Letter Smoke',
        type: 'Bank Letter',
        category: 'banking',
        facilityId: f1.id,
        warningDays: 30,
        policyNumber: 'SHOULD-NOT-MATTER',
        perOccurrence: 12
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status}`);
    createdIds.push(create.body.id);
    // insurance fields should be stripped for non-insurance types
    const db = await prisma.document.findUnique({ where: { id: create.body.id } });
    if (db?.policyNumber) throw new Error('policyNumber should not persist for bank letter');
    results.push({ name: 'Test 11 non-insurance credentials', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 11 non-insurance credentials', status: 'FAIL', detail: e.message });
  }

  // Test 12: persistence after reload
  try {
    const list = await req(`/api/credentials?facilityId=${f1.id}&category=insurance`, {}, token);
    if (list.status !== 200) throw new Error(`list ${list.status}`);
    const found = (list.body || []).find((r: any) => r.id === primaryId);
    if (!found) throw new Error('credential missing after reload list');
    if ((found.facilityIds || []).length < 2) throw new Error('associations missing after reload');
    results.push({ name: 'Test 12 survives reload/list', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 12 survives reload/list', status: 'FAIL', detail: e.message });
  }

  // Cleanup smoke credentials + temp facility
  for (const id of createdIds) {
    try { await req(`/api/credentials/${id}`, { method: 'DELETE' }, token); } catch { /* ignore */ }
  }
  for (const id of createdFacilityIds) {
    try { await prisma.facility.delete({ where: { id } }); } catch { /* ignore */ }
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
