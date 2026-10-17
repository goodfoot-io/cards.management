/**
 * Shared host bridge for session renderers: the controller-to-renderer
 * projection, Cards client and domain event adapters, and host layout
 * negotiation. Private hosts supply only authenticated clients, event
 * streams, timers, and their window/DOM channel.
 * @summary Session host bridge barrel export
 * @module stream-bridge
 */

export type { CardsStreamClient, CardsStreamReadOptions } from './cards.js';
export { createCardsSessionClient, sessionEventFromDomainEvent } from './cards.js';
export type {
  StreamBridgeDiagnostic,
  StreamHostAction,
  StreamHostBridge,
  StreamHostBridgeOptions,
  StreamHostSignal
} from './host.js';
export { createStreamHostBridge } from './host.js';
export type { LayoutHost, LayoutHostOptions, LayoutHostState, LayoutHostStatus, LayoutScheduler } from './layout.js';
export { createLayoutHost, LAYOUT_FIRST_MEASURE_MS, LAYOUT_OSCILLATION_LIMIT, LAYOUT_QUIET_MS } from './layout.js';
