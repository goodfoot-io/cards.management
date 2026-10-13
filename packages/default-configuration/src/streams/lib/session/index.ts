/**
 * Native transcript projection, Cards-owned content, and expanded viewport contracts.
 * Providers retain parsing and semantic reconciliation; callers retain source membership,
 * host subscriptions, and authoritative generation ownership.
 * @summary Reusable native session rendering foundation
 * @module streams/lib/session
 */
export * from './announcements';
export * from './projection';
export * from './SessionContent';
export * from './SessionViewport';
export * from './types';
export * from './use-transcript-source';
