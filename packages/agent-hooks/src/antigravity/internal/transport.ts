/**
 * Transport for the Antigravity `runtime` hook handlers: the stdin → handler
 * → stdout driver each emitted `bin/*.mjs` bundle runs as its main.
 *
 * Mirrors the `@goodfoot/agent-hooks` core transport's wire rules (read all
 * of stdin, parse one JSON document, reserve stdout for the hook response)
 * while implementing the Antigravity host contract's failure policy: a
 * {@link HandlerFailure} becomes a conversation-scoped failure marker on
 * disk, a stderr diagnostic, and a non-zero exit — never a guessed output
 * document.
 *
 * @summary Stdin/stdout driver for the Antigravity runtime handler bundles
 * @module internal/transport
 */

import { pathToFileURL } from 'node:url';
import { Logger, parseStdinJson, readStdin } from '@goodfoot/agent-hooks';
import { type AntigravityHandlerDeps, defaultAntigravityHandlerDeps } from './deps.js';
import {
  type AntigravityHandlerResult,
  type HandlerContext,
  HandlerFailure,
  type HandlerFailureStage
} from './handlers.js';
import { classifyCardsManagedSession, peekConversationId } from './inputs.js';
import type { AntigravityIo } from './io.js';
import type { RuntimeMarkerKind } from './markers.js';
import { markerPath, writeMarker } from './markers.js';

/** The stderr diagnostic prefix every Antigravity Cards hook writes. */
const STDERR_PREFIX = '[antigravity-cards-hooks]';

/**
 * Reports whether the calling module is the process's main entry.
 *
 * Each emitted `bin/*.mjs` bundle runs this check before driving: the host
 * executes the bundle directly (`process.argv[1]` names it), while tests
 * import the same module without triggering a stdin read.
 *
 * @returns `true` when the module was executed directly.
 */
function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

/**
 * Writes one diagnostic line to stderr without ever throwing.
 *
 * @param line - Preformatted diagnostic line.
 */
function stderrLine(line: string): void {
  try {
    process.stderr.write(`${STDERR_PREFIX} ${line}\n`);
  } catch {
    // A dead stderr must not prevent the failure marker or exit status.
  }
}

/**
 * Writes the conversation-scoped failure marker for one handler failure.
 *
 * When the session identity cannot be resolved the marker lands under the
 * `unattributed` directory, and when the input carried no conversation id
 * under the `unknown-conversation` placeholder — a failure the launcher
 * cannot find is a failure that hangs until its bounded wait expires.
 *
 * @param io - Filesystem seam.
 * @param cardsConfigDir - Cards global configuration directory.
 * @param sessionId - Cards session id, or `null` when unresolvable.
 * @param conversationId - Conversation id, or `null` when the input carried none.
 * @param stage - Contract stage the failure occurred at.
 * @param reason - Human-readable failure reason.
 * @returns `true` when the marker was written.
 */
export function writeFailureMarker(
  io: AntigravityIo,
  cardsConfigDir: string,
  sessionId: string | null,
  conversationId: string | null,
  stage: HandlerFailureStage,
  reason: string
): boolean {
  try {
    writeMarker(io, markerPath(cardsConfigDir, sessionId, conversationId, 'failure' satisfies RuntimeMarkerKind), {
      stage,
      reason
    });
    return true;
  } catch (error) {
    stderrLine(`could not write the failure marker: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Dispatches one parsed hook input to its handler under the failure policy.
 *
 * The handler runs with the default dependency wiring and logger; a thrown
 * {@link HandlerFailure} (or any unexpected error) writes the
 * conversation-scoped failure marker, emits a stderr diagnostic, and
 * rethrows so the process exits non-zero with nothing on stdout.
 *
 * @param raw - The parsed stdin JSON value.
 * @param handler - The event's handler body.
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns The handler's result on success.
 * @throws {HandlerFailure} On every handler failure, after the marker and
 *   diagnostics are written.
 */
export async function dispatchAntigravityHook(
  raw: unknown,
  handler: (raw: unknown, ctx: HandlerContext) => Promise<AntigravityHandlerResult>,
  deps: AntigravityHandlerDeps = defaultAntigravityHandlerDeps()
): Promise<AntigravityHandlerResult> {
  const logger = new Logger();
  const ctx: HandlerContext = { deps, logger };

  const conversationId: string | null = peekConversationId(raw);

  try {
    return await handler(raw, ctx);
  } catch (error) {
    const stage = error instanceof HandlerFailure ? error.stage : 'unexpected';
    const reason = error instanceof Error ? error.message : String(error);
    const markerConversationId = error instanceof HandlerFailure ? error.conversationId : conversationId;
    const sessionId = deps.resolveSessionId();
    writeFailureMarker(deps.io, deps.cardsConfigDir(), sessionId, markerConversationId, stage, reason);
    stderrLine(`failure at ${stage}: ${reason}`);
    throw new HandlerFailure(stage, reason, markerConversationId);
  }
}

/**
 * Drives one Antigravity hook invocation to completion.
 *
 * Drains all of stdin (a child that exits without reading can break the
 * host's write side), then either responds inertly — a non-Cards session
 * gets the empty no-decision document and exit 0 — or parses the input and
 * dispatches it. Failures write the failure marker and exit 1 with nothing
 * on stdout.
 *
 * @param handler - The event's handler body.
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @throws {HandlerFailure} When the input could not be read or the handler
 *   failed, after the marker and diagnostics are written.
 */
export async function runAntigravityHook(
  handler: (raw: unknown, ctx: HandlerContext) => Promise<AntigravityHandlerResult>,
  deps: AntigravityHandlerDeps = defaultAntigravityHandlerDeps()
): Promise<void> {
  const stdin = await readStdin();

  if (classifyCardsManagedSession() === 'foreign') {
    process.stdout.write(`${JSON.stringify({})}\n`);
    return;
  }

  let raw: unknown;
  try {
    raw = parseStdinJson(stdin);
  } catch (error) {
    const reason = `could not read the hook input: ${error instanceof Error ? error.message : String(error)}`;
    const sessionId = deps.resolveSessionId();
    writeFailureMarker(deps.io, deps.cardsConfigDir(), sessionId, null, 'input', reason);
    stderrLine(`input error: ${reason}`);
    throw new HandlerFailure('input', reason, null);
  }

  const result = await dispatchAntigravityHook(raw, handler, deps);
  process.stdout.write(`${JSON.stringify(result.output ?? {})}\n`);
}

/**
 * Wires one emitted `bin/*.mjs` bundle's main: drives the handler when (and
 * only when) the bundle is executed directly, exiting 0 on success and 1 on
 * any handled failure.
 *
 * @param handler - The event's handler body.
 */
export function main(handler: (raw: unknown, ctx: HandlerContext) => Promise<AntigravityHandlerResult>): void {
  if (!isDirectExecution()) {
    return;
  }
  runAntigravityHook(handler).catch(() => {
    process.exitCode = 1;
  });
}
