/**
 * Test fixtures and harnesses that need the SDK's own protocol, layout and scaffold
 * modules: domain entity factories, a real on-disk card repository, and a recording
 * HTTP client. They live in the SDK rather than the shared test-utils package so
 * test-utils depends on no workspace package, keeping the workspace dependency graph
 * acyclic.
 *
 * @summary SDK-aware test fixtures, card repository harness, and recording HTTP client
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
} from './entities.js';
// --- Git Test Utilities ---
export {
  type CreateCardOptions,
  TestCardRepository,
  type UpdateCardOptions
} from './TestCardRepository.js';
// --- HTTP Test Utilities ---
export { type RecordedRequest, TestHttpClient } from './TestHttpClient.js';
