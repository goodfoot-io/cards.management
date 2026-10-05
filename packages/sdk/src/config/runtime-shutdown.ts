/**
 * The handler runtime's shutdown hook and fence.
 *
 * Every exit of a compiled handler that runs code goes through
 * {@link shutdownAndExit}: normal completion, failure, the root-command branch,
 * the switch and cancel command handlers, and `SIGTERM`/`SIGINT`. It is
 * single-flight. The first call aborts {@link shutdownSignal}, runs the
 * registered hooks in reverse order of registration under one overall
 * {@link SHUTDOWN_BUDGET_MS} budget, finalizes, and exits; every later call,
 * including each repeated `SIGTERM` of a wrapper's stop burst, returns the same
 * promise and does nothing else.
 *
 * The signal is the fence the slot layer builds on: once it has aborted, no new
 * slot mutation starts, and only a shutdown hook may release a slot lock. The
 * budget is best effort before the wrapper's force, not a guarantee; a hook that
 * throws or overruns is reported, and the exit still happens.
 *
 * @summary Single-flight shutdown hooks, budget, and fence signal for handler processes
 * @module
 */

import { constants as osConstants } from 'node:os';

/** Why the handler process is shutting down. */
export type ShutdownReason = 'completed' | 'failed' | 'cancel' | 'switch' | 'signal';

/** Work the handler must finish before it exits. Runs at most once, within the shared budget. */
export type ShutdownHook = (reason: ShutdownReason) => Promise<void>;

/** Overall best-effort budget for every registered hook together. */
export const SHUTDOWN_BUDGET_MS = 3_000;

/** Process-wide wiring the runtime supplies; defaults suit tests and non-runtime callers. */
export interface ShutdownConfiguration {
  /** Reports a hook that threw or overran. */
  readonly onHookError?: (error: unknown) => void;
  /** Runs after the hooks and before `process.exit`, for example to close the logger. */
  readonly finalize?: () => void;
}

/**
 * Error thrown by fenced work started or resumed after shutdown began.
 *
 * A slot operation stopped by it does not roll back: it leaves its creation
 * intent or quarantine residue for the next holder of the slot.
 */
export class ShutdownError extends Error {
  /**
   * Creates a new ShutdownError instance.
   *
   * @param message - Human-readable description of the refused work
   */
  constructor(message = 'Shutdown has begun; no new work may start') {
    super(message);
    this.name = 'ShutdownError';
  }
}

/** Seams of one shutdown coordinator; the process-wide one uses the defaults. */
export interface ShutdownCoordinatorOptions {
  /** Ends the process; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Overall hook budget; defaults to {@link SHUTDOWN_BUDGET_MS}. */
  readonly budgetMs?: number;
}

/** One single-flight shutdown: its fence signal, hook registry and exit. */
export interface ShutdownCoordinator {
  /** Aborted the moment shutdown starts, before the first hook runs. */
  readonly signal: AbortSignal;
  /**
   * Registers a hook; see {@link registerShutdownHook}.
   * @param hook - Work to finish before exit.
   * @returns Removes the hook; a no-op once shutdown has begun.
   */
  register(hook: ShutdownHook): () => void;
  /**
   * Sets how hook failures are reported and what runs before exit.
   * @param configuration - Hook error reporter and finalizer.
   */
  configure(configuration: ShutdownConfiguration): void;
  /**
   * Shuts down once; see {@link shutdownAndExit}.
   * @param code - Exit code.
   * @param reason - Why the process is exiting; passed to every hook.
   * @returns The shared shutdown promise.
   */
  shutdownAndExit(code: number, reason: ShutdownReason): Promise<never>;
}

/**
 * Creates a single-flight shutdown coordinator.
 * @param options - Exit function and hook budget.
 * @returns A coordinator with its own fence signal and hooks.
 */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions = {}): ShutdownCoordinator {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const budgetMs = options.budgetMs ?? SHUTDOWN_BUDGET_MS;
  const controller = new AbortController();
  const hooks: ShutdownHook[] = [];
  let configuration: ShutdownConfiguration = {};
  let shutdown: Promise<never> | undefined;

  const report = (error: unknown): void => {
    try {
      if (configuration.onHookError !== undefined) configuration.onHookError(error);
      else process.stderr.write(`Shutdown hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      // A failing reporter must not stop the exit.
    }
  };

  const runHooks = async (reason: ShutdownReason): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    // Snapshot: a hook registered from here on is accepted but never runs.
    for (const hook of hooks.splice(0).reverse()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        report(new Error(`Shutdown budget of ${budgetMs} ms exhausted before a hook ran`));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overrun = new Promise<'overrun'>((resolveOverrun) => {
        timer = setTimeout(() => resolveOverrun('overrun'), remaining);
      });
      try {
        const outcome = await Promise.race([
          Promise.resolve()
            .then(() => hook(reason))
            .then(() => 'done' as const),
          overrun
        ]);
        if (outcome === 'overrun') {
          report(new Error(`Shutdown hook overran the ${budgetMs} ms budget`));
          return;
        }
      } catch (error) {
        report(error);
      } finally {
        clearTimeout(timer);
      }
    }
  };

  return {
    signal: controller.signal,
    register(hook) {
      if (controller.signal.aborted) return () => {};
      hooks.push(hook);
      return () => {
        const index = hooks.indexOf(hook);
        if (index !== -1 && !controller.signal.aborted) hooks.splice(index, 1);
      };
    },
    configure(next) {
      configuration = next;
    },
    shutdownAndExit(code, reason) {
      if (shutdown !== undefined) return shutdown;
      controller.abort();
      shutdown = runHooks(reason).then(() => {
        try {
          configuration.finalize?.();
        } catch (error) {
          report(error);
        }
        exit(code);
        // Reached only when the exit function returns, as a test's does.
        return undefined as never;
      });
      return shutdown;
    }
  };
}

const coordinator = createShutdownCoordinator();

/** Aborted the moment shutdown starts, before the first hook runs. */
export const shutdownSignal: AbortSignal = coordinator.signal;

/**
 * Registers a hook to run when the handler shuts down.
 *
 * Hooks run in reverse order of registration. Registering after shutdown began
 * is accepted and the hook never runs, which is fail-safe for the slot layer:
 * an unreleased lock frees through dead-holder detection.
 *
 * @param hook - Work to finish before exit.
 * @returns Removes the hook; a no-op once shutdown has begun.
 */
export function registerShutdownHook(hook: ShutdownHook): () => void {
  return coordinator.register(hook);
}

/**
 * Sets how hook failures are reported and what runs before `process.exit`.
 *
 * @param configuration - Hook error reporter and finalizer.
 */
export function configureShutdown(configuration: ShutdownConfiguration): void {
  coordinator.configure(configuration);
}

/**
 * Shuts the handler down and exits with `code`.
 *
 * @param code - Exit code passed to `process.exit`.
 * @param reason - Why the handler is exiting; passed to every hook.
 * @returns A promise that settles only when `process.exit` is mocked; every call shares it.
 */
export function shutdownAndExit(code: number, reason: ShutdownReason): Promise<never> {
  return coordinator.shutdownAndExit(code, reason);
}

/**
 * The process-wide coordinator behind {@link shutdownAndExit}, for the runtime
 * and the slot layer's default environment.
 *
 * @returns The coordinator every module-level export delegates to.
 */
export function processShutdownCoordinator(): ShutdownCoordinator {
  return coordinator;
}

let signalHandlersInstalled = false;

/**
 * Installs `SIGTERM` and `SIGINT` handlers that shut down with `128 + signo`.
 * They stay installed for the whole shutdown, so a repeated signal never
 * falls back to its default action. Installing twice is a no-op.
 */
export function installShutdownSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const name of ['SIGTERM', 'SIGINT'] as const) {
    process.on(name, () => {
      void shutdownAndExit(128 + osConstants.signals[name], 'signal');
    });
  }
}
