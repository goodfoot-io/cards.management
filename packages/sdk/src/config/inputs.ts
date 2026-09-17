/**
 * Input types for action and cards-assistant handlers.
 *
 * These types define the input payloads that handlers receive when actions or
 * the cards assistant are triggered. The runtime extracts these values from
 * environment variables and passes them to handlers as typed objects.
 *
 *
 * @summary Input types for action and cards-assistant handlers
 * @module
 */

/**
 * Input payload for action handlers.
 *
 * These values are injected as environment variables by the action dispatcher
 * when spawning action commands. The runtime extracts them and passes them to
 * your handler as a typed object.
 *
 * @example
 * ```typescript
 * async (input: ActionInput, { logger }) => {
 *   // Access card context
 *   logger.info(`Processing card ${input.cardId}`);
 * }
 * ```
 */
export interface ActionInput {
  /** Server-minted identity of this admitted execution. */
  executionId: string;

  /** Authority-issued worktree policy for this admission. */
  worktreeDirective: WorktreeAllocationDirective;

  /**
   * Unique identifier for the current card.
   *
   * This ID is stable across action invocations and can be used to track
   * state or make API calls related to the card.
   */
  cardId: string;

  /**
   * Display name of the action button that triggered this handler.
   *
   * Matches the `actionName` field from the `defineAction` factory config
   * (e.g., "Launch Claude", "Interview"). Useful for logging and analytics.
   */
  actionName: string;

  /**
   * The environment name this action belongs to.
   *
   * Matches the environment key in settings.json (e.g., "default", "staging").
   * Useful for environment-specific behavior or logging.
   */
  environment: string;

  /**
   * Card's execution mode, determining UI interaction model.
   *
   * - `interactive`: User is actively engaged; UI is visible
   * - `background`: Action runs without user attention; minimize prompts
   */
  executionMode: 'interactive' | 'background';

  /**
   * Whether the action should exit when the agent finishes.
   *
   * When `true`, the runtime exits once the agent process completes.
   * When `false`, the runtime continues running after agent completion.
   */
  exitWhenDone: boolean;

  /**
   * Configured coding agent identifier from `cards.codingAgent` setting.
   *
   * When set, indicates which AI coding assistant the user prefers. Actions
   * can use this to customize behavior or prompts for different agents.
   */
  codingAgent?: string;

  /**
   * Data passed from a previous switchToInteractive response.
   *
   * When an action is relaunched in interactive mode after a background-to-interactive
   * switch, this field contains the serialized data returned by the previous handler's
   * `onSwitchToInteractive` callback. The data is read from a file at
   * `SWITCH_TO_INTERACTIVE_DATA_PATH`.
   *
   * Undefined when the action is launched normally (not via switchToInteractive).
   */
  switchToInteractiveData?: unknown;

  /**
   * Absolute path to the main git repository root (NOT a worktree).
   * Read from REPO_ROOT, set by ActionDispatcher.
   */
  repoRoot: string;

  /**
   * Path to the card's repository directory.
   */
  cardRepoPath: string;

  /**
   * Path to the settings configuration directory.
   */
  configPath: string;

  /**
   * Absolute path to the VS Code extension installation directory.
   *
   * Use this to locate bundled assets such as the runtime plugin directory
   * (`<extensionPath>/dist/claude/runtime`).
   */
  extensionPath: string;

  /**
   * Stable symlink path to the marketplace directory inside global storage.
   *
   * This path does not change across extension upgrades, unlike the versioned
   * extension installation path. Use this to register the marketplace source
   * or locate marketplace assets.
   */
  marketplacePath: string;
}

/**
 * Runtime context injected when an action executes.
 *
 * The context is created by the runtime and provides utilities for logging,
 * accessing the working directory, and registering lifecycle callbacks.
 *
 * @example
 * ```typescript
 * async (input, context: ActionContext) => {
 *   context.logger.info('Action started', { cwd: context.cwd });
 *
 *   // Register lifecycle callbacks
 *   context.onCancel(() => {
 *     context.logger.info('Action cancelled');
 *   });
 *
 *   context.onSwitchToInteractive(() => {
 *     return { sessionId: 'abc123' };
 *   });
 *
 *   // Use cwd for file operations
 *   const configPath = path.join(context.cwd, 'config.json');
 *   if (await fs.exists(configPath)) {
 *     // ...
 *   }
 * }
 * ```
 */
export interface ActionContext {
  /**
   * Logger for structured, context-aware logging.
   *
   * Pre-configured with action type and input metadata. Log events are
   * enriched automatically; you only need to provide the message and
   * optional context data.
   *
   * Uses the {@link ILogger} interface to allow for easy mocking in tests
   * while accepting the full {@link Logger} class in production.
   *
   * @see {@link Logger} for the full Logger class implementation
   * @see {@link ILogger} for the logger interface
   */
  logger: import('./logger.js').ILogger;

  /**
   * Current working directory for the action.
   *
   * Set by the runtime based on the card's project directory. Use this
   * as the base for relative file operations.
   */
  cwd: string;

  /**
   * Reports the worktree successfully settled for this execution. The runtime
   * binds the report to the authenticated execution; handlers cannot nominate
   * another execution identity.
   */
  reportWorktreeAssignment(assignment: WorktreeAssignmentResult): Promise<void>;

  /**
   * Durably registers the provider's session-specific inputs for a later
   * detached branch-cleanup run, while the provider still holds them. The
   * server derives `cardId`/`repoRoot`/`cardRepoPath` from the admitted
   * execution and its reservation itself — this carries nothing else on
   * purpose, so no path supplied by a producer can steer the maintenance
   * worker.
   */
  reportBranchCleanupRegistration(registration: BranchCleanupRegistration): Promise<void>;

  /**
   * Register a callback to be invoked when the action is cancelled.
   *
   * The callback is called when the runtime receives a cancel command
   * via the socket connection. If no callback is registered, the runtime
   * will send SIGTERM to terminate the process.
   *
   * @param callback - Function to call on cancellation
   */
  onCancel(callback: () => void | Promise<void>): void;

  /**
   * Register a callback to handle switching from background to interactive mode.
   *
   * The callback should return serializable data that will be passed to the
   * relaunched handler via `ActionInput.switchToInteractiveData`. The runtime
   * will send this data back to the dispatcher and exit with a special exit code.
   *
   * If no callback is registered when the switchToInteractive command arrives,
   * the command is ignored (no-op).
   *
   * @param callback - Function that returns data to pass to the relaunched handler
   */
  onSwitchToInteractive(callback: () => unknown | Promise<unknown>): void;
}

/** Immutable worktree policy selected while an admitted execution is reserved. */
export type WorktreeAllocationDirective =
  | { readonly kind: 'reuse' }
  | { readonly kind: 'allocate' }
  | {
      readonly kind: 'preowned';
      readonly branch: string;
      readonly worktreePath: string;
    };

/** Worktree settlement reported by the admitted action handler. */
export interface WorktreeAssignmentResult {
  readonly branch: string;
  readonly worktreePath: string;
  readonly reason: 'reused' | 'reattached' | 'allocated';
}

/**
 * Branch-cleanup registration reported by the admitted action handler while
 * it still holds its session-specific inputs.
 */
export interface BranchCleanupRegistration {
  readonly sessionId?: string;
}

// ============================================================================
// Cards Assistant Types
// ============================================================================

/**
 * Input payload for cards-assistant handlers.
 *
 * These values are injected as environment variables by the extension when
 * launching the cards assistant. The runtime extracts them and passes them
 * to the handler as a typed object.
 *
 * Unlike {@link ActionInput}, there is no card context (no cardId, no
 * worktree, no socket). The cards assistant operates at workspace scope.
 *
 * @example
 * ```typescript
 * async (input: CardsAssistantInput, { logger }) => {
 *   logger.info(`Marketplace at ${input.marketplacePath}`);
 * }
 * ```
 */
export interface CardsAssistantInput {
  /**
   * Stable symlink path to the marketplace directory inside global storage.
   *
   * This path does not change across extension upgrades, unlike the versioned
   * extension installation path.
   */
  marketplacePath: string;

  /**
   * Absolute path to the VS Code extension installation directory.
   *
   * Use this to locate bundled assets such as the runtime plugin directory.
   */
  extensionPath: string;

  /**
   * Configured coding agent identifier from `cards.codingAgent` setting.
   *
   * Optional. When set, indicates which AI coding assistant the user prefers.
   */
  codingAgent?: string;

  /**
   * Absolute path to the main git repository root (NOT a worktree).
   */
  repoRoot: string;

  /**
   * Opening prompt seeding the session's first user turn.
   *
   * Optional. When absent or empty, the session waits for the user's first
   * message, matching today's cold start.
   */
  initialPrompt?: string;
}

/**
 * Runtime context injected when the cards assistant executes.
 *
 * Simpler than {@link ActionContext} because the cards assistant has no
 * socket connection, no cancel/switchToInteractive callbacks.
 *
 * @example
 * ```typescript
 * async (input, context: CardsAssistantContext) => {
 *   context.logger.info('Cards assistant started', { cwd: context.cwd });
 * }
 * ```
 */
export interface CardsAssistantContext {
  /**
   * Logger for structured, context-aware logging.
   *
   * @see {@link ActionContext.logger}
   */
  logger: import('./logger.js').ILogger;

  /**
   * Current working directory for the cards assistant.
   */
  cwd: string;
}
