/**
 * Read, create, list, search, and act on cards via the Cards API.
 *
 * Locates the running Cards server through `~/.cards/cards-api.json`, then
 * dispatches to the requested subcommand. All output is JSON to stdout;
 * all errors go to stderr.
 *
 * @summary Card CLI for get, create, list, search, watch, and action operations
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { resolveExtensionPath } from '@cards.management/sdk';
import { formatErrorForCli, requestProcessExit } from '@cards.management/sdk/bin/process-utils';
import { getCommitsSince } from '@cards.management/sdk/card-repo';
import { toCardListSummaries } from '@cards.management/sdk/card-summary';
import { resolveCardsParentBranch } from '@cards.management/sdk/cards-parent-branch';
import type { CardCreateData, ListCardsOptions } from '@cards.management/sdk/client';
import {
  ApiError,
  CardsClient,
  calculateBackoffMs,
  EventSubscriber,
  formatCommit,
  getUnattributedCommits,
  isBookkeepingCommit,
  NetworkError
} from '@cards.management/sdk/client';
import { discoverApiInfo } from '@cards.management/sdk/client/discovery';
import {
  createRuntimeActionClient,
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential,
  type RuntimeActionLaunchResult
} from '@cards.management/sdk/client/runtime';
import { createFileClientOutbox, resolveOutboxRoot } from '@cards.management/sdk/client/runtime/outbox';
import { readPendingShutdownRequest, writePendingShutdownRequest } from '@cards.management/sdk/config';
import { CARDS_ENV_VARS } from '@cards.management/sdk/config/env';
import { buildCardRepoLogBlock, buildWorkspaceRepoLogBlocks } from '@cards.management/sdk/context';
import {
  type CardCommit,
  type CardCommitEvent,
  CODING_AGENT_IDS,
  type CodingAgentId,
  type ExecutionMode,
  isCodingAgentId
} from '@cards.management/sdk/protocol';
import { DERIVED_TAGS, filterCardsByTags, parseSearchQuery } from '@cards.management/sdk/search-utils';
import { resolveRuntime, resolveSessionId, resolveTranscriptPath } from '@cards.management/sdk/session-resolver';
import { readUnboundCandidates, removeUnboundCandidate } from '@cards.management/sdk/unbound-worktree-candidates';
import { cardsSharedHooksDir, outfitWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import { appendCommitToSession, getSessionCommits, readSessionHeadSha } from '@cards.management/sessions/card-repo';
import { JSONPath } from 'jsonpath-plus';
import { minimatch } from 'minimatch';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import { compiledHookScriptPaths } from '../git-hooks.js';

const execFileAsync = promisify(execFile);

/**
 * Resolves the toplevel directory of the linked git worktree `cards create` is
 * running inside, or `null` when cwd is the main worktree or not a git repo.
 *
 * A linked worktree has a git-dir distinct from its common dir
 * (`git rev-parse --git-dir` ≠ `--git-common-dir`); the main worktree has them
 * equal and is never a bind target. This is the cwd-primary leg of
 * {@link resolveBindTarget}.
 *
 * @returns Absolute toplevel path of the linked worktree, or null.
 */
async function resolveLinkedWorktreeDir(): Promise<string | null> {
  try {
    const [gitDir, gitCommonDir, toplevel] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-dir']).then((r) => r.stdout.trim()),
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) => r.stdout.trim()),
      execFileAsync('git', ['rev-parse', '--show-toplevel']).then((r) => r.stdout.trim())
    ]);
    if (gitDir === gitCommonDir) return null;
    // git emits forward-slash paths even on Windows (`C:/Users/...`); normalize
    // to a native filesystem path so the resolved worktreeDir compares equal to
    // fs paths downstream (repo-match guard, unbound-candidate record key) and
    // reads correctly in the bind notices.
    return resolvePath(toplevel);
  } catch {
    // Not a git repository, or git unavailable — no linked worktree to bind.
    return null;
  }
}

const HELP = `Usage: cards [options] <command>

Read, create, list, search, and act on cards via the Cards API.
Locates the server through ~/.cards/cards-api.json, executes the command,
and prints the resulting Card JSON to stdout.

Options:
  -h, --help              Show this help text
  --jsonpath <expr>       Filter JSON output with a JSONPath expression.
                          Single primitive results are printed raw (no quotes);
                          object/array results and multi-match results are
                          printed as JSON. Supported on get, create, list,
                          search, variable-group list, and action subcommands.
                          Example: --jsonpath '$.repositoryPath'
  --include-actions       On a card fetch, also merge in the card environment's
                          action summaries as \`actions\`. Requires the invoking
                          checkout to be a registered editor workspace; without
                          it the card is read without action discovery.

Commands:
  <card-id>                      Fetch a card by its identifier
  create                         Create a card from JSON on stdin
  list [options]                 List cards with optional filters
  search [query] [options]       Search cards using #tag @relation text syntax
  variable-group list [options]  List safe variable-group summaries
  <card-id> action <action-id> [options]  Execute an action on a card
  <card-id> watch [glob...]     Wait for next unattributed commit
  <card-id> attach [options]    Attach an existing card to the current worktree
  <card-id> shutdown [options]  Signal agent shutdown to the running action
  html check [path...]          Validate card-repo HTML files

Get:
  Pass a card identifier as the sole argument. The full Card object is
  returned, including repositoryPath for filesystem access.

  Examples:
    cards feat-42
    cards main-0001

Create:
  Pipe a JSON object to stdin. Required fields: title (non-empty string).
  Optional fields: tags (string[]), environment (string),
  gates ({ planRequired?: boolean, mergeRequestRequired?: boolean }),
  relations ({ type: "related", cardId: string }[]).

  The response contains only server-generated fields not present in the
  input (e.g. id, status, timestamps), plus repositoryPath. Fields the
  caller already provided are omitted.

  Examples:
    cards create <<'EOF'
    { "title": "Fix auth", "tags": ["bug"] }
    EOF

List:
  Lists cards for the current workspace. Detects workspacePath from git
  automatically, or pass --workspace-path explicitly.

  Options:
    --workspace-path <path>  Workspace root (default: git rev-parse --show-toplevel)
    --status <status>        Filter by status (todo, active, needs_review, done, archived)
    --limit <n>              Maximum number of results
    --offset <n>             Pagination offset

  Examples:
    cards list
    cards list --status active
    cards list --limit 10

Search:
  Searches cards using a unified query syntax. Supports free text, #tag filters,
  and @relation filters. Derived tags (planning, merge-requested, merged, unmerged)
  are computed client-side.

  Options:
    --workspace-path <path>  Workspace root (default: git rev-parse --show-toplevel)
    --status <status>        Filter by status
    --limit <n>              Maximum number of results
    --offset <n>             Pagination offset

  Examples:
    cards search "login bug"
    cards search "#auth @main-5 login" --status active
    cards search "#planning" --limit 20
    cards search "@main-42"

Variable groups:
  Lists safe summary metadata for variable groups configured for the current
  workspace. Variable values, names, secret keys, and secret values are never
  included.

  Options:
    --workspace-path <path>  Workspace root (default: git rev-parse --show-toplevel)

  Example:
    cards variable-group list
    cards variable-group list --workspace-path /path/to/workspace

Action:
  Executes an action on a card via the server relay. The action ID is
  the lowercase identifier from the action definition (e.g., "launch").

  Options:
    --agent <id>            Use one supported coding agent for this action:
                             ${CODING_AGENT_IDS.slice(0, -1).join(', ')}, or ${CODING_AGENT_IDS[CODING_AGENT_IDS.length - 1]}.
    --background             Run the action in the background instead of
                             interactively. Omit for an interactive run
                             (the default). Rejected when the action does
                             not support background mode.
    --exit-when-done        Signal the agent to exit cleanly once the action
                             completes, instead of leaving the session open.
    --variable-group <id>   Use this variable group for this launch. Repeat to
                             preserve an ordered selection; no flag uses the
                             persisted selection.

  Examples:
    cards <card-id> action launch
    cards <card-id> action launch --agent codex-cli
    cards <card-id> action launch --background
    cards <card-id> action launch --background --exit-when-done
    cards <card-id> action launch --variable-group deploy --variable-group shared

Variable groups:
  Lists safe variable-group summaries for the selected workspace. Variable
  names, values, and secret material are never returned.

  Options:
    --workspace-path <path>  Workspace root (default: git rev-parse --show-toplevel)

  Examples:
    cards variable-group list
    cards variable-group list --workspace-path /path/to/workspace

Watch:
  Waits for the next unattributed commit on a card's repository. If
  unattributed commits already exist they are output immediately. Otherwise
  the command subscribes to WebSocket events and blocks until a qualifying
  commit arrives. Requires an active Cards session (CARDS_SESSION_ID set).

  Optional glob patterns restrict output to commits that touch at least one
  matching file. Multiple globs are OR-combined.

  The commit is attributed to the current session and printed to stdout,
  then the command exits 0. Exits non-zero on connection failure or when
  the session precondition is not met.

  Examples:
    cards <card-id> watch
    cards <card-id> watch "src/auth/**"
    cards <card-id> watch "src/**" "tests/**"

Attach:
  Attaches an existing card to the current worktree. Installs git hooks,
  registers the branch with the Cards API, and (when a transcript path is
  available) spawns transcript attribution. Outputs card-repo-log and
  workspace-repo-log context blocks to stdout so the calling agent receives
  current card context immediately.

  The command refuses (exits non-zero) when:
    - Not running inside a linked worktree (must be a "git worktree add" worktree)
    - The worktree is already bound to a card (shows the existing card id)
    - The card id does not resolve via the Cards API
    - No parent branch can be determined (use --parent-branch to supply one)

  Options:
    --parent-branch <ref>  Explicit parent branch (overrides git config and reflog detection)

  Examples:
    cards main-42 attach
    cards main-42 attach --parent-branch main

Html:
  Validates a card repo's HTML documents (any *.html outside attachments/):
  pairing, sidecar schema, well-formedness, and resource locality. Delegates to
  the extension's bundled check.mjs.

  Options:
    --staged                 Only check files staged for commit (used by
                             the pre-commit hook)

  Examples:
    cards html check
    cards html check [CARD_REPO_PATH]/docs/architecture-overview.html
    cards html check --staged

  Exit codes:
    0  All checks passed
    1  Content failure — fix the HTML file or sidecar

Shutdown:
  Tells Cards the agent reached a terminal state (after a merge, after
  recording a blocker, after all tasks are complete). Only works from an
  admitted action with protected runtime credentials. Exit 0 means the
  shared runtime durably accepted the request; termination remains a
  separately correlated lifecycle result.

  Options:
    --outcome <value>        One of success | blocked | error (default success;
                             last value wins if repeated)
    --message <text>         Optional free-text detail recorded with the
                             outcome (last value wins if repeated)

  Examples:
    cards "$CARD_ID" shutdown
    cards "$CARD_ID" shutdown --outcome blocked --message "waiting on review"

Exit codes:
  0  Success
  1  Error (missing arguments, invalid input, discovery failure, API error,
     or shutdown delivery failure)
  130  Interrupted (SIGINT)
  143  Terminated (SIGTERM)`;

/**
 * Connects to the Cards API via discovery and returns a configured client.
 *
 * @param workspacePath - Explicit workspace path override. Falls back to git root auto-detection.
 * @returns A connected CardsClient instance.
 * @throws When API discovery fails.
 */
export async function connectClient(workspacePath?: string): Promise<CardsClient> {
  const resolved = workspacePath ?? getGitRoot() ?? undefined;
  if (!resolved) {
    throw new Error('could not detect workspace path — pass --workspace-path or run from inside a git repository');
  }
  const info = await discoverApiInfo();
  if (!info) {
    throw new Error('API discovery failed — is the cards server running?');
  }
  return new CardsClient({
    baseUrl: `http://${info.host}:${info.port}`,
    accessToken: info.accessToken,
    workspacePath: resolved
  });
}

/**
 * Evaluates a JSONPath expression against a value and returns the formatted
 * output string.
 *
 * A single primitive result (string, number, boolean) is printed raw without
 * quoting — mirroring the behavior of `jq -r`. A single object or array
 * result is pretty-printed as JSON. When the expression matches multiple
 * values, all results are pretty-printed as a JSON array.
 *
 * @param value - The JSON-compatible value to query.
 * @param expression - A JSONPath expression (e.g. `$.repositoryPath`).
 * @returns The formatted string to print to stdout.
 */
export function applyJsonPath(value: unknown, expression: string): string {
  const results = JSONPath({ path: expression, json: value as object, wrap: true }) as unknown[];
  if (results.length === 1) {
    const only = results[0];
    if (typeof only === 'string') return only;
    if (typeof only === 'number' || typeof only === 'boolean' || only === null) return String(only);
    return JSON.stringify(only, null, 2);
  }
  return JSON.stringify(results, null, 2);
}

/**
 * Formats a value for stdout, applying a JSONPath filter when provided.
 *
 * @param value - The value to print.
 * @param jsonPath - Optional JSONPath expression to filter with.
 * @returns The formatted string.
 */
export function formatOutput(value: unknown, jsonPath?: string): string {
  if (jsonPath) return applyJsonPath(value, jsonPath);
  return JSON.stringify(value, null, 2);
}

/**
 * Fetches a card by ID and prints its metadata as JSON to stdout.
 *
 * The card read is self-contained: it never consults the environment settings
 * that back action discovery, so it succeeds wherever the core card route does,
 * including linked worktrees that are not registered editor workspaces.
 *
 * @param cardId - The card identifier to look up.
 * @param jsonPath - Optional JSONPath expression to filter the output.
 * @param includeActions - When true, additionally resolves the card
 *   environment's action summaries and merges them in as `actions`. Opt-in
 *   because the environments route requires a registered editor settings
 *   loader; requesting it explicitly surfaces that requirement as an error
 *   rather than silently dropping the summaries from an otherwise fine read.
 */
export async function getCard(cardId: string, jsonPath?: string, includeActions?: boolean): Promise<void> {
  const client = await connectClient();
  const card = await client.getCard(cardId);
  if (!includeActions) {
    console.log(formatOutput(card, jsonPath));
    return;
  }
  const environments = await client.getEnvironments();
  const actions =
    environments
      .find((environment) => environment.name === card.environment)
      ?.actions.map(({ id, name, description, supportsBackgroundMode }) => ({
        id,
        name,
        description,
        supportsBackgroundMode
      })) ?? [];
  console.log(formatOutput({ ...card, actions }, jsonPath));
}

/**
 * Reads all data from stdin as a UTF-8 string.
 *
 * @returns The complete stdin content.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Parsed result from card creation input.
 */
export interface ParsedCardInput {
  data: CardCreateData;
  /** Keys the caller explicitly provided — used to filter the create response. */
  inputKeys: Set<string>;
}

/**
 * Parses and validates card creation input from a raw JSON string.
 *
 * @param raw - Raw JSON string to parse.
 * @returns Validated card data, optional plan content, and the set of caller-provided keys.
 * @throws On invalid or missing fields.
 */
export function parseCardCreateInput(raw: string): ParsedCardInput {
  if (!raw.trim()) {
    throw new Error('expected JSON on stdin');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('invalid JSON on stdin');
  }

  if (typeof parsed['title'] !== 'string' || !parsed['title'].trim()) {
    throw new Error('missing required field "title"');
  }

  const validFields = new Set(['title', 'tags', 'environment', 'gates', 'relations']);
  const unknownFields = Object.keys(parsed).filter((k) => !validFields.has(k));
  if (unknownFields.length > 0) {
    const listed = unknownFields.map((f) => `"${f}"`).join(', ');
    throw new Error(`unknown fields: ${listed}. valid fields: ${[...validFields].join(', ')}`);
  }

  const inputKeys = new Set(Object.keys(parsed));

  const data: CardCreateData = {
    title: parsed['title']
  };

  if (Array.isArray(parsed['tags'])) {
    data.tags = parsed['tags'] as string[];
  }
  if (typeof parsed['environment'] === 'string') {
    data.environment = parsed['environment'];
  }
  if (parsed['gates'] != null && typeof parsed['gates'] === 'object') {
    const g = parsed['gates'] as Record<string, unknown>;
    data.gates = {
      ...(typeof g['planRequired'] === 'boolean' ? { planRequired: g['planRequired'] } : {}),
      ...(typeof g['mergeRequestRequired'] === 'boolean' ? { mergeRequestRequired: g['mergeRequestRequired'] } : {})
    };
  }
  if (Array.isArray(parsed['relations'])) {
    data.relations = parsed['relations'] as CardCreateData['relations'];
  }

  return { data, inputKeys };
}

/** Keys always included in the create response regardless of caller input. */
const CREATE_ALWAYS_INCLUDE = new Set(['id', 'repositoryPath']);

/**
 * Creates a card from JSON read on stdin and prints the result to stdout.
 *
 * The response contains only server-generated fields that the caller did not
 * provide, plus any keys in {@link CREATE_ALWAYS_INCLUDE}. This lets agents
 * learn the assigned id and repositoryPath without re-reading fields they
 * already know.
 *
 * @param args - CLI arguments after the `create` subcommand. Supports `--workspace-path`.
 */
export async function createCard(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const raw = await readStdin();
  const { data, inputKeys } = parseCardCreateInput(raw);
  const client = await connectClient(flags['workspace-path']?.[0]);

  // Resolve the bind target BEFORE creating the card. Creating a card is the
  // moment an unbound worktree becomes bound to it — but binding is fail-closed:
  // a target whose parent branch cannot be determined refuses rather than
  // guessing. If the gate would refuse, we must NOT mint a card, or the printed
  // recovery would orphan the first card and bind to a second on retry. So the
  // gate runs first.
  const bindTarget = await resolveBindTarget(flags['parent-branch']?.[0]);
  if (bindTarget.kind === 'refuse') {
    // Fail-closed: no card is created on a refusal, so a retry creates+binds
    // atomically with no duplicate. Diagnostic only; stdout stays empty.
    console.error(bindTarget.reason);
    process.exitCode = 1;
    return;
  }

  const card = await client.createCard(data);
  const full = card as unknown as Record<string, unknown>;

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (CREATE_ALWAYS_INCLUDE.has(key) || !inputKeys.has(key)) {
      filtered[key] = value;
    }
  }
  console.log(formatOutput(filtered, flags['jsonpath']?.[0]));

  // The gate already passed; outfit + spawn does not re-run it. An outfit
  // failure surfaces on stderr but never corrupts the create-result JSON above.
  if (bindTarget.kind === 'bind') {
    const createdId = full['id'];
    if (typeof createdId === 'string' && createdId.length > 0) {
      // Guard against cross-repo bind: when --workspace-path points to a
      // different repository than the cwd worktree, emit a stderr notice
      // and skip the bind rather than binding the wrong repo's worktree.
      const workspacePath = flags['workspace-path']?.[0] ?? getGitRoot();
      let shouldBind = true;
      if (workspacePath) {
        try {
          const [wsCommonDir, wtCommonDir] = await Promise.all([
            execFileAsync('git', ['-C', workspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then(
              (r) => r.stdout.trim()
            ),
            execFileAsync('git', [
              '-C',
              bindTarget.worktreeDir,
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir'
            ]).then((r) => r.stdout.trim())
          ]);
          if (wsCommonDir !== wtCommonDir) {
            console.error(
              `cards create: worktree ${bindTarget.worktreeDir} belongs to a different workspace than card ${createdId} — not binding.`
            );
            shouldBind = false;
          }
        } catch (err) {
          // Infrastructure error resolving git common dir — fall through to
          // normal bind. The pre-existing behavior is to bind, so don't
          // regress when git is unavailable. Log so the failure is observable.
          console.error(
            'cards create: failed to compare workspace and worktree repositories, proceeding with bind:',
            err
          );
        }
      }
      if (shouldBind) {
        await outfitCreatedWorktree(client, createdId, bindTarget);
      }
    }
  }
}

/**
 * Outcome of resolving the bind target for the current `cards create`.
 *
 * - `none` — not inside or pointed at an eligible unbound worktree (cwd is the
 *   main worktree, an already-bound worktree, or no unbound candidate matched
 *   the binder's session). The card is created untracked.
 * - `refuse` — a worktree was identified but the fail-closed gate denied it (no
 *   parent branch could be determined, or 2+ ambiguous candidates). The card
 *   must NOT be created; `reason` is the actionable stderr message.
 * - `bind` — the gate passed; the resolved worktree, parent branch, transcript,
 *   and the binder's own session are carried forward so
 *   {@link outfitCreatedWorktree} can outfit and spawn.
 */
type BindTarget =
  | { kind: 'none' }
  | { kind: 'refuse'; reason: string }
  | {
      kind: 'bind';
      worktreeDir: string;
      parentBranch: string;
      transcriptPath: string;
      sessionId: string;
      /**
       * Open runtime identifier for the binder's own session, resolved via
       * {@link resolveRuntime} alongside `sessionId`. `null` when the binder's
       * runtime cannot be determined (e.g. bound via a runtime with no
       * SessionSyncManifest adapter yet) — {@link outfitWorktreeForCard} treats
       * that as a degraded attribution skip, same as an unresolved transcript.
       */
      runtime: string | null;
    };

/**
 * Resolves the worktree `cards create` should bind, applying the fail-closed
 * gate WITHOUT creating a card. Two legs, cwd-primary then candidate-set
 * fallback:
 *
 * 1. **cwd-derivation (primary)** — if `process.cwd()` is a linked worktree
 *    (`git rev-parse --git-dir` ≠ `--git-common-dir`):
 *    - already bound (`.cards/CARD_ID` present) → `none`. Mints an untracked
 *      card, preserving nested-worktree binding inheritance (main-126).
 *    - otherwise → resolve the parent branch via {@link resolveCardsParentBranch}
 *      (git config → reflog → `--parent-branch` flag → refuse). The transcript
 *      and session come from the binder's own `CARDS_TRANSCRIPT_PATH` /
 *      `CARDS_SESSION_ID` env (env inheritance guarantees they are this agent's).
 *
 * 2. **candidate-set fallback** (run from outside the worktree) — read the
 *    per-session unbound-candidate set and keep only entries whose `sessionId`
 *    matches the binder's resolved session (main-115 SET semantics):
 *    - 0 → `none` (untracked card).
 *    - 1 → `bind`, with a LOUD stderr notice naming the worktree.
 *    - 2+ → `refuse`, listing every candidate; never silently pick most-recent.
 *
 * @param parentBranchFlag - Optional `--parent-branch` CLI flag value.
 * @returns The resolved bind target.
 */
async function resolveBindTarget(parentBranchFlag?: string): Promise<BindTarget> {
  // --- Leg 1: cwd-derivation primary ---
  const cwdWorktree = await resolveLinkedWorktreeDir();
  if (cwdWorktree) {
    // CARD_ID precedence: an already-bound worktree mints an untracked card
    // (nested-worktree inheritance, main-126). No bind.
    if (existsSync(join(cwdWorktree, '.cards', 'CARD_ID'))) {
      return { kind: 'none' };
    }

    const parent = await resolveCardsParentBranch(cwdWorktree, parentBranchFlag);
    if (parent.kind === 'refuse') {
      return { kind: 'refuse', reason: `cards create: ${parent.reason}` };
    }

    // Resolve session identity via the shared resolvers. resolveSessionId()
    // applies the full five-variable precedence chain with PID fallback;
    // resolveTranscriptPath() checks CARDS_TRANSCRIPT_PATH first, then falls
    // back to the unbound-candidate record for this worktree. Either resolver
    // returning an absent value is a degradation (outfit will warn-and-skip
    // transcript streaming) but is not a hard refuse.
    const sessionId = await resolveSessionId();
    if (sessionId === null) {
      return {
        kind: 'refuse',
        reason:
          'cards create: refusing to bind worktree — no session id could be resolved. ' +
          'Re-enter the worktree via the EnterWorktree tool, then run `cards create` again.'
      };
    }
    const transcriptPath = await resolveTranscriptPath(sessionId, cwdWorktree);
    const runtime = await resolveRuntime();

    return {
      kind: 'bind',
      worktreeDir: cwdWorktree,
      parentBranch: parent.parentBranch,
      transcriptPath,
      sessionId,
      runtime
    };
  }

  // --- Leg 2: candidate-set fallback ---
  const sessionId = await resolveSessionId();
  if (sessionId === null) {
    // No session — nothing to bind from the candidate set. Untracked card.
    return { kind: 'none' };
  }

  const candidates = (await readUnboundCandidates(sessionId)).filter((entry) => entry.sessionId === sessionId);

  if (candidates.length === 0) {
    return { kind: 'none' };
  }

  if (candidates.length > 1) {
    const list = candidates.map((c) => `  - ${c.worktreeDir}`).join('\n');
    return {
      kind: 'refuse',
      reason:
        `cards create: refusing to bind — ${candidates.length} unbound worktrees are registered for this session:\n` +
        `${list}\n` +
        'Run `cards create` from inside the specific worktree you want to bind so the target is unambiguous.'
    };
  }

  const candidate = candidates[0]!;
  const parent = await resolveCardsParentBranch(candidate.worktreeDir, parentBranchFlag);
  if (parent.kind === 'refuse') {
    return { kind: 'refuse', reason: `cards create: ${parent.reason}` };
  }

  // Loud stderr notice: the binder is not inside the worktree it is binding, so
  // make the target explicit rather than binding silently.
  console.error(`cards create: binding the single unbound worktree for this session: ${candidate.worktreeDir}`);

  const transcriptPath = await resolveTranscriptPath(sessionId, candidate.worktreeDir);
  const runtime = await resolveRuntime();

  return {
    kind: 'bind',
    worktreeDir: candidate.worktreeDir,
    parentBranch: parent.parentBranch,
    transcriptPath,
    sessionId,
    runtime
  };
}

/**
 * Outfits the resolved worktree as card-bound and spawns transcript
 * attribution. Called only after {@link resolveBindTarget} has passed the
 * fail-closed gate, so it does NOT re-run the gate.
 *
 * Delegates the full disk → API → attribution lifecycle to
 * {@link outfitWorktreeForCard}, the single orchestrator both creation-time and
 * bind-time paths funnel through (so they cannot drift). On success the worktree
 * is removed from the per-session unbound-candidate set so a later `cards create`
 * in the same session does not see it again.
 *
 * An outfit failure is reported to stderr but never propagates: the create
 * result must remain the sole stdout payload regardless of bind outcome.
 *
 * @param client - Connected CardsClient used to register the branch record.
 * @param cardId - The newly-created card's identifier.
 * @param target - The gate-passed bind target.
 */
async function outfitCreatedWorktree(
  client: CardsClient,
  cardId: string,
  target: Extract<BindTarget, { kind: 'bind' }>
): Promise<void> {
  const { worktreeDir, parentBranch, transcriptPath, sessionId, runtime } = target;
  try {
    const extensionPath = await resolveExtensionPath();
    const compiledScriptPaths = compiledHookScriptPaths(extensionPath);

    const outcome = await outfitWorktreeForCard(client, worktreeDir, {
      cardId,
      parentBranch,
      sessionId,
      transcriptPath,
      runtime: runtime ?? undefined,
      compiledScriptPaths
    });

    // Make a skipped activation observable. The disk + API phases succeeded —
    // the worktree is bound and the branch is registered — but if
    // outfitWorktreeForCard RETURNED a skipped outcome (e.g. the attribution
    // preflight could not resolve a known agent PID), the card was never
    // activated and is left bound-but-inert. Unlike a thrown error, that skip
    // does not reach the catch below, so without this it is completely silent:
    // the warn it emits goes only to a detached CLI stderr that no log captures.
    // Surface it on the create CLI's stderr naming the reason, mirroring the
    // fail-closed notice attachCard emits. The create path deliberately does NOT
    // exit non-zero — the card WAS created and the stdout JSON payload must
    // remain the sole machine-readable result — preserving the fail-open stance
    // for genuinely un-monitorable cases while making the cause visible.
    if (outcome && (outcome.activated === false || outcome.attribution === 'skipped')) {
      console.error(
        `cards create: worktree bound but card ${cardId} not activated (${outcome.reason ?? 'unknown reason'}).`
      );
    }

    // Bind succeeded — drop the candidate so it is not re-offered this session.
    await removeUnboundCandidate(sessionId, worktreeDir);
  } catch (error) {
    console.error('cards create: failed to bind worktree to card:', error instanceof Error ? error.message : error);
  }
}

/**
 * Detects the git repository root directory.
 *
 * @returns Absolute path to the repo root, or null if not in a git repo.
 */
function getGitRoot(): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    timeout: 3000
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Parses `--key value` pairs from a string array into a record.
 *
 * Accumulates multiple values for the same key (e.g. `--tag bug --tag feature`
 * produces `{ tag: ['bug', 'feature'] }`). Stops at the first positional
 * argument (one that doesn't start with `--`).
 *
 * Flags named in `booleanFlags` are valueless: their presence records
 * `['true']` and the following argument is not consumed.
 *
 * @param args - CLI argument array to parse.
 * @param booleanFlags - Names (without leading `--`) of valueless boolean flags.
 * @returns Parsed key-to-values pairs with the leading `--` stripped from keys.
 * @throws Error when a non-boolean flag is missing its value.
 */
function parseFlags(args: string[], booleanFlags?: ReadonlySet<string>): Record<string, string[]> {
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) break;
    const key = arg.slice(2);
    if (booleanFlags?.has(key)) {
      const existing = flags[key];
      if (existing) {
        existing.push('true');
      } else {
        flags[key] = ['true'];
      }
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag ${arg} requires a value`);
    }
    const existing = flags[key];
    if (existing) {
      existing.push(value);
    } else {
      flags[key] = [value];
    }
  }
  return flags;
}

/**
 * Lists cards for a workspace and prints the result as JSON to stdout.
 *
 * Detects `workspacePath` from the current git repository root unless
 * overridden via the `--workspace-path` flag. For tag filtering and full-text
 * search use the `search` subcommand instead.
 *
 * @param args - CLI arguments after the `list` subcommand.
 */
export async function listCards(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const client = await connectClient(flags['workspace-path']?.[0]);

  const options: ListCardsOptions = {};
  if (flags['status']) {
    options.status = flags['status'][0] as ListCardsOptions['status'];
  }
  if (flags['limit']) {
    const n = parseInt(flags['limit'][0]!, 10);
    if (Number.isNaN(n) || n <= 0) throw new Error('--limit must be a positive integer');
    options.limit = n;
  }
  if (flags['offset']) {
    const n = parseInt(flags['offset'][0]!, 10);
    if (Number.isNaN(n) || n < 0) throw new Error('--offset must be a non-negative integer');
    options.offset = n;
  }

  const cards = await client.listCards(options);
  console.log(formatOutput(cards, flags['jsonpath']?.[0]));
}

/**
 * Lists safe variable-group summaries for a workspace.
 *
 * @param args - CLI arguments after the `variable-group list` subcommand.
 */
export async function listVariableGroups(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const client = await connectClient(flags['workspace-path']?.[0]);
  const variableGroups = await client.listVariableGroups();
  console.log(formatOutput(variableGroups, flags['jsonpath']?.[0]));
}

/**
 * Dispatches commands beneath the `variable-group` CLI resource.
 *
 * @param args - CLI arguments beginning with the variable-group verb.
 */
export async function variableGroupCommand(args: string[]): Promise<void> {
  const [verb, ...verbArgs] = args;
  if (verb !== 'list') {
    throw new Error(verb ? `unknown variable-group verb "${verb}"` : 'missing variable-group verb; expected "list"');
  }
  await listVariableGroups(verbArgs);
}

/**
 * Searches cards using a unified query syntax supporting free text, #tag filters,
 * and @relation filters. Mirrors the web UI's useServerSearch pattern:
 *
 * 1. Parse query with `parseSearchQuery` to extract text, tags, and relations.
 * 2. Split tags into stored (sent to server) and derived (filtered client-side).
 * 3. Call `client.listCards` with text (≥3 chars), stored tags, and structural filters.
 * 4. Convert results to `CardListSummary[]` via `toCardListSummaries`.
 * 5. Apply `filterCardsByTags` client-side for derived tags and relation filters.
 * 6. Print final results as JSON to stdout.
 *
 * @param args - CLI arguments after the `search` subcommand. First positional
 *   argument (if not starting with `--`) is the query string; remaining
 *   arguments are flags.
 */
export async function searchCards(args: string[]): Promise<void> {
  // Extract the query as the first positional arg (if present), then parse flags from the rest.
  let query = '';
  let flagArgs = args;
  if (args.length > 0 && !args[0]!.startsWith('--')) {
    query = args[0]!;
    flagArgs = args.slice(1);
  }

  const flags = parseFlags(flagArgs);
  const client = await connectClient(flags['workspace-path']?.[0]);

  const { text, tags, relatedTo } = parseSearchQuery(query);

  // Split tags into stored (in card.tags) vs derived (computed from card properties).
  const derivedTagSet = new Set<string>(DERIVED_TAGS);
  const storedTags = tags.filter((t) => !derivedTagSet.has(t));
  const derivedTags = tags.filter((t) => derivedTagSet.has(t));

  const options: ListCardsOptions = {};
  if (text.length >= 3) {
    options.search = text;
  }
  if (storedTags.length > 0) {
    options.tags = storedTags;
  }
  if (flags['status']) {
    options.status = flags['status'][0] as ListCardsOptions['status'];
  }
  if (flags['limit']) {
    const n = parseInt(flags['limit'][0]!, 10);
    if (Number.isNaN(n) || n <= 0) throw new Error('--limit must be a positive integer');
    options.limit = n;
  }
  if (flags['offset']) {
    const n = parseInt(flags['offset'][0]!, 10);
    if (Number.isNaN(n) || n < 0) throw new Error('--offset must be a non-negative integer');
    options.offset = n;
  }

  const raw = await client.listCards(options);
  const summaries = toCardListSummaries(raw);
  const results = filterCardsByTags(summaries, derivedTags, relatedTo);
  console.log(formatOutput(results, flags['jsonpath']?.[0]));
}

/**
 * Builds a {@link CardCommit} from a commit SHA by querying git for metadata and file changes.
 *
 * @param sha - Full commit hash to resolve.
 * @param repositoryPath - Card repository path where git commands execute.
 * @returns Complete commit metadata with per-file diff.
 * @throws {Error} When the git log output is malformed.
 */
function buildCardCommit(sha: string, repositoryPath: string): CardCommit {
  // Get commit metadata
  const metaOutput = execFileSync(
    'git',
    ['log', '--no-walk', '--format=%H%x00%an%x00%ae%x00%s%x00%b%x00%aI%x00%D', sha],
    { cwd: repositoryPath, encoding: 'utf-8', timeout: 10000 }
  );

  const nulIdx = metaOutput.indexOf('\0');
  if (nulIdx === -1) {
    throw new Error(`Unexpected git log output for ${sha}`);
  }

  const parts = metaOutput.split('\0');
  const hash = (parts[0] ?? '').trim();
  const author_name = parts[1] ?? '';
  const author_email = parts[2] ?? '';
  const message = parts[3] ?? '';
  const body = parts[4] ?? '';
  const date = (parts[5] ?? '').trim();
  const refs = (parts[6] ?? '').trim();

  // Get file list with status
  const diffOutput = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', sha], {
    cwd: repositoryPath,
    encoding: 'utf-8',
    timeout: 10000
  });

  const files: CardCommit['diff']['files'] = [];
  for (const line of diffOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabParts = trimmed.split('\t');
    const status = tabParts[0] ?? '';
    if (status.startsWith('R') && tabParts.length >= 3) {
      files.push({ file: tabParts[2]!, status, from: tabParts[1]!, binary: false });
    } else if (tabParts[1]) {
      files.push({ file: tabParts[1], status, binary: false });
    }
  }

  return { hash, date, message, refs, body, author_name, author_email, diff: { changed: files.length, files } };
}

/**
 * Returns true when at least one file in the commit matches any of the provided globs.
 *
 * @param files - Changed file paths.
 * @param globs - Glob patterns to test against.
 * @returns `true` when at least one file matches at least one glob; `true` when globs is empty.
 */
function matchesGlobs(files: string[], globs: string[]): boolean {
  if (globs.length === 0) return true;
  return files.some((f) => globs.some((g) => minimatch(f, g)));
}

/**
 * Returns the changed file paths for a commit SHA.
 *
 * @param sha - Commit hash.
 * @param repositoryPath - Card repository path.
 * @returns Array of changed file paths relative to the repository root.
 */
function getCommitFiles(sha: string, repositoryPath: string): string[] {
  const output = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
    cwd: repositoryPath,
    encoding: 'utf-8',
    timeout: 10000
  });
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Waits for the next unattributed commit on a card's repository.
 *
 * Checks for existing unattributed commits first. If any exist, outputs them
 * and exits. Otherwise subscribes to WebSocket events and blocks until the
 * first qualifying commit arrives.
 *
 * Requires an active Cards session (`CARDS_SESSION_ID` set in the environment).
 *
 * @param cardId - The card identifier to watch.
 * @param globs - Optional glob patterns to filter qualifying commits by changed files.
 */
export async function watchCard(cardId: string, globs: string[]): Promise<void> {
  // 1. Resolve card
  const client = await connectClient();
  const card = await client.getCard(cardId);
  const repositoryPath = card.repositoryPath;

  // 2. Resolve session (optional — watch works without a session, just without attribution)
  const sessionId = (process.env['CARDS_SESSION_ID'] ?? '').trim() || null;
  if (!sessionId) {
    console.error('card watch: warning: CARDS_SESSION_ID not set. Watching for any commit.');
  }

  // 3. Check for existing unattributed commits (only when session is available)
  if (sessionId) {
    const headSha = readSessionHeadSha(sessionId);
    if (headSha) {
      const allCommits = getCommitsSince(repositoryPath, headSha);
      const sessionCommits = getSessionCommits(sessionId);
      const unattributed = getUnattributedCommits(allCommits, sessionCommits);

      const qualifying =
        globs.length > 0
          ? unattributed.filter((sha) => matchesGlobs(getCommitFiles(sha, repositoryPath), globs))
          : unattributed;

      if (qualifying.length > 0) {
        // 4. Output existing unattributed commits and exit
        for (const sha of qualifying) {
          const commit = buildCardCommit(sha, repositoryPath);
          await appendCommitToSession(sessionId, sha);
          console.log(formatCommit(commit));
        }
        return;
      }
    }
  }

  // 5. Subscribe to WebSocket events and wait for a qualifying commit
  const apiInfo = await discoverApiInfo();
  if (!apiInfo) {
    throw new Error('API discovery failed — is the cards server running?');
  }

  const wsUrl = `ws://${apiInfo.host}:${apiInfo.port}/events`;
  const accessToken = apiInfo.accessToken;

  const discover = async () => {
    const info = await discoverApiInfo();
    if (!info) return { error: 'cards-api.json not found or invalid' };
    return { wsUrl: `ws://${info.host}:${info.port}/events`, accessToken: info.accessToken };
  };

  const subscriber = new EventSubscriber({ wsUrl, accessToken, discover, maxReconnectAttempts: 10 });

  // Track disconnection for exhaustion detection
  let disconnectedAt: number | null = null;
  let exhaustionTimer: ReturnType<typeof setTimeout> | null = null;

  const unsubConnectionChange = subscriber.onConnectionChange((connected) => {
    if (connected) {
      disconnectedAt = null;
      if (exhaustionTimer) {
        clearTimeout(exhaustionTimer);
        exhaustionTimer = null;
      }
    } else {
      if (exhaustionTimer) {
        clearTimeout(exhaustionTimer);
        exhaustionTimer = null;
      }
      disconnectedAt = Date.now();
      // Schedule exhaustion check after max backoff + margin
      const maxBackoffMs = calculateBackoffMs(10);
      exhaustionTimer = setTimeout(() => {
        exhaustionTimer = null;
        if (disconnectedAt !== null) {
          subscriber.disconnect();
          console.error('Lost connection to Cards server after maximum reconnection attempts.');
          requestProcessExit(1);
        }
      }, maxBackoffMs + 1000);
    }
  });

  process.on('SIGINT', () => {
    unsubConnectionChange();
    subscriber.disconnect();
    requestProcessExit(130);
  });

  process.on('SIGTERM', () => {
    unsubConnectionChange();
    subscriber.disconnect();
    requestProcessExit(143);
  });

  const onCommit = async (event: CardCommitEvent): Promise<void> => {
    if (event.cardId !== cardId) return;
    if (isBookkeepingCommit(event.commit)) return;

    if (sessionId) {
      const currentSessionCommits = getSessionCommits(sessionId);
      if (currentSessionCommits.includes(event.commit.hash)) return;
    }

    if (globs.length > 0) {
      const files = event.commit.diff.files.map((f) => f.file);
      if (!matchesGlobs(files, globs)) return;
    }

    // Qualifying commit — record, format, output, exit
    if (sessionId) {
      try {
        await appendCommitToSession(sessionId, event.commit.hash);
      } catch (error) {
        console.error(
          `card watch: failed to record commit ${event.commit.hash}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    console.log(formatCommit(event.commit));
    unsubConnectionChange();
    subscriber.disconnect();
    requestProcessExit(0);
  };

  subscriber.on('card:commit', (event) => {
    onCommit(event).catch((err: unknown) => {
      console.error('card watch: error handling commit event:', err instanceof Error ? err.message : String(err));
      subscriber.disconnect();
      requestProcessExit(1);
    });
  });

  await subscriber.connect();
}

/**
 * Thin router for the `card html` subcommand.
 *
 * Resolves `dist/html-files/check.mjs` from the installed extension path via
 * `resolveExtensionPath()` (reads `~/.cards/EXTENSION_PATH`), then delegates
 * to it via `execFileSync` with passthrough stdio, propagating exit codes
 * 0/1/2 verbatim.
 *
 * Exit codes from `check.mjs`:
 * - 0: all checks passed
 * - 1: content failure (fix the HTML file or sidecar)
 * - 2: infrastructure failure (reinstall the extension)
 *
 * @param args - CLI arguments after the `html` subcommand (e.g. `['check', path]`).
 *   The leading `'check'` token is stripped before forwarding to check.mjs.
 */
async function htmlCommand(args: string[]): Promise<void> {
  const extensionPath = await resolveExtensionPath();
  const checkMjs = join(extensionPath, 'dist', 'html-files', 'check.mjs');

  if (!existsSync(checkMjs)) {
    process.stderr.write(`card html: check.mjs not found at ${checkMjs}. Reinstall or rebuild the Cards extension.\n`);
    process.exit(2);
  }

  // Resolve the Node.js binary: prefer VSCODE_NODE (written by the extension on
  // activation — same lookup as HybridStore.writeSharedHooks()), fall back to
  // the process's own Node binary.
  let nodeBin = process.execPath;
  const vsCodeNodePath = join(homedir(), '.cards', 'VSCODE_NODE');
  if (existsSync(vsCodeNodePath)) {
    try {
      const candidate = readFileSync(vsCodeNodePath, 'utf-8').trim();
      if (candidate) nodeBin = candidate;
    } catch {
      // Fall back to process.execPath
    }
  }

  // Strip the leading 'check' token if present — check.mjs parses process.argv[2..].
  const forwardArgs = args[0] === 'check' ? args.slice(1) : args;

  try {
    execFileSync(nodeBin, [checkMjs, ...forwardArgs], { stdio: 'inherit' });
  } catch (err) {
    // execFileSync throws a ChildProcessError when exit code is non-zero.
    // Propagate the exit code verbatim (1 = content failure, 2 = infra failure).
    const code = (err as NodeJS.ErrnoException & { status?: number }).status ?? 1;
    process.exit(code);
  }
}

/**
 * Executes an action on a card and prints the result to stdout.
 *
 * @param cardId - The card identifier.
 * @param actionName - The action identifier to execute.
 * @param opts - Execution identity and options parsed from the action subcommand flags.
 * @param opts.requestId - Stable original caller identity.
 * @param opts.messageId - Stable launch-message identity.
 * @param opts.jsonPath - Optional JSONPath expression to filter the output.
 * @param opts.background - When true (`--background`), runs the action in the
 *   background; otherwise the action runs interactively (the default). The
 *   server rejects a background request for an action that does not support it.
 * @param opts.exitWhenDone - When true (`--exit-when-done`), the spawned agent
 *   is signalled to exit once the action completes. Defaults to false.
 * @param opts.selectedAgent - Optional one-shot coding-agent override.
 * @param opts.variableGroupIds - Ordered one-shot variable-group selection.
 *   Omitted to preserve persisted selection; an empty array selects none.
 * @returns The canonical durable launch outcome.
 */
export async function executeAction(
  cardId: string,
  actionName: string,
  opts: {
    requestId: string;
    messageId: string;
    jsonPath?: string;
    background?: boolean;
    exitWhenDone?: boolean;
    selectedAgent?: CodingAgentId;
    variableGroupIds?: string[];
  }
): Promise<RuntimeActionLaunchResult> {
  const mode: ExecutionMode = opts.background ? 'background' : 'interactive';
  const client = await connectClient();
  const card = await client.getCard(cardId);
  const runtime = createRuntimeActionClient({
    discover: async () => {
      const info = await discoverApiInfo();
      return info ? { host: info.host, port: info.port, accessToken: info.accessToken } : null;
    }
  });
  const result = await runtime.launch(cardId, {
    requestId: opts.requestId,
    messageId: opts.messageId,
    params: {
      actionId: actionName,
      environmentName: card.environment ?? 'default',
      mode,
      exitWhenDone: opts.exitWhenDone ?? false,
      ...(opts.selectedAgent === undefined ? {} : { selectedAgent: opts.selectedAgent }),
      ...(opts.variableGroupIds === undefined ? {} : { variableGroupIds: opts.variableGroupIds })
    }
  });
  console.log(formatOutput(result, opts.jsonPath));
  if (result.status === 'rejected' || result.status === 'uncertain') process.exitCode = 1;
  return result;
}

interface CliActionOptions {
  jsonPath?: string;
  background?: boolean;
  exitWhenDone?: boolean;
  selectedAgent?: CodingAgentId;
  variableGroupIds?: string[];
}

interface CliActionIdentity {
  requestId: string;
  messageId: string;
}

function cliActionOperationDirectory(cardId: string, actionName: string, opts: CliActionOptions): string {
  const operation = JSON.stringify({ cardId, actionName, opts });
  const key = createHash('sha256').update(operation).digest('hex');
  return join(resolveGlobalCardsConfigDir(), 'runtime', 'cli-action-operations', key);
}

/**
 * Acquires the durable identity for an ordinary CLI action invocation.
 *
 * A temporary directory is populated before an atomic rename publishes it. A
 * concurrent or restarted invocation therefore observes either the complete
 * prior identity or wins publication of its own, never a partial record.
 *
 * @param cardId - Card identifier included in the operation key.
 * @param actionName - Action identifier included in the operation key.
 * @param opts - Immutable action options included in the operation key.
 * @returns The acquired identity and its durable operation directory.
 * @throws When persistent identity storage cannot be read or written.
 */
export function acquireCliActionIdentity(
  cardId: string,
  actionName: string,
  opts: CliActionOptions
): { identity: CliActionIdentity; operationDirectory: string } {
  const operationDirectory = cliActionOperationDirectory(cardId, actionName, opts);
  const identityPath = join(operationDirectory, 'identity.json');
  try {
    return {
      identity: JSON.parse(readFileSync(identityPath, 'utf8')) as CliActionIdentity,
      operationDirectory
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const identity = { requestId: randomUUID(), messageId: randomUUID() };
  const parent = join(resolveGlobalCardsConfigDir(), 'runtime', 'cli-action-operations');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.pending-${process.pid}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  writeFileSync(join(temporary, 'identity.json'), `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, operationDirectory);
    return { identity, operationDirectory };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
      throw error;
    }
    return {
      identity: JSON.parse(readFileSync(identityPath, 'utf8')) as CliActionIdentity,
      operationDirectory
    };
  }
}

/**
 * Executes an ordinary CLI action while retaining identity only for uncertain custody.
 *
 * @param cardId - Card identifier.
 * @param actionName - Action identifier.
 * @param opts - Immutable action options.
 */
export async function executeCliAction(cardId: string, actionName: string, opts: CliActionOptions): Promise<void> {
  const { identity, operationDirectory } = acquireCliActionIdentity(cardId, actionName, opts);
  const outcome = await executeAction(cardId, actionName, { ...identity, ...opts });
  if (outcome.status !== 'uncertain') rmSync(operationDirectory, { recursive: true, force: true });
}

/**
 * Valid outcomes for the `cards <card-id> shutdown` verb.
 */
export const SHUTDOWN_OUTCOMES = ['success', 'blocked', 'error'] as const;
type ShutdownOutcome = (typeof SHUTDOWN_OUTCOMES)[number];

/**
 * Signals "the agent is done" from inside a running action.
 *
 * Connects to the authenticated shared runtime using protected role
 * credentials and waits for durable acceptance. Endpoint addresses are
 * rediscovered and never persisted in the pending request marker.
 *
 * @param args - Flags after the verb: `--outcome <success|blocked|error>`
 *   (default `success`) and `--message <text>`.
 */
export async function runShutdownVerb(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  // Last value wins when a flag repeats, matching common CLI convention.
  const outcome = (flags['outcome']?.at(-1) ?? 'success') as ShutdownOutcome;
  if (!SHUTDOWN_OUTCOMES.includes(outcome)) {
    console.error(`cards shutdown: invalid --outcome "${outcome}". Valid outcomes: ${SHUTDOWN_OUTCOMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const message = flags['message']?.at(-1);

  const sessionId = await resolveSessionId();
  if (!sessionId) {
    console.error(
      `cards shutdown: no session id could be resolved (checked ${CARDS_ENV_VARS.CARDS_SESSION_ID}, ` +
        'CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, OPENCODE_RUN_ID, CURSOR_TRACE_ID, and agent PID) — ' +
        'shutdown readiness cannot be correlated.'
    );
    process.exitCode = 1;
    return;
  }

  const existing = readPendingShutdownRequest(sessionId);
  if (existing && (existing.outcome !== outcome || existing.message !== message)) {
    console.error(`cards shutdown: pending request ${existing.requestId} has different parameters.`);
    process.exitCode = 1;
    return;
  }
  const pending =
    existing ??
    ({
      version: 1,
      requestId: randomUUID(),
      messageId: randomUUID(),
      outcome,
      ...(message ? { message } : {})
    } as const);
  if (!existing) writePendingShutdownRequest(sessionId, pending);

  const info = await discoverApiInfo();
  if (!info) {
    console.error(`cards shutdown: runtime unavailable; retry request ${pending.requestId}.`);
    process.exitCode = 1;
    return;
  }
  const credential = loadRuntimeCredential('cli');
  const client = createRuntimeClientFromCredentialFile({
    role: 'cli',
    capabilities: { switchToInteractive: false, agentShutdown: false, strictDrainBarrier: false },
    outbox: createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) }),
    discover: async () => ({ host: info.host, port: info.port, accessToken: info.accessToken }),
    onMessage: () => undefined
  });
  try {
    const connected = await client.connect();
    if (connected.status !== 'connected') throw new Error(`runtime connection ${connected.status}`);
    const result = await client.send({
      type: 'execution.shutdownRequest',
      payload: { outcome, ...(message !== undefined ? { message } : {}) },
      messageId: pending.messageId,
      requestId: pending.requestId,
      execution: credential.execution,
      deadlineMs: 5_000
    });
    if (result.status !== 'accepted') {
      throw new Error(`${result.status}:${'reason' in result ? result.reason : 'not-accepted'}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`cards shutdown: acceptance unconfirmed for request ${pending.requestId} — ${detail}.`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

/**
 * The result of probing a worktree for card-bind evidence.
 */
interface BindDetection {
  /** Whether the worktree carries any card-bind evidence. */
  bound: boolean;
  /** The bound card's id, when it could be attributed; null otherwise. */
  cardId: string | null;
}

/**
 * Extracts the card id embedded in a cards-managed branch name.
 *
 * Card-bound worktrees check out branches named `cards/<cardId>/<n>` (the
 * workspace branch scheme), so the checked-out branch itself identifies the
 * card the worktree was bound to — the durable fallback when the
 * `.cards/CARD_ID` marker is lost or empty.
 *
 * @param branchName - The worktree's checked-out branch name.
 * @returns The embedded card id, or null when the branch is not cards-named.
 */
function cardIdFromBranchName(branchName: string): string | null {
  const match = /^cards\/([^\s/]+)\/\d+$/.exec(branchName);
  return match?.[1] ?? null;
}

/**
 * Probes a linked worktree for card-bind evidence and resolves the bound id.
 *
 * Evidence, in priority order:
 *
 * 1. The `.cards/CARD_ID` marker — the primary record
 *    {@link outfitWorktreeForCard} writes first.
 * 2. A per-worktree `core.hooksPath` equal to the cards shared hooks dir —
 *    the durable artifact outfit installs and `releaseWorktreeForCard`
 *    removes, which survives loss of the git-ignored `.cards/` marker
 *    (e.g. `git clean -fdx`).
 *
 * When the marker is missing or empty, the bound card id is derived from the
 * `cards/<cardId>/<n>` branch name. A bound-but-unattributable worktree is
 * still reported as bound (fail closed) with `cardId: null` — attaching a
 * different card over it would overwrite the surviving binding.
 *
 * Runs before `connectClient()` opens any socket, so the refusal it drives
 * stays synchronous and local: no server-side error (e.g. a
 * workspace-registration failure) can ever substitute for the already-bound
 * message.
 *
 * @param worktreeDir - Absolute path of the linked worktree.
 * @returns The bind detection result; `{ bound: false }` when no evidence exists.
 */
async function detectBoundCard(worktreeDir: string): Promise<BindDetection> {
  const cardIdFile = join(worktreeDir, '.cards', 'CARD_ID');
  if (existsSync(cardIdFile)) {
    const markerId = readFileSync(cardIdFile, 'utf-8').trim();
    if (markerId.length > 0) {
      return { bound: true, cardId: markerId };
    }
  } else {
    let hooksPath: string | null = null;
    try {
      const { stdout } = await execFileAsync('git', ['-C', worktreeDir, 'config', 'core.hooksPath'], {
        timeout: 5_000
      });
      hooksPath = stdout.trim() || null;
    } catch {
      // `git config` exits 1 when the key is unset — expected. Any other
      // failure means the directory is not a readable repo (gate 1 has
      // already ruled that out); treat it as no evidence rather than crash.
      hooksPath = null;
    }
    if (!hooksPath || resolvePath(hooksPath) !== resolvePath(cardsSharedHooksDir())) {
      return { bound: false, cardId: null };
    }
  }

  // Bound without a usable marker id — derive from the checked-out branch.
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5_000
    });
    return { bound: true, cardId: cardIdFromBranchName(stdout.trim()) };
  } catch {
    return { bound: true, cardId: null };
  }
}

/**
 * Attaches an existing card to the current worktree.
 *
 * Applies four fail-closed gates before any state change:
 *
 * 1. Must be inside a linked worktree (not the main worktree).
 * 2. The worktree must not already be bound to a card.
 * 3. The card ID must resolve via the Cards API.
 * 4. A parent branch must be determinable.
 *
 * On pass, calls {@link outfitWorktreeForCard} with the resolved session,
 * transcript, and parent branch, then outputs card-repo-log and workspace-repo-log
 * context blocks to stdout so the calling agent receives current card context.
 *
 * Fail-closed on skipped activation: if the outfit's attribution outcome
 * reports that session activation was skipped (lock held, card not
 * activatable, or a preflight failure), attach prints a "branch registered but
 * card not activated" diagnostic to stderr and exits non-zero instead of
 * printing the success payload.
 *
 * @param cardId - The card identifier to attach to the current worktree.
 * @param parentBranchFlag - Optional `--parent-branch` flag value.
 */
export async function attachCard(cardId: string, parentBranchFlag?: string): Promise<void> {
  // Gate 1: must be inside a linked worktree.
  const worktreeDir = await resolveLinkedWorktreeDir();
  if (!worktreeDir) {
    console.error(
      'cards attach: not in a linked worktree. Run this command from inside a worktree created with `git worktree add`.'
    );
    process.exit(1);
  }

  // Gate 2: worktree must not already be bound. The bind probe consults the
  // `.cards/CARD_ID` marker and, when it is missing or empty, the durable
  // per-worktree hooks evidence outfit leaves behind — a bound worktree must
  // always refuse LOCALLY, before any client connection, so no server-side
  // error (e.g. a workspace-registration failure) can ever substitute for
  // this message.
  const bound = await detectBoundCard(worktreeDir);
  if (bound.bound) {
    console.error(
      bound.cardId !== null
        ? `cards attach: this worktree is already bound to card ${bound.cardId}. ` +
            `To attach a different card, remove this worktree and create a new one.`
        : 'cards attach: this worktree is already bound to a card (its id could not be determined — ' +
            'the .cards/CARD_ID marker is missing or empty). To attach a different card, remove this ' +
            'worktree and create a new one.'
    );
    process.exit(1);
  }

  // Gate 3: card must resolve via the API.
  //
  // From here on, `connectClient()` has opened a `CardsClient` HTTP keep-alive
  // socket. A synchronous `process.exit` while that socket (or undici's
  // threadpool async handles) is still tearing down trips the fatal libuv
  // assertion `!(handle->flags & UV_HANDLE_CLOSING)` (`src/win/async.c`) and
  // aborts with `0xC0000409` on Windows — even though the gate's error already
  // printed. So every post-connection refusal sets `process.exitCode = 1` and
  // `return`s; the top-level `.then` handler then calls `requestProcessExit`,
  // which drains the loop and force-exits via an unref'd backstop only if a
  // handle lingers. (Gates 1 & 2 above run BEFORE `connectClient`, so their
  // direct `process.exit` is race-free and left as-is.)
  const client = await connectClient();
  let cardRepoPath: string;
  try {
    const card = await client.getCard(cardId);
    cardRepoPath = card.repositoryPath;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') {
      console.error(`cards attach: card "${cardId}" not found.`);
    } else if (error instanceof NetworkError) {
      console.error(
        `cards attach: card service unavailable — check that the extension/daemon is running. (${error.message})`
      );
    } else {
      console.error(`cards attach: unable to fetch card "${cardId}".`, error);
    }
    process.exitCode = 1;
    return;
  }

  // Gate 4: parent branch must be determinable.
  const parent = await resolveCardsParentBranch(worktreeDir, parentBranchFlag);
  if (parent.kind === 'refuse') {
    console.error(`cards attach: ${parent.reason}`);
    process.exitCode = 1;
    return;
  }

  // All gates passed — resolve session identity then outfit.
  const sessionId = await resolveSessionId();
  if (sessionId === null) {
    console.error(
      'cards attach: refusing to attach worktree — no session id could be resolved. ' +
        'Re-enter the worktree via the EnterWorktree tool, then run `cards <id> attach` again.'
    );
    process.exitCode = 1;
    return;
  }

  const transcriptPath = await resolveTranscriptPath(sessionId, worktreeDir);
  if (!transcriptPath) {
    console.error(
      'cards attach: warning: transcript path could not be resolved — session streaming is disabled for this attach.'
    );
  }

  const runtime = await resolveRuntime();

  const extensionPath = await resolveExtensionPath();
  const compiledScriptPaths = compiledHookScriptPaths(extensionPath);

  const outcome = await outfitWorktreeForCard(client, worktreeDir, {
    cardId,
    parentBranch: parent.parentBranch,
    sessionId,
    transcriptPath,
    runtime: runtime ?? undefined,
    compiledScriptPaths
  });

  // Fail closed: at this point the branch is registered, but if session
  // activation was skipped (de-dupe lock held by another card, card not in an
  // activatable status, or an attribution preflight failed) the attach must not
  // masquerade as a plain success — surface the partial state on stderr and
  // exit non-zero so scripted callers can detect it.
  if (outcome && (outcome.activated === false || outcome.attribution === 'skipped')) {
    console.error(`cards attach: branch registered but card not activated (${outcome.reason ?? 'unknown reason'}).`);
    // Post-connection (the client + `outfitWorktreeForCard` opened sockets) —
    // set the code and return so the top-level `requestProcessExit` drains the
    // loop instead of a synchronous `process.exit` racing libuv (0xC0000409).
    process.exitCode = 1;
    return;
  }

  // Drop the candidate record so a later `cards create` in the same session
  // does not re-offer this worktree.
  await removeUnboundCandidate(sessionId, worktreeDir);

  // Output context blocks so the calling agent receives current card context.
  const repoRoot = getGitRoot() ?? worktreeDir;
  const logBlock = buildCardRepoLogBlock(cardRepoPath);
  const workspaceLogBlocks = buildWorkspaceRepoLogBlocks(repoRoot, cardRepoPath);

  const parts: string[] = [];
  if (logBlock) parts.push(logBlock);
  parts.push(...workspaceLogBlocks);
  if (parts.length > 0) {
    console.log(parts.join('\n\n'));
  }
}

if (process.argv[1]?.match(/cards\.(mjs|ts)$/)) {
  const command = process.argv[2];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    process.exit(command ? 0 : 1);
  }

  const subArgs = process.argv.slice(3);
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  let run: Promise<void>;
  // `watch` is intentionally long-running: it blocks on the WebSocket and drives
  // its own exit from its commit/connection/signal handlers. Every other command
  // is one-shot and must exit once its work settles (see the run handler below).
  let isWatch = false;
  switch (command) {
    case 'html':
      run = htmlCommand(process.argv.slice(3));
      break;
    case 'create':
      run = createCard(process.argv.slice(3));
      break;
    case 'list':
      run = listCards(process.argv.slice(3));
      break;
    case 'search':
      run = searchCards(process.argv.slice(3));
      break;
    case 'variable-group':
      run = variableGroupCommand(process.argv.slice(3));
      break;
    default: {
      // Resource-first: <card-id> [verb]
      const verb = process.argv[3];
      if (verb === 'action') {
        const actionId = process.argv[4];
        if (!actionId) {
          console.error('cards action: missing action ID argument');
          process.exit(1);
        }
        run = Promise.resolve().then(() => {
          const actionFlags = parseFlags(process.argv.slice(5), new Set(['background', 'exit-when-done']));
          const selectedAgent = actionFlags['agent']?.[0];
          if (selectedAgent !== undefined && !isCodingAgentId(selectedAgent)) {
            throw new Error(`invalid coding agent "${selectedAgent}"; expected one of: ${CODING_AGENT_IDS.join(', ')}`);
          }
          return executeCliAction(command, actionId, {
            jsonPath: actionFlags['jsonpath']?.[0],
            background: actionFlags['background'] !== undefined,
            exitWhenDone: actionFlags['exit-when-done'] !== undefined,
            selectedAgent,
            variableGroupIds: actionFlags['variable-group']
          });
        });
      } else if (verb === 'watch') {
        const watchGlobs = process.argv.slice(4);
        run = watchCard(command, watchGlobs);
        isWatch = true;
      } else if (verb === 'attach') {
        const attachFlags = parseFlags(process.argv.slice(4));
        run = attachCard(command, attachFlags['parent-branch']?.[0]);
      } else if (verb === 'shutdown') {
        run = runShutdownVerb(process.argv.slice(4));
      } else if (verb?.startsWith('--')) {
        const getFlags = parseFlags(process.argv.slice(3), new Set(['include-actions']));
        run = getCard(command, getFlags['jsonpath']?.[0], getFlags['include-actions'] !== undefined);
      } else if (verb) {
        console.error(`cards: unknown verb "${verb}"`);
        process.exit(1);
      } else {
        run = getCard(command);
      }
      break;
    }
  }

  run
    .then(() => {
      // One-shot commands must not rely on the event loop draining naturally:
      // the `CardsClient`'s HTTP (fetch/undici) keep-alive socket can keep the
      // loop alive on Windows long after the result printed — `cards list` was
      // observed hanging for tens of minutes. `requestProcessExit` sets the exit
      // code and lets the loop drain, with an unref'd backstop that force-exits
      // if a handle lingers — bounding teardown without the synchronous
      // `process.exit` that races libuv (0xC0000409). `watch` self-manages, so
      // its `connect()` resolving here must NOT trigger an exit.
      if (!isWatch) {
        requestProcessExit(typeof process.exitCode === 'number' ? process.exitCode : 0);
      }
    })
    .catch((error: unknown) => {
      console.error('card:', formatErrorForCli(error));
      requestProcessExit(1);
    });
}
