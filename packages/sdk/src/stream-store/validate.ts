/**
 * Exact-shape validators for the session bridge in both directions.
 *
 * Both sides validate every inbound message before acting: unknown fields,
 * malformed source identities, non-integer or out-of-range coordinates,
 * oversized batches, and unknown enum values are rejected with an
 * identifier-only reason. Validation proves shape only; generation, session
 * membership, and source authority are checked by the consumer.
 *
 * @summary Session bridge message validators
 * @module stream-store/validate
 */

import type { HostToRendererMessage, MessageValidation, RendererToHostMessage, StreamViewState } from './types.js';
import {
  MAX_APPEND_LINES,
  MAX_LAYOUT_HEIGHT,
  MAX_SCROLL_DELTA,
  MAX_TOKEN_LENGTH,
  MAX_VIEW_STATE_ENTRIES,
  MAX_VIEW_STATE_KEY_LENGTH
} from './types.js';

/** Thrown internally with an identifier-only reason; never escapes a validator. */
class Rejection extends Error {}

/** Unvalidated object record with known required and optional keys. */
type Fields<R extends string, O extends string = never> = Record<R, unknown> & Partial<Record<O, unknown>>;

const ROLES = ['main', 'subagent', 'auxiliary'];
const LOAD_ERRORS = [
  'not-found',
  'load-error',
  'membership-error',
  'inconsistent-source',
  'resync-overflow',
  'rejected-scope'
];
const INVALIDATION_REASONS = ['replaced', 'removed', 'binding-changed', 'server-restarted'];
const SCROLL_KEYS = ['line-up', 'line-down', 'page-up', 'page-down', 'start', 'end'];
const META_REQUIRED = [
  'version',
  'relPath',
  'streamType',
  'runtime',
  'sessionId',
  'role',
  'sourcePath',
  'startedAt',
  'lineCount',
  'createdAt',
  'isActive'
] as const;
const META_OPTIONAL = ['agentId', 'title', 'taskContent', 'slug'] as const;

/**
 * Rejects with an identifier-only reason.
 * @param reason - Kebab-case rejection code.
 * @throws Rejection always.
 */
function reject(reason: string): never {
  throw new Rejection(reason);
}

/**
 * Requires a plain object with exactly the required keys plus optional keys.
 * @param value - Candidate.
 * @param required - Keys that must be present.
 * @param optional - Keys that may be present.
 * @param reason - Rejection code.
 * @returns The value as a record.
 * @throws Rejection on any shape mismatch.
 */
function exact<R extends string, O extends string = never>(
  value: unknown,
  required: readonly R[],
  optional: readonly O[],
  reason: string
): Fields<R, O> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(reason);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(reason);
  const record = value as Record<string, unknown>;
  const allowed: readonly string[] = [...required, ...optional];
  for (const name of required) if (!(name in record) || record[name] === undefined) reject(reason);
  for (const name of Object.keys(record)) if (!allowed.includes(name)) reject(reason);
  return record as Fields<R, O>;
}

/**
 * Validates a bounded printable identifier.
 * @param value - Candidate.
 * @param reason - Rejection code.
 * @param max - Maximum length.
 * @throws Rejection when invalid.
 */
function identifier(value: unknown, reason: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) reject(reason);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) reject(reason);
  }
}

/**
 * Validates a correlation token (generation, request ID, layout token).
 * @param value - Candidate.
 * @param reason - Rejection code.
 * @throws Rejection when invalid.
 */
function token(value: unknown, reason: string): asserts value is string {
  identifier(value, reason, MAX_TOKEN_LENGTH);
}

/**
 * Validates a card/provider path component.
 * @param value - Candidate.
 * @throws Rejection when invalid.
 */
function component(value: unknown): void {
  identifier(value, 'invalid-source');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) reject('invalid-source');
}

/** Validated source reference fields. */
type SourceFields = Fields<'cardId' | 'streamType' | 'relPath'>;

/**
 * Validates an exact source reference.
 * @param value - Candidate.
 * @returns Validated record.
 * @throws Rejection when invalid.
 */
function source(value: unknown): SourceFields {
  const record = exact(value, ['cardId', 'streamType', 'relPath'], [], 'invalid-source');
  component(record.cardId);
  component(record.streamType);
  identifier(record.relPath, 'invalid-source');
  if (record.relPath.includes('\\') || record.relPath.split('/').some((part) => ['', '.', '..'].includes(part)))
    reject('invalid-source');
  return record;
}

/**
 * Validates a binding.
 * @param value - Candidate.
 * @returns Validated record.
 * @throws Rejection when invalid.
 */
function binding(value: unknown): Fields<'sessionId' | 'role', 'agentId'> {
  const record = exact(value, ['sessionId', 'role'], ['agentId'], 'invalid-binding');
  identifier(record.sessionId, 'invalid-binding');
  if (!ROLES.includes(record.role as string)) reject('invalid-binding');
  if ('agentId' in record) identifier(record.agentId, 'invalid-binding');
  return record;
}

/**
 * Validates the stamped source, version, and binding of a content message.
 * @param record - Message record.
 * @throws Rejection when invalid.
 */
function authority(record: Fields<'source' | 'version' | 'binding'>): void {
  source(record.source);
  const version = exact(record.version, ['serverEpoch', 'sourceEpoch'], [], 'invalid-version');
  identifier(version.serverEpoch, 'invalid-version');
  identifier(version.sourceEpoch, 'invalid-version');
  binding(record.binding);
}

/**
 * Validates a positive safe integer.
 * @param value - Candidate.
 * @param reason - Rejection code.
 * @throws Rejection when invalid.
 */
function positive(value: unknown, reason: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) reject(reason);
}

/**
 * Validates a nonnegative safe integer.
 * @param value - Candidate.
 * @param reason - Rejection code.
 * @throws Rejection when invalid.
 */
function nonnegative(value: unknown, reason: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject(reason);
}

/**
 * Validates native lines without newline delimiters.
 * @param value - Candidate.
 * @returns Validated array.
 * @throws Rejection when invalid.
 */
function lines(value: unknown): unknown[] {
  if (!Array.isArray(value)) reject('invalid-lines');
  for (const line of value) if (typeof line !== 'string' || line.includes('\n')) reject('invalid-lines');
  return value;
}

/**
 * Validates an exact session descriptor scoped to its own session tuple.
 * @param value - Candidate.
 * @throws Rejection when invalid.
 */
function sessionDescriptor(value: unknown): void {
  const record = exact(value, ['session', 'members', 'main', 'validity'], [], 'invalid-descriptor');
  const session = exact(record.session, ['cardId', 'streamType', 'sessionId'], [], 'invalid-descriptor');
  component(session.cardId);
  component(session.streamType);
  identifier(session.sessionId, 'invalid-descriptor');
  if (!Array.isArray(record.members)) reject('invalid-descriptor');
  const keys = new Set<string>();
  const mains: SourceFields[] = [];
  for (const entry of record.members) {
    const member = exact(entry, ['source', 'role'], ['agentId', 'title'], 'invalid-descriptor');
    const ref = source(member.source);
    if (ref.cardId !== session.cardId || ref.streamType !== session.streamType) reject('invalid-descriptor');
    if (!ROLES.includes(member.role as string)) reject('invalid-descriptor');
    if ('agentId' in member) identifier(member.agentId, 'invalid-descriptor');
    if ('title' in member && typeof member.title !== 'string') reject('invalid-descriptor');
    const key = JSON.stringify([ref.cardId, ref.streamType, ref.relPath]);
    if (keys.has(key)) reject('invalid-descriptor');
    keys.add(key);
    if (member.role === 'main') mains.push(ref);
  }
  const expected = mains.length === 1 ? 'ready' : mains.length === 0 ? 'missing-main' : 'conflicting-main';
  if (record.validity !== expected) reject('invalid-descriptor');
  const only = mains[0];
  if (expected === 'ready' && only) {
    const ref = source(record.main);
    if (ref.relPath !== only.relPath || ref.cardId !== only.cardId || ref.streamType !== only.streamType)
      reject('invalid-descriptor');
  } else if (record.main !== null) reject('invalid-descriptor');
}

/**
 * Validates snapshot metadata against its stamped source, binding, and count.
 * @param record - Snapshot fields already checked for shape and coordinates.
 * @throws Rejection when invalid.
 */
function snapshotMeta(record: Fields<'source' | 'binding' | 'meta' | 'totalLineCount'>): void {
  const meta = exact(record.meta, META_REQUIRED, META_OPTIONAL, 'invalid-meta');
  const ref = record.source as SourceFields;
  const bound = record.binding as Fields<'sessionId' | 'role', 'agentId'>;
  if (
    meta.version !== 1 ||
    meta.relPath !== ref.relPath ||
    meta.streamType !== ref.streamType ||
    meta.sessionId !== bound.sessionId ||
    meta.role !== bound.role ||
    meta.agentId !== bound.agentId ||
    meta.lineCount !== record.totalLineCount ||
    typeof meta.runtime !== 'string' ||
    typeof meta.sourcePath !== 'string' ||
    typeof meta.startedAt !== 'string' ||
    typeof meta.createdAt !== 'string' ||
    typeof meta.isActive !== 'boolean' ||
    ('title' in meta && typeof meta.title !== 'string') ||
    ('taskContent' in meta && typeof meta.taskContent !== 'string') ||
    ('slug' in meta && typeof meta.slug !== 'string')
  )
    reject('invalid-meta');
}

/**
 * Validates one host message, throwing a rejection on failure.
 * @param value - Candidate.
 * @throws Rejection when invalid.
 */
function host(value: unknown): void {
  const type = exact(value, ['type'], Object.keys(value ?? {}), 'invalid-message').type;
  switch (type) {
    case 'session:update': {
      const record = exact(value, ['type', 'generation', 'revision', 'descriptor'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      positive(record.revision, 'invalid-revision');
      sessionDescriptor(record.descriptor);
      return;
    }
    case 'source:snapshot': {
      const record = exact(
        value,
        [
          'type',
          'generation',
          'requestId',
          'source',
          'version',
          'binding',
          'meta',
          'lines',
          'firstLineNumber',
          'totalLineCount'
        ],
        [],
        'invalid-message'
      );
      token(record.generation, 'invalid-generation');
      token(record.requestId, 'invalid-request');
      authority(record);
      const content = lines(record.lines);
      positive(record.firstLineNumber, 'invalid-coordinates');
      nonnegative(record.totalLineCount, 'invalid-coordinates');
      if (record.totalLineCount - record.firstLineNumber + 1 !== content.length) reject('invalid-coordinates');
      snapshotMeta(record);
      return;
    }
    case 'source:error': {
      const record = exact(value, ['type', 'generation', 'requestId', 'source', 'error'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.requestId, 'invalid-request');
      source(record.source);
      if (!LOAD_ERRORS.includes(record.error as string)) reject('invalid-error');
      return;
    }
    case 'source:append': {
      const record = exact(
        value,
        ['type', 'generation', 'source', 'version', 'binding', 'firstLineNumber', 'lines'],
        [],
        'invalid-message'
      );
      token(record.generation, 'invalid-generation');
      authority(record);
      const content = lines(record.lines);
      if (content.length < 1 || content.length > MAX_APPEND_LINES) reject('invalid-lines');
      positive(record.firstLineNumber, 'invalid-coordinates');
      if (content.length - 1 > Number.MAX_SAFE_INTEGER - record.firstLineNumber) reject('invalid-coordinates');
      return;
    }
    case 'source:lifecycle': {
      const record = exact(
        value,
        ['type', 'generation', 'source', 'version', 'binding', 'state', 'totalLineCount'],
        [],
        'invalid-message'
      );
      token(record.generation, 'invalid-generation');
      authority(record);
      if (!['started', 'resumed', 'ended'].includes(record.state as string)) reject('invalid-state');
      nonnegative(record.totalLineCount, 'invalid-coordinates');
      return;
    }
    case 'source:status': {
      const record = exact(
        value,
        ['type', 'generation', 'source', 'version', 'binding', 'state'],
        [],
        'invalid-message'
      );
      token(record.generation, 'invalid-generation');
      authority(record);
      if (!['resynchronizing', 'ready'].includes(record.state as string)) reject('invalid-state');
      return;
    }
    case 'source:invalidated': {
      const record = exact(
        value,
        ['type', 'generation', 'source', 'version', 'binding', 'reason'],
        [],
        'invalid-message'
      );
      token(record.generation, 'invalid-generation');
      authority(record);
      if (!INVALIDATION_REASONS.includes(record.reason as string)) reject('invalid-reason');
      return;
    }
    case 'connection:state': {
      const record = exact(value, ['type', 'generation', 'state'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      if (!['connected', 'disconnected', 'resynchronizing'].includes(record.state as string)) reject('invalid-state');
      return;
    }
    case 'theme:change': {
      const record = exact(value, ['type', 'generation', 'themeKind', 'cssVariables'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      if (![1, 2, 3].includes(record.themeKind as number)) reject('invalid-theme');
      const variables = exact(record.cssVariables, [], Object.keys(record.cssVariables ?? {}), 'invalid-theme');
      for (const [name, variable] of Object.entries(variables))
        if (!name.startsWith('--') || typeof variable !== 'string') reject('invalid-theme');
      return;
    }
    case 'layout:handshake': {
      const record = exact(value, ['type', 'generation', 'token'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.token, 'invalid-token');
      return;
    }
    default:
      reject('unknown-type');
  }
}

/**
 * Validates one renderer message, throwing a rejection on failure.
 * @param value - Candidate.
 * @throws Rejection when invalid.
 */
function renderer(value: unknown): void {
  const type = exact(value, ['type'], Object.keys(value ?? {}), 'invalid-message').type;
  switch (type) {
    case 'source:subscribe': {
      const record = exact(value, ['type', 'generation', 'requestId', 'source', 'history'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.requestId, 'invalid-request');
      source(record.source);
      if (record.history !== 'tail' && record.history !== 'full') reject('invalid-history');
      return;
    }
    case 'source:unsubscribe': {
      const record = exact(value, ['type', 'generation', 'source'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      source(record.source);
      return;
    }
    case 'session:resync':
    case 'close': {
      const record = exact(value, ['type', 'generation'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      return;
    }
    case 'openFile': {
      const record = exact(value, ['type', 'generation', 'path'], ['line'], 'invalid-message');
      token(record.generation, 'invalid-generation');
      identifier(record.path, 'invalid-path');
      if ('line' in record) positive(record.line, 'invalid-line');
      return;
    }
    case 'showDiff': {
      const record = exact(value, ['type', 'generation', 'sha'], ['filePath'], 'invalid-message');
      token(record.generation, 'invalid-generation');
      identifier(record.sha, 'invalid-sha', MAX_TOKEN_LENGTH);
      if ('filePath' in record) identifier(record.filePath, 'invalid-path');
      return;
    }
    case 'layout:ready': {
      const record = exact(value, ['type', 'generation', 'token'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.token, 'invalid-token');
      return;
    }
    case 'layout:size': {
      const record = exact(value, ['type', 'generation', 'token', 'revision', 'height'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.token, 'invalid-token');
      positive(record.revision, 'invalid-revision');
      positive(record.height, 'invalid-height');
      if (record.height > MAX_LAYOUT_HEIGHT) reject('invalid-height');
      return;
    }
    case 'layout:scroll': {
      const record = exact(value, ['type', 'generation', 'token', 'command'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.token, 'invalid-token');
      const kind = exact(record.command, ['kind'], Object.keys(record.command ?? {}), 'invalid-scroll').kind;
      if (kind === 'delta') {
        const command = exact(record.command, ['kind', 'deltaY'], [], 'invalid-scroll');
        if (
          typeof command.deltaY !== 'number' ||
          !Number.isFinite(command.deltaY) ||
          Math.abs(command.deltaY) > MAX_SCROLL_DELTA
        )
          reject('invalid-scroll');
      } else if (kind === 'key') {
        const command = exact(record.command, ['kind', 'key'], [], 'invalid-scroll');
        if (!SCROLL_KEYS.includes(command.key as string)) reject('invalid-scroll');
      } else reject('invalid-scroll');
      return;
    }
    case 'layout:anchor': {
      const record = exact(value, ['type', 'generation', 'token', 'revision', 'key', 'delta'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      token(record.token, 'invalid-token');
      positive(record.revision, 'invalid-revision');
      identifier(record.key, 'invalid-anchor', 1024);
      if (
        typeof record.delta !== 'number' ||
        !Number.isFinite(record.delta) ||
        Math.abs(record.delta) > MAX_LAYOUT_HEIGHT
      )
        reject('invalid-anchor');
      return;
    }
    case 'view:state': {
      const record = exact(value, ['type', 'generation', 'state'], [], 'invalid-message');
      token(record.generation, 'invalid-generation');
      viewState(record.state);
      return;
    }
    default:
      reject('unknown-type');
  }
}

/**
 * Validates one bounded list of unique-key view-state pairs.
 * @param value - Candidate list.
 * @param entry - Throwing validator for one pair's value.
 * @throws Rejection when the list, a key, or a value is invalid.
 */
function viewEntries(value: unknown, entry: (item: unknown) => void): void {
  if (!Array.isArray(value) || value.length > MAX_VIEW_STATE_ENTRIES) reject('invalid-view-state');
  const keys = new Set<string>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) reject('invalid-view-state');
    const [key, item] = pair as [unknown, unknown];
    identifier(key, 'invalid-view-state', MAX_VIEW_STATE_KEY_LENGTH);
    if (keys.has(key)) reject('invalid-view-state');
    keys.add(key);
    entry(item);
  }
}

/**
 * Validates an exact view-state record.
 * @param value - Candidate.
 * @throws Rejection when any list, key, or range is invalid.
 */
function viewState(value: unknown): void {
  const record = exact(value, ['open', 'ranges'], [], 'invalid-view-state');
  viewEntries(record.open, (item) => {
    if (typeof item !== 'boolean') reject('invalid-view-state');
  });
  viewEntries(record.ranges, (item) => {
    const range = exact(item, ['first', 'count'], [], 'invalid-view-state');
    positive(range.first, 'invalid-view-state');
    positive(range.count, 'invalid-view-state');
  });
}

/**
 * Runs a throwing validator and converts the outcome.
 * @param value - Candidate.
 * @param check - Throwing validator.
 * @returns Typed validation result.
 * @throws Error for unexpected internal failures.
 */
function run<T>(value: unknown, check: (value: unknown) => void): MessageValidation<T> {
  try {
    check(value);
    return { ok: true, message: value as T };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Validates an untrusted host-to-renderer message.
 * @param value - Raw `postMessage` data.
 * @returns The typed message, or an identifier-only rejection reason.
 */
export function validateHostMessage(value: unknown): MessageValidation<HostToRendererMessage> {
  return run(value, host);
}

/**
 * Validates an untrusted renderer-to-host message.
 * @param value - Raw `postMessage` data.
 * @returns The typed message, or an identifier-only rejection reason.
 */
export function validateRendererMessage(value: unknown): MessageValidation<RendererToHostMessage> {
  return run(value, renderer);
}

/**
 * Validates untrusted persisted or renderer-supplied view state.
 * @param value - Candidate state.
 * @returns The typed state, or an identifier-only rejection reason.
 */
export function validateViewState(value: unknown): MessageValidation<StreamViewState> {
  return run(value, viewState);
}
