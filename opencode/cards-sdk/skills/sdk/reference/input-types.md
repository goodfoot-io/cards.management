<instructions>

Typed input and context structures in `@cards.management/sdk/config`.

## ActionInput

Input payload for action handlers. Extracted from environment variables by the runtime.

```typescript
interface ActionInput {
  executionId: string;                    // Server-minted identity of this admitted execution
  cardId: string;                         // Unique card identifier
  actionName: string;                     // Action button display name (e.g., "Launch Claude")
  environment: string;                    // Environment name (e.g., "default")
  executionMode: 'interactive' | 'background';  // UI interaction model
  exitWhenDone: boolean;                  // When true, the runtime exits once the agent process completes
  codingAgent?: string;                   // Configured AI coding assistant
  switchToInteractiveData?: unknown;      // Data from user switching to interactive mode
  repoRoot: string;                       // Main git repository root (NOT a worktree)
  cardRepoPath: string;                   // Card repository path
  configPath: string;                     // Settings configuration directory
  extensionPath: string;                  // VS Code extension installation directory
  marketplacePath: string;                // Stable marketplace symlink in global storage
}
```

## ActionContext

Runtime context injected for **action** handlers.

```typescript
interface ActionContext {
  logger: ILogger;  // Structured, context-aware logging
  cwd: string;      // Working directory, set from the card's project directory
  onShutdown(hook: ShutdownHook): () => void;  // Runs once before exit, under a 3 s best-effort budget
  onCancel(callback: () => void | Promise<void>): void;
  onSwitchToInteractive(callback: () => unknown | Promise<unknown>): void;
}
```

Register `onCancel` to run cleanup on the socket cancel command. Without it, the runtime sends SIGTERM instead.

## CardsAssistantInput

```typescript
interface CardsAssistantInput {
  marketplacePath: string;  // Stable marketplace symlink in global storage
  extensionPath: string;    // VS Code extension installation directory
  codingAgent?: string;     // Configured AI coding assistant
  repoRoot: string;         // Main git repository root (NOT a worktree)
  initialPrompt?: string;   // Seed prompt; absent = cold start
}
```

## CardsAssistantContext

No socket, so no `onCancel` or `onSwitchToInteractive`.

```typescript
interface CardsAssistantContext {
  logger: ILogger;
  cwd: string;
}
```

## WorktreeMaintenanceInput

Input of the `worktreeMaintenance` root command. `mode` comes from `CARDS_ROOT_COMMAND_INPUT`.

```typescript
interface WorktreeMaintenanceInput {
  executionId: string;   // The command's own execution
  cardId: string;        // Card whose worktree slots are maintained
  mode: 'preview' | 'cleanup' | 'prepare-delete';
  repoRoot: string;      // Workspace path the command was launched for; may be a linked worktree
  cardRepoPath: string;  // Card repository path
  extensionPath: string; // VS Code extension installation directory
}
```

## WorktreeMaintenanceContext

```typescript
interface WorktreeMaintenanceContext {
  logger: ILogger;
  cwd: string;
  client: CardsClient;   // Authenticated, for branch registrations and execution status
  report(report: Record<string, unknown>): void;  // Last call wins; at most 256 KiB serialized
  onShutdown(hook: ShutdownHook): () => void;
}
```

A root command succeeds only by reporting. The runtime sends the last `report()` as `execution.commandReport` before exit; a handler that returns without reporting, throws, or whose report the server does not accept exits 1, and the caller's `runRootCommand` gets no report.

## Typed Input Extraction

```typescript
import {
  extractActionInput,
  extractCardsAssistantInput,
  extractWorktreeMaintenanceInput
} from '@cards.management/sdk/config';

const actionInput = extractActionInput();                   // ActionInput
const assistantInput = extractCardsAssistantInput();        // CardsAssistantInput
const maintenanceInput = extractWorktreeMaintenanceInput(); // WorktreeMaintenanceInput
```

## Switch to Interactive Flow

`onSwitchToInteractive` registers a callback taking **no arguments** and returning serializable data. When the user requests interactive mode, the runtime invokes it, sends the returned data to the dispatcher over the socket, and exits with code 42. Do not call `process.exit` yourself — that skips the socket send and the data never reaches the host. With no callback registered, the command is a no-op.

The action is then rerun in interactive mode with that data in `input.switchToInteractiveData`:

```typescript
export default defineAction(
  { actionName: 'Long Task' },
  async (input: ActionInput, { logger, onSwitchToInteractive }) => {
    if (input.switchToInteractiveData) {
      const state = input.switchToInteractiveData as { phase: string; previousProgress: unknown };
      logger.info(`Resuming from phase: ${state.phase}`);
      return;
    }

    onSwitchToInteractive(() => ({
      phase: 'interactive',
      previousProgress: { completed: 100 }
    }));

    // Continue background work...
  }
);
```

Background mode cannot display output to the user or wait for user input; branch on `input.executionMode` before doing either.

</instructions>
