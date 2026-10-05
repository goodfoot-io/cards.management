/**
 * Shared test support: a synthetic process-tree authority for provider
 * session tests, the real-repository slot fixture with its fake Cards client,
 * the `openSlotSession` stub providers are tested against, and the contract of
 * the child handler process the slot kill and shutdown tests spawn. The
 * handler script itself runs only as a child process, so only its types are
 * exported here.
 *
 * @summary Test helpers: process-tree authority, slot fixture, session stub and slot handler process
 * @module
 */

export { createSyntheticProcessTreeAuthority } from './process-tree-authority.js';
export * from './slot-fixture.js';
export type { SlotHandlerConfig, SlotHandlerEvent, SlotHandlerStop } from './slot-handler.js';
export * from './slot-session-stub.js';
