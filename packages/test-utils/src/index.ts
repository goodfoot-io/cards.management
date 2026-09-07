/**
 * Shared test infrastructure for Cards packages including real Git repositories,
 * WebSocket servers, HTTP clients, stream transform harnesses, and
 * deterministic fixture factories. Helpers here interact with filesystems,
 * sockets, and timers, making them best suited to integration-style tests.
 *
 * @summary Provide reusable test harnesses and fixture factories for Cards integration tests
 */

// --- Fixture Factories ---
export {
  // Types
  type Comment,
  type CompleteCard,
  type CreateCompleteCardOptions,
  // Card factories
  createCard,
  createCardMetadata,
  // Comment factories
  createComment,
  // Composite builders
  createCompleteCard,
  // Multiple entity helpers
  createMultipleCards,
  createMultipleComments,
  createMultipleNotes,
  // Note factories
  createNote,
  type Note
} from './fixtures/index.js';
// --- Time Utilities ---
export { futureDate, now, pastDate } from './fixtures/time.js';
// --- Async Utilities ---
export { flushMicrotasks } from './flushMicrotasks.js';
// --- Git Test Utilities ---
export {
  type CreateCardOptions,
  TestCardRepository,
  type UpdateCardOptions
} from './git/TestCardRepository.js';
export { TestGitWorkspace } from './git/TestGitWorkspace.js';
// --- HTTP Test Utilities ---
export { type RecordedRequest, TestHttpClient } from './http/TestHttpClient.js';
// --- Negative Assertion Utilities ---
export {
  type ExpectNoEventsOptions,
  expectNoEventsRealTime,
  type SpyLike
} from './negativeAssertions.js';
// --- Store Test Utilities ---
export { createHybridStoreForTest } from './store/createHybridStoreForTest.js';
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
