/**
 * Shared test infrastructure for Cards packages including real Git workspaces,
 * WebSocket servers, D1 doubles, and time and async helpers. It depends on no
 * workspace package; helpers that need the SDK or hybrid-store live in those packages'
 * `testing` entry points instead. Helpers here interact with filesystems, sockets, and
 * timers, making them best suited to integration-style tests.
 *
 * @summary Provide reusable, workspace-independent test harnesses for Cards integration tests
 */

// --- Time Utilities ---
export { futureDate, now, pastDate } from './fixtures/time.js';
// --- Async Utilities ---
export { flushMicrotasks } from './flushMicrotasks.js';
// --- Git Test Utilities ---
export { abortWithRejectionGuard } from './git/abortGuard.js';
export { TestGitWorkspace } from './git/TestGitWorkspace.js';
// --- Negative Assertion Utilities ---
export {
  type ExpectNoEventsOptions,
  expectNoEventsRealTime,
  type SpyLike
} from './negativeAssertions.js';
// --- D1 Test Utilities ---
export { TestD1Database, type TestD1DatabaseOptions } from './TestD1Database.js';
// --- Time Control Utilities ---
export { TestTimeController } from './testTimeController.js';
// --- WebSocket Test Utilities ---
export {
  getRandomPort,
  type StartOptions,
  TestWebSocketServer,
  type WsWebSocket
} from './ws/TestWebSocketServer.js';
