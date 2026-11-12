/**
 * Phase 1C read-only quality + legacy extension report.
 * Usage: npx tsx scripts/phase1c-quality-report.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { runDirectoryQualityAudit } from '../src/services/directoryQualityAudit';
import { findDuplicatePairs } from '../src/services/duplicateDetection';

async function main() {
  const audit = await runDirectoryQualityAudit({ tenantId: null, platformAccess: true });

  const payers = await prisma.payer.findMany({ select: { id: true, name: true, payerCode: true, status: true } });
  const plans = await prisma.payerPlan.findMany({
    select: { id: true, name: true, planCode: true, payerId: true, status: true }
  });
  const payerDupes = findDuplicatePairs(
    payers.map((p) => ({ id: p.id, name: p.name, code: p.payerCode, status: p.status })),
    { directoryType: 'payers', exactFields: ['name', 'code'] }
  );
  const planDupes = findDuplicatePairs(
    plans.map((p) => ({ id: p.id, name: p.name, code: p.planCode, payerId: p.payerId, status: p.status })),
    { directoryType: 'plans', exactFields: ['name', 'code'], groupBy: 'payerId' }
  );

  const byType: Record<string, number> = {};
  for (const item of audit.items) {
    byType[item.issueType] = (byType[item.issueType] || 0) + 1;
  }

  const md = [
    '# Phase 1C — Directory Quality Report',
    '',
    `Generated: ${audit.generatedAt}`,
    '',
    '## Inventory',
    '',
    ...Object.entries(audit.counts).map(
      ([k, v]) => `- **${k}**: total ${v.total}, active ${v.active}, inactive/other ${v.inactive}`
    ),
    '',
    '## Finding summary',
    '',
    `- Total findings: ${audit.findings.total}`,
    `- Duplicates: ${audit.findings.duplicates}`,
    `- Broken relationships: ${audit.findings.brokenRelationships}`,
    `- Unmapped legacy: ${audit.findings.unmappedLegacy}`,
    `- Missing required: ${audit.findings.missingRequired}`,
    `- NPI issues: ${audit.findings.npiIssues}`,
    '',
    '## Findings by type',
    '',
    ...Object.entries(byType).map(([k, n]) => `- ${k}: ${n}`),
    '',
    '## Potential duplicate payers (sample)',
    '',
    '```json',
    JSON.stringify(payerDupes.slice(0, 50), null, 2),
    '```',
    '',
    '## Potential duplicate plans (sample)',
    '',
    '```json',
    JSON.stringify(planDupes.slice(0, 50), null, 2),
    '```',
    '',
    '## Sample findings',
    '',
    '```json',
    JSON.stringify(audit.items.slice(0, 100), null, 2),
    '```',
    '',
    '## Policy',
    '',
    '- Report is read-only.',
    '- No automatic merges or legacy overwrites.',
    '- Tax IDs never included in report payloads.',
    ''
  ].join('\n');

  const outPath = path.resolve(__dirname, '../../docs/PHASE_1C_QUALITY_REPORT.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(audit.findings, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
