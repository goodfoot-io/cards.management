/**
 * Domain entity factories for test fixtures.
 *
 * Why: create valid domain objects with minimal ceremony while keeping tests
 * explicit about the values they care about.
 *
 * Behavior:
 * - Generates IDs with `randomUUID()` unless overridden.
 * - Uses `now()` for timestamps unless overridden.
 * - Applies partial overrides per factory call.
 *
 * Constraint: these factories do not validate domain rules; they are meant
 * for test setup, not production enforcement.
 *
 * Note: Row factories (CardRow, RepositoryIdentityRow, etc.) remain in hybrid-store
 * due to their dependency on local row types.
 *
 *
 * @summary Domain entity factories for test fixtures
 * @module sdk/testing/entities
 */
import { randomUUID } from 'node:crypto';
import { now } from '@cards.management/test-utils';
import type { Card, CardMetadata } from '../protocol/index.js';
import { DEFAULT_CARD_GATES } from '../protocol/index.js';

// --- Card Factories ---

/**
 * Creates a CardMetadata with sensible defaults.
 *
 * Behavior: uses `DEFAULT_CARD_GATES` when no gates are provided.
 *
 * Constraint: when `overrides.gates` is set, it replaces the defaults rather
 * than merging, so provide a full gate set if you override it.
 *
 * @param overrides Partial fields to override
 * @returns A complete CardMetadata
 */
export function createCardMetadata(overrides: Partial<CardMetadata> = {}): CardMetadata {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    title: overrides.title ?? `Test Card ${id.slice(0, 8)}`,
    status: overrides.status ?? 'todo',
    tags: overrides.tags ?? [],
    gates: overrides.gates ?? { ...DEFAULT_CARD_GATES },
    isPinned: overrides.isPinned ?? false,
    order: overrides.order ?? 0,
    repositoryId: overrides.repositoryId ?? 'main',
    environment: overrides.environment ?? 'default',
    parentBranch: overrides.parentBranch ?? 'main'
  };
}

/**
 * Creates a Card with sensible defaults.
 *
 * Behavior: builds metadata via `createCardMetadata` and adds timestamps,
 * description, and optional runtime properties.
 *
 * @param overrides Partial fields to override
 * @returns A complete Card
 */
export function createCard(overrides: Partial<Card> = {}): Card {
  const metadata = createCardMetadata(overrides);
  const timestamp = now();
  return {
    ...metadata,
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    isMerged: overrides.isMerged ?? null,
    hasPlanDrift: overrides.hasPlanDrift ?? true,
    hasUnread: overrides.hasUnread ?? false,
    repositoryPath: overrides.repositoryPath ?? `/tmp/cards/${metadata.id}`
  };
}

// --- Comment Factory ---

/**
 * Comment interface for test fixtures.
 *
 * Constraint: this is intentionally smaller than the production comment shape
 * to keep tests lightweight.
 */
export interface Comment {
  id: string;
  content: string;
  createdAt: string;
}

/**
 * Creates a Comment with sensible defaults.
 *
 * Behavior: generates a new ID and `createdAt` timestamp unless overridden.
 *
 * @param overrides Partial fields to override
 * @returns A complete Comment
 */
export function createComment(overrides: Partial<Comment> = {}): Comment {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    content: overrides.content ?? 'Test comment content',
    createdAt: overrides.createdAt ?? now()
  };
}

// --- Note Factory ---

/**
 * Note interface for test fixtures.
 *
 * Constraint: simplified fields make it easy to set up note-related tests
 * without bringing in the full domain type.
 */
export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

/**
 * Creates a Note with sensible defaults.
 *
 * Behavior: generates a new ID and `createdAt` timestamp unless overridden.
 *
 * @param overrides Partial fields to override
 * @returns A complete Note
 */
export function createNote(overrides: Partial<Note> = {}): Note {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    title: overrides.title ?? `Test Note ${id.slice(0, 8)}`,
    content: overrides.content ?? 'Test note content',
    createdAt: overrides.createdAt ?? now()
  };
}

// --- Composite Builders ---

/**
 * Options for creating a complete card with related entities.
 *
 * Behavior: each array entry is passed through its respective factory, so
 * partial overrides become fully populated entities.
 */
export interface CreateCompleteCardOptions {
  card?: Partial<Card>;
  comments?: Array<Partial<Comment>>;
}

/**
 * Result of creating a complete card.
 *
 * Behavior: all related arrays are always defined (never `undefined`).
 */
export interface CompleteCard {
  card: Card;
  comments: Comment[];
}

/**
 * Creates a complete card with optional adaptive cards and comments.
 *
 * Why: bundle related entities for tests that need a cohesive card graph.
 *
 * Behavior: missing arrays default to empty arrays; each entry is normalized
 * through the corresponding factory for consistent defaults.
 *
 * @example
 * ```typescript
 * const bundle = createCompleteCard({
 *   card: { title: 'Pinned card', isPinned: true },
 *   comments: [{ content: 'First comment' }]
 * });
 * ```
 *
 * @param options Options for creating the complete card
 * @returns A complete card with related entities
 */
export function createCompleteCard(options: CreateCompleteCardOptions = {}): CompleteCard {
  const card = createCard(options.card);
  const comments = (options.comments ?? []).map((c) => createComment(c));

  return { card, comments };
}

// --- Multiple Entity Helpers ---

/**
 * Creates multiple cards with sensible defaults.
 *
 * Behavior: each card is created independently, so IDs and timestamps are
 * unique per entry.
 *
 * @example
 * ```typescript
 * const cards = createMultipleCards(3, { status: 'done' });
 * ```
 *
 * @param count Number of cards to create
 * @param overrides Partial fields to apply to all cards
 * @returns Array of cards
 */
export function createMultipleCards(count: number, overrides: Partial<Card> = {}): Card[] {
  return Array.from({ length: count }, () => createCard(overrides));
}

/**
 * Creates multiple comments with sensible defaults.
 *
 * Behavior: each comment is created independently, so IDs are unique.
 *
 * @param count Number of comments to create
 * @param overrides Partial fields to apply to all comments
 * @returns Array of comments
 */
export function createMultipleComments(count: number, overrides: Partial<Comment> = {}): Comment[] {
  return Array.from({ length: count }, () => createComment(overrides));
}

/**
 * Creates multiple notes with sensible defaults.
 *
 * Behavior: each note is created independently, so IDs are unique.
 *
 * @param count Number of notes to create
 * @param overrides Partial fields to apply to all notes
 * @returns Array of notes
 */
export function createMultipleNotes(count: number, overrides: Partial<Note> = {}): Note[] {
  return Array.from({ length: count }, () => createNote(overrides));
}
