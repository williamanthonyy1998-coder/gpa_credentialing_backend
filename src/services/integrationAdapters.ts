/**
 * Phase 4D — integration adapter interface.
 *
 * Rules:
 * - Do not invent successful CAQH/PECOS/Availity API responses.
 * - Unsupported ops return structured NOT_SUPPORTED.
 * - Manual adapter never claims an external API call occurred.
 * - Test adapters may mock only inside automated tests (INTEGRATION_TEST_MOCK=1).
 */

import {
  ExternalConnectionMode,
  ExternalIntegrationStatus,
  ExternalIntegrationType
} from '@prisma/client';
import { resolveSecret } from '../lib/secretStore';

export type CapabilityStatus =
  | 'AVAILABLE'
  | 'NOT_AVAILABLE'
  | 'REQUIRES_APPROVAL'
  | 'NOT_VERIFIED'
  | 'MANUAL_ONLY';

export type CapabilityName =
  | 'PROVIDER_LOOKUP'
  | 'PROFILE_READ'
  | 'PROFILE_UPDATE'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DOWNLOAD'
  | 'ATTESTATION'
  | 'APPLICATION_STATUS'
  | 'SUBMISSION'
  | 'STATUS_SYNC'
  | 'REVALIDATION_STATUS';

export type CapabilityMap = Record<
  string,
  { status: CapabilityStatus; source?: string | null; notes?: string | null }
>;

export type AdapterResult<T = unknown> = {
  ok: boolean;
  code?: string;
  summary: string;
  data?: T;
  externalReference?: string | null;
};

export type ConnectionTestResult = AdapterResult<{
  wouldSetStatus: ExternalIntegrationStatus;
  connectionMode: ExternalConnectionMode;
}>;

export interface IntegrationAdapterContext {
  integrationId: string;
  integrationType: ExternalIntegrationType;
  tenantId: string | null;
  credentialSecretRef: string | null;
  capabilities: CapabilityMap;
  connectionMode: ExternalConnectionMode;
  status: ExternalIntegrationStatus;
}

export interface IntegrationAdapter {
  type: ExternalIntegrationType;
  getCapabilities(ctx: IntegrationAdapterContext): CapabilityMap;
  testConnection(ctx: IntegrationAdapterContext): Promise<ConnectionTestResult>;
  getProviderProfile?(ctx: IntegrationAdapterContext, input: { providerExternalId?: string }): Promise<AdapterResult>;
  getApplicationStatus?(ctx: IntegrationAdapterContext, input: { externalReference?: string }): Promise<AdapterResult>;
  submitApplication?(ctx: IntegrationAdapterContext, input: { idempotencyKey?: string }): Promise<AdapterResult>;
  uploadDocument?(ctx: IntegrationAdapterContext, input: { documentId?: string }): Promise<AdapterResult>;
}

function notSupported(op: string): AdapterResult {
  return {
    ok: false,
    code: 'NOT_SUPPORTED',
    summary: `${op} is not supported by this adapter in the current Phase 4D foundation`
  };
}

/** Manual portal / staff-recorded workflow — never reports API CONNECTED. */
export const manualPortalAdapter: IntegrationAdapter = {
  type: ExternalIntegrationType.OTHER,
  getCapabilities(ctx) {
    return {
      ...ctx.capabilities,
      SUBMISSION: { status: 'MANUAL_ONLY', source: 'platform', notes: 'Record manual portal actions via Phase 4C' },
      APPLICATION_STATUS: { status: 'MANUAL_ONLY', source: 'platform', notes: 'Staff records payer responses' },
      STATUS_SYNC: { status: 'NOT_AVAILABLE', source: 'platform' }
    };
  },
  async testConnection(ctx) {
    return {
      ok: true,
      code: 'MANUAL_WORKFLOW_AVAILABLE',
      summary: 'Manual portal workflow is available. This is not an API connection.',
      data: {
        wouldSetStatus: ExternalIntegrationStatus.MANUAL_ONLY,
        connectionMode: ctx.connectionMode === ExternalConnectionMode.NOT_AVAILABLE
          ? ExternalConnectionMode.MANUAL_PORTAL
          : ctx.connectionMode
      }
    };
  },
  async submitApplication() {
    return {
      ok: false,
      code: 'REQUIRES_MANUAL_ACTION',
      summary: 'Use the manual workflow to record an actual external portal submission (Phase 4C confirm rules apply).'
    };
  }
};

/**
 * CAQH adapter foundation.
 * Official PO APIs exist for Participating Organizations (roster/status/credentialing) after CAQH approval.
 * This organization has NOT completed authorized live API access in this phase — do not claim CONNECTED.
 */
export const caqhAdapter: IntegrationAdapter = {
  type: ExternalIntegrationType.CAQH,
  getCapabilities() {
    return {
      PROVIDER_LOOKUP: {
        status: 'REQUIRES_APPROVAL',
        source: 'https://www.caqh.org/hubfs/43908627/drupal/solutions/proview/proview-directassure-roster-statuscheck-api-specifications.pdf',
        notes: 'ProView Status Check / Roster APIs require Participating Organization authorization from CAQH Support'
      },
      PROFILE_READ: {
        status: 'REQUIRES_APPROVAL',
        source: 'CAQH Credentialing API (PO) — MuleSoft CAQH Connector docs',
        notes: 'Requires provider authorization of the PO and Complete application status'
      },
      PROFILE_UPDATE: { status: 'NOT_VERIFIED', source: null, notes: 'Not verified for this deployment' },
      DOCUMENT_UPLOAD: { status: 'NOT_VERIFIED', source: null },
      DOCUMENT_DOWNLOAD: { status: 'REQUIRES_APPROVAL', source: 'CAQH Get Provider Documents (partner docs)' },
      ATTESTATION: { status: 'MANUAL_ONLY', source: 'CAQH Provider Data Portal (manual)' },
      APPLICATION_STATUS: { status: 'REQUIRES_APPROVAL', source: 'ProView Status Check API' },
      SUBMISSION: { status: 'NOT_AVAILABLE', source: null, notes: 'Platform does not submit provider apps to CAQH without verified PO API access' },
      STATUS_SYNC: { status: 'REQUIRES_APPROVAL', source: 'ProView Status Check API' },
      REVALIDATION_STATUS: { status: 'NOT_VERIFIED', source: null }
    };
  },
  async testConnection(ctx) {
    const secret = await resolveSecret(ctx.credentialSecretRef, { expectedTenantId: ctx.tenantId });
    if (!secret) {
      return {
        ok: false,
        code: 'PENDING_CREDENTIALS',
        summary: 'CAQH credentials are not configured (secret reference missing or unresolved). No live API call was made.',
        data: {
          wouldSetStatus: ExternalIntegrationStatus.PENDING_CREDENTIALS,
          connectionMode: ExternalConnectionMode.OFFICIAL_API
        }
      };
    }
    if (
      process.env.NODE_ENV !== 'production'
      && process.env.INTEGRATION_TEST_MOCK === '1'
      && process.env.CAQH_ALLOW_MOCK_CONNECT === '1'
    ) {
      return {
        ok: true,
        code: 'MOCK_ONLY',
        summary: 'Mock connection success for isolated automated tests only — not a production CAQH verification. Never sets CONNECTED.',
        data: {
          // C3: mock must never persist real CONNECTED
          wouldSetStatus: ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED,
          connectionMode: ExternalConnectionMode.OFFICIAL_API
        }
      };
    }
    return {
      ok: false,
      code: 'NOT_VERIFIED',
      summary:
        'CAQH official API access requires Participating Organization approval. Credentials may be referenced, but live connection testing against CAQH has not been authorized for this deployment. No fake success was recorded.',
      data: {
        wouldSetStatus: ExternalIntegrationStatus.PENDING_APPROVAL,
        connectionMode: ExternalConnectionMode.OFFICIAL_API
      }
    };
  },
  async getProviderProfile() {
    return notSupported('getProviderProfile');
  },
  async getApplicationStatus() {
    return notSupported('getApplicationStatus');
  },
  async submitApplication() {
    return notSupported('submitApplication');
  },
  async uploadDocument() {
    return notSupported('uploadDocument');
  }
};

/**
 * PECOS adapter foundation.
 * CMS PECOS is primarily a portal enrollment system. No verified public machine-to-machine enrollment API
 * is available to this organization. Public PPEF files are not the same as PECOS write/submit APIs.
 */
export const pecosAdapter: IntegrationAdapter = {
  type: ExternalIntegrationType.PECOS,
  getCapabilities() {
    return {
      PROVIDER_LOOKUP: {
        status: 'MANUAL_ONLY',
        source: 'https://data.cms.gov — Public Provider Enrollment Files (PPEF) derived from PECOS',
        notes: 'Public files ≠ PECOS portal API. Manual portal / file import may apply.'
      },
      PROFILE_READ: { status: 'MANUAL_ONLY', source: 'PECOS web portal (manual)' },
      PROFILE_UPDATE: { status: 'MANUAL_ONLY', source: 'PECOS web portal (manual)' },
      APPLICATION_STATUS: { status: 'MANUAL_ONLY', source: 'PECOS web portal (manual)' },
      SUBMISSION: { status: 'MANUAL_ONLY', source: 'PECOS web portal (manual)' },
      STATUS_SYNC: { status: 'NOT_AVAILABLE', source: null, notes: 'No verified public PECOS sync API for this deployment' },
      REVALIDATION_STATUS: { status: 'MANUAL_ONLY', source: 'PECOS / CMS revalidation lists (manual)' },
      DOCUMENT_UPLOAD: { status: 'MANUAL_ONLY', source: 'PECOS portal' },
      DOCUMENT_DOWNLOAD: { status: 'NOT_AVAILABLE', source: null },
      ATTESTATION: { status: 'NOT_VERIFIED', source: null }
    };
  },
  async testConnection(ctx) {
    return {
      ok: true,
      code: 'MANUAL_ONLY',
      summary:
        'PECOS machine-to-machine enrollment API is NOT_VERIFIED for this organization. Manual PECOS portal workflow is available. This does not set API CONNECTED.',
      data: {
        wouldSetStatus: ExternalIntegrationStatus.MANUAL_ONLY,
        connectionMode: ExternalConnectionMode.MANUAL_PORTAL
      }
    };
  },
  async submitApplication() {
    return {
      ok: false,
      code: 'REQUIRES_MANUAL_ACTION',
      summary: 'Record PECOS portal actions via the manual workflow. No automated PECOS submission is implemented.'
    };
  }
};

/**
 * Availity adapter foundation.
 * Availity exposes OAuth2 partner APIs (eligibility, claims, payer list, etc.) after contracting.
 * Credentialing/enrollment submission via Availity is NOT assumed — many flows remain portal/manual.
 */
export const availityAdapter: IntegrationAdapter = {
  type: ExternalIntegrationType.AVAILITY,
  getCapabilities() {
    return {
      PROVIDER_LOOKUP: { status: 'NOT_VERIFIED', source: 'https://developer.availity.com/' },
      APPLICATION_STATUS: {
        status: 'NOT_VERIFIED',
        source: 'https://developer.availity.com/',
        notes: 'HIPAA transaction APIs exist; payer enrollment credentialing is NOT assumed available'
      },
      SUBMISSION: {
        status: 'REQUIRES_APPROVAL',
        source: 'https://developer.availity.com/partner/gettingstarted',
        notes: 'Requires Availity contracting + product subscription; not configured for this deployment'
      },
      STATUS_SYNC: { status: 'NOT_VERIFIED', source: null },
      PROFILE_READ: { status: 'NOT_VERIFIED', source: null },
      PROFILE_UPDATE: { status: 'NOT_AVAILABLE', source: null },
      DOCUMENT_UPLOAD: { status: 'NOT_VERIFIED', source: null },
      DOCUMENT_DOWNLOAD: { status: 'NOT_AVAILABLE', source: null },
      ATTESTATION: { status: 'NOT_AVAILABLE', source: null },
      REVALIDATION_STATUS: { status: 'NOT_AVAILABLE', source: null }
    };
  },
  async testConnection(ctx) {
    const secret = await resolveSecret(ctx.credentialSecretRef, { expectedTenantId: ctx.tenantId });
    if (!secret) {
      return {
        ok: false,
        code: 'PENDING_CREDENTIALS',
        summary: 'Availity credentials are not configured. No OAuth token request was made.',
        data: {
          wouldSetStatus: ExternalIntegrationStatus.PENDING_CREDENTIALS,
          connectionMode: ExternalConnectionMode.OFFICIAL_API
        }
      };
    }
    return {
      ok: false,
      code: 'PENDING_APPROVAL',
      summary:
        'Availity partner APIs require developer portal registration, product subscription, and contracting. Live connection test is not authorized for this deployment. No fake success recorded.',
      data: {
        wouldSetStatus: ExternalIntegrationStatus.PENDING_APPROVAL,
        connectionMode: ExternalConnectionMode.OFFICIAL_API
      }
    };
  },
  async submitApplication() {
    return notSupported('submitApplication');
  }
};

export function adapterForType(type: ExternalIntegrationType): IntegrationAdapter {
  switch (type) {
    case ExternalIntegrationType.CAQH:
      return caqhAdapter;
    case ExternalIntegrationType.PECOS:
      return pecosAdapter;
    case ExternalIntegrationType.AVAILITY:
      return availityAdapter;
    case ExternalIntegrationType.PAYER_PORTAL:
    case ExternalIntegrationType.OTHER:
    default:
      return manualPortalAdapter;
  }
}
