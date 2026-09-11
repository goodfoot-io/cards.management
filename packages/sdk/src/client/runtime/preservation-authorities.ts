/**
 * Fail-closed orphan authorities for live runtime clients.
 * @summary Preserves unrelated outbox evidence for server-startup recovery
 * @module
 */

import type { ReconciliationAuthorities } from './outbox/index.js';

const DETAIL = 'preserved for server-startup recovery; live runtime client has no orphan authority';

/** Authorities that refuse custody and validation so unrelated records remain byte-for-byte intact. */
export const PRESERVE_FOR_SERVER_STARTUP_AUTHORITIES: ReconciliationAuthorities = {
  resultCustodian: { takeCustody: async () => ({ kind: 'authority-unavailable', detail: DETAIL }) },
  launchIntentValidator: {
    validateRecoveredObligation: async () => ({ kind: 'authority-unavailable', detail: DETAIL })
  }
};
