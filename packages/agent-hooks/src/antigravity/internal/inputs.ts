/**
 * Pinned input contract for the Antigravity `runtime` hook handlers.
 *
 * The Antigravity host (pinned `agy` CLI, see the card's
 * `notes/antigravity-host-contract.md` "Cards hook matrix") feeds every hook
 * one JSON document on stdin. The common host fields are pinned as
 * `conversationId`, non-empty `workspacePaths`, `transcriptPath`,
 * `artifactDirectoryPath`, and `modelName`; the invocation events
 * (`PreInvocation`, `PostInvocation`) additionally carry `invocationNum` and
 * `initialNumSteps`.
 *
 * Validation is fail-closed: any missing/mistyped/empty pinned field throws
 * {@link InputValidationError} naming the field. Unknown extra fields are
 * tolerated — the host may extend its payload without notice — but the pinned
 * fields are never guessed.
 *
 * The Cards session identity rides the environment, not the hook input: the
 * launcher generates it pre-spawn and exports `ANTIGRAVITY_SESSION_ID` into
 * the `agy` child, from which every hook subprocess inherits it.
 *
 * @summary Input parsing and validation for the Antigravity runtime handlers
 * @module internal/inputs
 */

import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { CARDS_ENV_VARS } from '@cards.management/sdk/config';

/** The Cards session-identity environment variable the launcher exports pre-spawn. */
export const ANTIGRAVITY_SESSION_ID_ENV = 'ANTIGRAVITY_SESSION_ID';

/**
 * Computes the canonical Antigravity conversation database path for a
 * conversation id.
 *
 * The Antigravity CLI stores interactive conversation databases at
 * `~/.gemini/antigravity-cli/conversations/<conversation-id>.db` (pinned host
 * contract). The SDK's `resolveTranscriptPath()` recovers the conversation DB
 * from the transcript path recorded at registration time, and the manifest's
 * conversation id is derived from the DB basename — so the registered path
 * MUST be this canonical form, computed from the `conversationId` input even
 * when the DB file does not exist yet (absence at attach is a designed-for
 * transient state; the poller waits for it).
 *
 * @param conversationId - Host conversation identifier from the hook input.
 * @param home - User home directory; defaults to the real one.
 * @returns The absolute canonical DB path
 *   `<home>/.gemini/antigravity-cli/conversations/<conversationId>.db`.
 */
export function canonicalConversationDbPath(conversationId: string, home: string = osHomedir()): string {
  return join(home, '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);
}

/**
 * The pinned common host fields every Antigravity `runtime` hook requires.
 *
 * @summary Common host input shared by all three runtime events
 */
export interface AntigravityCommonInput {
  /** Host-native conversation identifier the hook invocation belongs to. */
  conversationId: string;
  /** Workspace directories of the session; at least one must be present. */
  workspacePaths: string[];
  /** Absolute path of the session transcript the launcher materializes. */
  transcriptPath: string;
  /** Absolute path of the host's per-conversation artifact directory. */
  artifactDirectoryPath: string;
  /** Model name the host reports for the conversation. */
  modelName: string;
}

/**
 * The common host fields plus the invocation event fields.
 *
 * @summary Input for the PreInvocation and PostInvocation events
 */
export interface AntigravityInvocationInput extends AntigravityCommonInput {
  /** 0-based number of this invocation within the conversation (the host sends 0 on the first invocation). */
  invocationNum: number;
  /** Number of steps the invocation started with. */
  initialNumSteps: number;
}

/**
 * Thrown by the input parsers when a pinned field is missing, mistyped, or
 * empty. Fail-closed by contract: the handler turns this into a failure
 * marker, never a guessed continuation.
 *
 * @summary Input contract violation
 */
export class InputValidationError extends Error {
  override readonly name = 'InputValidationError';

  constructor(
    /** The pinned field that failed validation. */
    public readonly field: string,
    reason: string
  ) {
    super(`Antigravity hook input field "${field}" ${reason}`);
  }
}

/** Exact opt-in value exported only by the Cards Assistant launcher. */
export const CARDS_ASSISTANT_SESSION_ENV_VAR = 'CARDS_ASSISTANT_SESSION';

/** Stable VS Code window/session identity exported with an Assistant launch. */
export const CARDS_ASSISTANT_WINDOW_ID_ENV_VAR = 'CARDS_ASSISTANT_WINDOW_ID';

/** Exhaustive ownership classification for an Antigravity hook process. */
export type CardsManagedSessionKind = 'foreign' | 'card-action' | 'cards-assistant';

/**
 * Classifies whether the host process belongs to Cards and which lifecycle
 * owns it. Assistant ownership is explicit and never inferred from the
 * presence of `ANTIGRAVITY_SESSION_ID`; a foreign user may set that variable.
 *
 * @param env - Environment inherited by the hook subprocess.
 * @returns Foreign, card-action, or workspace/window Assistant ownership.
 */
export function classifyCardsManagedSession(env: NodeJS.ProcessEnv = process.env): CardsManagedSessionKind {
  if (env[CARDS_ENV_VARS.CARD_ID]) {
    return 'card-action';
  }
  return env[CARDS_ASSISTANT_SESSION_ENV_VAR] === '1' ? 'cards-assistant' : 'foreign';
}

/**
 * Reports whether the current process runs inside a Cards action.
 *
 * The launcher exports the action envelope (including `CARD_ID`) before
 * spawning `agy`; plain terminal sessions never carry it. Outside that
 * context the runtime hooks are meaningless, so they stay inert.
 *
 * @returns `true` when `CARD_ID` is present in the process environment.
 */
export function isCardsActionSession(): boolean {
  return classifyCardsManagedSession() === 'card-action';
}

/**
 * Resolves the Cards session identity the launcher exported pre-spawn.
 *
 * @returns The trimmed session id, or `null` when the variable is absent or
 *   blank. Callers fail closed with a `session-identity` failure in that case.
 */
export function resolveCardsSessionId(): string | null {
  const value = (process.env[ANTIGRAVITY_SESSION_ID_ENV] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Extracts the conversation id from a raw input, best-effort, so failure
 * markers stay conversation-scoped even when the remaining fields failed
 * validation.
 *
 * @param raw - The raw stdin JSON value.
 * @returns The conversation id when the input carries a non-empty string.
 */
export function peekConversationId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const value = (raw as Record<string, unknown>)['conversationId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Validates one required non-empty string field.
 *
 * @param raw - The parsed hook input document.
 * @param field - Field name to read.
 * @returns The field's string value.
 * @throws {InputValidationError} When the field is absent or not a non-empty string.
 */
function requireNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputValidationError(field, 'must be a non-empty string');
  }
  return value;
}

/**
 * Validates one required integer field.
 *
 * @param raw - The parsed hook input document.
 * @param field - Field name to read.
 * @param minimum - Inclusive minimum the integer must meet.
 * @returns The field's integer value.
 * @throws {InputValidationError} When the field is absent or not an integer ≥ `minimum`.
 */
function requireInteger(raw: Record<string, unknown>, field: string, minimum: number): number {
  const value = raw[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new InputValidationError(field, `must be an integer ≥ ${minimum}`);
  }
  return value;
}

/**
 * Parses and validates the pinned common host fields.
 *
 * @param raw - The JSON value the host fed to the hook's stdin.
 * @returns The validated common input.
 * @throws {InputValidationError} When the document is not an object or any
 *   pinned common field fails validation.
 */
export function parseCommonInput(raw: unknown): AntigravityCommonInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError('input', 'must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  const workspacePathsRaw = record['workspacePaths'];
  if (
    !Array.isArray(workspacePathsRaw) ||
    workspacePathsRaw.length === 0 ||
    workspacePathsRaw.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new InputValidationError('workspacePaths', 'must be a non-empty array of non-empty strings');
  }

  return {
    conversationId: requireNonEmptyString(record, 'conversationId'),
    workspacePaths: workspacePathsRaw as string[],
    transcriptPath: requireNonEmptyString(record, 'transcriptPath'),
    artifactDirectoryPath: requireNonEmptyString(record, 'artifactDirectoryPath'),
    modelName: requireNonEmptyString(record, 'modelName')
  };
}

/**
 * Parses and validates the common host fields plus the invocation fields.
 *
 * @param raw - The JSON value the host fed to the hook's stdin.
 * @returns The validated invocation input.
 * @throws {InputValidationError} When any pinned field fails validation.
 */
export function parseInvocationInput(raw: unknown): AntigravityInvocationInput {
  const common = parseCommonInput(raw);
  const record = raw as Record<string, unknown>;
  return {
    ...common,
    // The host's first invocation carries invocationNum 0 (pinned v1.1.22,
    // disposable-host smoke witness) — negative values stay invalid.
    invocationNum: requireInteger(record, 'invocationNum', 0),
    initialNumSteps: requireInteger(record, 'initialNumSteps', 0)
  };
}
