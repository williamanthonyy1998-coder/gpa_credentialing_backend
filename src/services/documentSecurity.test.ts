import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentSecurityStatus, Role } from '@prisma/client';
import {
  canInvestigativeDownload,
  canManualRelease,
  canNormalDownload,
  canProviderDownload,
  canStaffReviewDownload,
  isMalwareScannerConfigured,
  isTrustedForConversion
} from './documentSecurity';

test('quarantined files are not trusted for conversion', () => {
  assert.equal(isTrustedForConversion(DocumentSecurityStatus.QUARANTINED), false);
  assert.equal(isTrustedForConversion(DocumentSecurityStatus.SCANNING), false);
  assert.equal(isTrustedForConversion(DocumentSecurityStatus.REJECTED), false);
  assert.equal(isTrustedForConversion(DocumentSecurityStatus.AVAILABLE), true);
});

test('providers cannot download quarantined files', () => {
  assert.equal(canProviderDownload(DocumentSecurityStatus.QUARANTINED), false);
  assert.equal(canProviderDownload(DocumentSecurityStatus.UPLOADED), false);
  assert.equal(canProviderDownload(DocumentSecurityStatus.AVAILABLE), true);
});

test('H4: normal download denies quarantine for all roles including ADMIN', () => {
  assert.equal(canNormalDownload(DocumentSecurityStatus.QUARANTINED), false);
  assert.equal(canStaffReviewDownload(DocumentSecurityStatus.QUARANTINED, 'ADMIN'), false);
  assert.equal(canStaffReviewDownload(DocumentSecurityStatus.QUARANTINED, 'CLIENT_USER'), false);
  assert.equal(canStaffReviewDownload(DocumentSecurityStatus.REJECTED, 'ADMIN'), false);
  assert.equal(canNormalDownload(DocumentSecurityStatus.AVAILABLE), true);
});

test('H4: investigative download is narrowly role-gated', () => {
  assert.equal(canInvestigativeDownload(Role.ADMIN), true);
  assert.equal(canInvestigativeDownload(Role.CREDENTIALING_MANAGER), true);
  assert.equal(canInvestigativeDownload(Role.APPROVER), true);
  assert.equal(canInvestigativeDownload(Role.CREDENTIALING_SPECIALIST), false);
  assert.equal(canInvestigativeDownload(Role.CLIENT_USER), false);
  assert.equal(canInvestigativeDownload(Role.EXTERNAL_PROVIDER), false);
});

test('H3: manual release roles are restricted', () => {
  assert.equal(canManualRelease(Role.ADMIN), true);
  assert.equal(canManualRelease(Role.CREDENTIALING_MANAGER), true);
  assert.equal(canManualRelease(Role.APPROVER), true);
  assert.equal(canManualRelease(Role.CREDENTIALING_SPECIALIST), false);
  assert.equal(canManualRelease(Role.CLIENT_USER), false);
});

test('scanner is reported inactive unless configured', () => {
  const prev = process.env.MALWARE_SCANNER_ENABLED;
  delete process.env.MALWARE_SCANNER_ENABLED;
  delete process.env.MALWARE_SCANNER_URL;
  assert.equal(isMalwareScannerConfigured(), false);
  if (prev !== undefined) process.env.MALWARE_SCANNER_ENABLED = prev;
});
