/**
 * Additive read-only scan of legacy free-text values that could not be mapped
 * unambiguously to Phase 1A directory records. Does not mutate data.
 *
 * Usage: npx tsx scripts/phase1b-legacy-mapping-report.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';

async function main() {
  const specialties = await prisma.specialty.findMany({ select: { id: true, name: true } });
  const bySpec = new Map(specialties.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const states = await prisma.usState.findMany({ select: { id: true, abbreviation: true, name: true } });
  const byAbbr = new Map(states.map((s) => [s.abbreviation.toUpperCase(), s.id]));
  const byStateName = new Map(states.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const licenseTypes = await prisma.licenseType.findMany({ select: { id: true, name: true, code: true } });
  const byLtName = new Map(licenseTypes.map((l) => [l.name.trim().toLowerCase(), l.id]));
  const byLtCode = new Map(licenseTypes.map((l) => [l.code.trim().toLowerCase(), l.id]));

  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      primarySpecialty: true,
      secondarySpecialty: true,
      primarySpecialtyId: true,
      secondarySpecialtyId: true
    }
  });

  const unmappedPrimary: Array<{ id: string; value: string }> = [];
  const unmappedSecondary: Array<{ id: string; value: string }> = [];
  for (const p of providers) {
    if (p.primarySpecialty && !p.primarySpecialtyId) {
      const key = p.primarySpecialty.trim().toLowerCase();
      if (!bySpec.has(key)) unmappedPrimary.push({ id: p.id, value: p.primarySpecialty });
    }
    if (p.secondarySpecialty && !p.secondarySpecialtyId) {
      const key = p.secondarySpecialty.trim().toLowerCase();
      if (!bySpec.has(key)) unmappedSecondary.push({ id: p.id, value: p.secondarySpecialty });
    }
  }

  const licenses = await prisma.license.findMany({
    select: { id: true, type: true, state: true, licenseTypeId: true, usStateId: true }
  });
  const unmappedLicenseType: Array<{ id: string; value: string }> = [];
  const unmappedLicenseState: Array<{ id: string; value: string }> = [];
  for (const l of licenses) {
    if (l.type && !l.licenseTypeId) {
      const key = l.type.trim().toLowerCase();
      if (!byLtName.has(key) && !byLtCode.has(key)) {
        unmappedLicenseType.push({ id: l.id, value: l.type });
      }
    }
    if (l.state && !l.usStateId) {
      const abbr = l.state.trim().toUpperCase();
      const nameKey = l.state.trim().toLowerCase();
      if (!byAbbr.has(abbr) && !byStateName.has(nameKey)) {
        unmappedLicenseState.push({ id: l.id, value: l.state });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      providersScanned: providers.length,
      licensesScanned: licenses.length,
      unmappedPrimarySpecialty: unmappedPrimary.length,
      unmappedSecondarySpecialty: unmappedSecondary.length,
      unmappedLicenseType: unmappedLicenseType.length,
      unmappedLicenseState: unmappedLicenseState.length
    },
    unmappedPrimarySpecialty: unmappedPrimary.slice(0, 200),
    unmappedSecondarySpecialty: unmappedSecondary.slice(0, 200),
    unmappedLicenseType: unmappedLicenseType.slice(0, 200),
    unmappedLicenseState: unmappedLicenseState.slice(0, 200),
    notes: [
      'Values listed here were left unchanged.',
      'Phase 1B does not invent default specialty/state/license mappings.',
      'Safe unambiguous backfills remain in seed-directories / prior migrations.'
    ]
  };

  const outDir = path.resolve(__dirname, '../../docs');
  const outPath = path.join(outDir, 'PHASE_1B_LEGACY_MAPPING_REPORT.md');
  const md = [
    '# Phase 1B — Legacy Mapping Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Providers scanned: ${report.summary.providersScanned}`,
    `- Licenses scanned: ${report.summary.licensesScanned}`,
    `- Unmapped primary specialty: ${report.summary.unmappedPrimarySpecialty}`,
    `- Unmapped secondary specialty: ${report.summary.unmappedSecondarySpecialty}`,
    `- Unmapped license type: ${report.summary.unmappedLicenseType}`,
    `- Unmapped license state: ${report.summary.unmappedLicenseState}`,
    '',
    '## Policy',
    '',
    ...report.notes.map((n) => `- ${n}`),
    '',
    '## Unmapped primary specialties (sample)',
    '',
    '```json',
    JSON.stringify(report.unmappedPrimarySpecialty, null, 2),
    '```',
    '',
    '## Unmapped secondary specialties (sample)',
    '',
    '```json',
    JSON.stringify(report.unmappedSecondarySpecialty, null, 2),
    '```',
    '',
    '## Unmapped license types (sample)',
    '',
    '```json',
    JSON.stringify(report.unmappedLicenseType, null, 2),
    '```',
    '',
    '## Unmapped license states (sample)',
    '',
    '```json',
    JSON.stringify(report.unmappedLicenseState, null, 2),
    '```',
    ''
  ].join('\n');

  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
