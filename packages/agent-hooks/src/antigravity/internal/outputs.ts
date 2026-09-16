/**
 * Pinned output contract for the Antigravity `runtime` hook handlers.
 *
 * The host contract pins each event's stdout JSON:
 *
 * - `PreInvocation` returns no message — an empty JSON object.
 * - `PostInvocation` returns `postInvocationOutput({ injectSteps: [{ ephemeralMessage }] })`
 *   only when another model step is required, and no output fields otherwise.
 * - `Stop` returns no `continue` decision — an empty JSON object. A Stop
 *   handler must never carry `continue`/`decision` keys: cleanup failure is
 *   signaled by the failure marker and exit status, never by turning cleanup
 *   into another model turn.
 *
 * Builders emit only the fields they are given (the `omitUndefined` idiom of
 * the `@goodfoot/agent-hooks` per-host output builders), so the emitted JSON
 * carries no reserved-looking keys the host could misread.
 *
 * @summary Output builders for the Antigravity runtime handlers
 * @module internal/outputs
 */

/** One model step the host should run after the current invocation. */
export interface EphemeralStep {
  /** Message text delivered to the model without persisting as a turn. */
  ephemeralMessage: string;
}

/** The `PostInvocation` stdout shape: step injection fields, when any. */
export interface PostInvocationOutput {
  /** Steps the host should run when another model step is required. */
  injectSteps?: EphemeralStep[];
}

/**
 * Builds the `PreInvocation` stdout payload.
 *
 * The ready signal is the conversation-scoped marker, not stdout; the payload
 * intentionally carries no message fields.
 *
 * @returns The empty JSON object the host contract pins for success.
 */
export function preInvocationOutput(): Record<string, never> {
  return {};
}

/**
 * Builds the `PostInvocation` stdout payload.
 *
 * @param options - Step injection fields.
 * @param options.injectSteps - Steps the host should run when another model
 *   step is required; omit entirely when none is required.
 * @returns `{ injectSteps: [...] }` when steps are supplied, otherwise `{}`.
 */
export function postInvocationOutput(options: { injectSteps?: EphemeralStep[] } = {}): PostInvocationOutput {
  if (options.injectSteps === undefined) {
    return {};
  }
  return { injectSteps: options.injectSteps };
}

/**
 * Builds the `Stop` stdout payload.
 *
 * Cleanup is reported through the drain-ready marker and exit status. The
 * returned object intentionally has no `continue`/`decision` keys — a Stop
 * handler never asks the host for another model turn.
 *
 * @returns The empty JSON object the host contract pins for success.
 */
export function stopOutput(): Record<string, never> {
  return {};
}
