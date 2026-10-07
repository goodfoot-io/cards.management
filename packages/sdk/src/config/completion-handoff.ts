/**
 * The completion handoff between an action wrapper and its handler.
 *
 * A completion stop (`cards shutdown`) used to signal the action's process
 * group at once, so the handler shut down with its fence closed and its own
 * end-of-session work — the slot cleanup pass — could never run. With the
 * handoff, a handler that can finish on its own declares so once, and the
 * wrapper asks it to finish instead of killing it, then waits a bounded time
 * for the root to exit before stopping it as before.
 *
 * The channel is a private per-execution directory the wrapper names in
 * {@link EXECUTION_COMPLETION_DIR_ENV}: the handler writes `ready`, the wrapper
 * writes `request`. Each file is written atomically. A process that never
 * declares readiness is stopped immediately, exactly as without the handoff.
 *
 * @summary File channel through which a wrapper asks its handler to finish
 * @module
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Inherited by the handler of an owned action wrapper. */
export const EXECUTION_COMPLETION_DIR_ENV = 'CARDS_EXECUTION_COMPLETION_DIR';

/**
 * Longest a wrapper waits for a ready handler to finish after a completion request.
 *
 * The handler's own work after the request is bounded: agent termination
 * (graceful then forced, 10 s), the slot cleanup pass (60 s), and the shutdown
 * hooks (3 s). The ceiling sits just above their sum.
 */
export const COMPLETION_HANDOFF_CEILING_MS = 75_000;

/** How often a ready handler looks for the wrapper's request. */
export const COMPLETION_REQUEST_POLL_MS = 250;

const READY_FILE = 'ready';
const REQUEST_FILE = 'request';

function writeMarker(directory: string, name: string): void {
  if (!isAbsolute(directory)) throw new Error('Execution completion directory must be absolute');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx', flush: true });
  renameSync(temporary, join(directory, name));
}

/**
 * Tells the wrapper this handler finishes on its own when asked.
 * @param directory - The execution's completion directory.
 * @throws When the directory is not absolute or the marker cannot be written.
 */
export function declareCompletionReady(directory: string): void {
  writeMarker(directory, READY_FILE);
}

/**
 * Reports whether the handler has declared readiness.
 * @param directory - The execution's completion directory.
 * @returns Whether a completion request will be honoured.
 */
export function isCompletionReady(directory: string): boolean {
  return existsSync(join(directory, READY_FILE));
}

/**
 * Asks a ready handler to finish.
 * @param directory - The execution's completion directory.
 * @throws When the directory is not absolute or the marker cannot be written.
 */
export function requestCompletion(directory: string): void {
  writeMarker(directory, REQUEST_FILE);
}

export interface CompletionWatchOptions {
  /** Ends the watch, for example when shutdown begins. */
  readonly signal?: AbortSignal;
  /** Poll interval; defaults to {@link COMPLETION_REQUEST_POLL_MS}. */
  readonly pollMs?: number;
}

/**
 * Declares readiness and calls `onRequest` once when the wrapper asks for completion.
 *
 * The watch starts before readiness is declared, so no request can be missed.
 * Its timer never keeps the process alive.
 *
 * @param directory - The execution's completion directory.
 * @param onRequest - Runs at most once, when the request appears.
 * @param options - Abort signal and poll interval.
 * @returns Ends the watch.
 * @throws When readiness cannot be declared; nothing is left watching then.
 */
export function watchCompletionRequest(
  directory: string,
  onRequest: () => void,
  options: CompletionWatchOptions = {}
): () => void {
  const request = join(directory, REQUEST_FILE);
  const timer = setInterval(() => {
    if (!existsSync(request)) return;
    stop();
    onRequest();
  }, options.pollMs ?? COMPLETION_REQUEST_POLL_MS);
  timer.unref();
  const stop = (): void => {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', stop);
  };
  if (options.signal?.aborted) {
    stop();
    return stop;
  }
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    declareCompletionReady(directory);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
