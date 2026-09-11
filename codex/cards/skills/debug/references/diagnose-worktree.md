# Diagnosing Worktree Issues

Scope: worktree creation, binding, outfit, and cleanup for Cards-managed worktrees and card-bound sessions.

## Quick Diagnostics

```bash
# List Cards-managed worktrees
find ~/.cards/worktrees -maxdepth 3 -type d 2>/dev/null

# Check if current directory is a worktree
git rev-parse --git-dir 2>/dev/null
git rev-parse --git-common-dir 2>/dev/null
# Linked worktree: git-dir ≠ git-common-dir

# Check if worktree is card-bound
cat .cards/CARD_ID 2>/dev/null || echo "not card-bound"
git config "branch.$(git branch --show-current).cardsParent" 2>/dev/null || echo "no parent branch recorded"
echo "CARDS_SESSION_ID=${CARDS_SESSION_ID:-not set}"

# Check for bind locks (stale locks block binding)
ls ~/.cards/bind-locks/ 2>/dev/null
```

## Per-Worktree `.cards/` Files

| File | Written by | Read by | Contents |
|------|-----------|---------|----------|
| `CARD_ID` | `writeCardBoundFile()` in `worktree.ts` | `cards attach`, `remove-worktree`, watchers | Card ID string |
| `CARD_ORIGINAL_HOOK_PATH` | `outfitWorktreeForCard()` (guarded snapshot — never overwritten on re-run) | Restoration on unbind | Original `core.hooksPath` value |

The parent branch is not a `.cards/` file: `outfitWorktreeForCard()` records it as durable git config `branch.<name>.cardsParent` via `writeCardsParentConfig()`.

Session identity is tracked as the `CARDS_SESSION_ID` environment variable (persisted by the SessionStart hook via `persistSessionEnv()`), not as a `.cards/` file. Active sessions are monitored through `~/.cards/adhoc-active/{cardId}/{sessionId}.ref` files.

## Bind Lock Mechanism

**Path**: `~/.cards/bind-locks/{sha256(worktreeDir)}.lock`

Cross-process advisory lock preventing two processes from binding the same worktree. The lock file is empty — its existence is the signal. `outfitWorktreeForCard()` acquires it around the bind's API phase and releases it in a `finally` block when the bind completes.

**Source**: `public/packages/sdk/src/worktreeForCard.ts`::`resolveBindLockPath()`.

## Shared Hooks Directory

**Path**: `~/.cards/workspace-hooks/`

A global dispatcher directory shared by all worktrees. `provisionSharedHooksDir()` (in `worktree.ts`) writes one bash dispatcher script per client-side git hook type plus a copy of each compiled Cards `.mjs` — atomic writes, content-addressed skip. Outfit then sets the worktree's `core.hooksPath` (a `--worktree` config write) to this directory so Cards hook behavior applies only within that worktree.

## Failure Modes

Ranked by probability:

### Worktree Creation Fails (Collision) — HIGH probability

**Evidence**: `create-worktree` exits with code 2. Error: ref already has a worktree at the computed path.

**Cause**: The ref (branch/tag/SHA) already has a worktree at `~/.cards/worktrees/{repoId}/{ref}/`.

**Recovery**: Use `git worktree list` to inspect existing worktrees. Remove with `remove-worktree <path>` if stale — **safe**.

**Looks like, but isn't**: A git worktree managed outside Cards (manual `git worktree add`) can exist at the same ref but different path — `git worktree list` shows all.

**Post-fix verification**: `create-worktree` succeeds. `git worktree list` shows the new entry.

### Attach Fails (Already Bound) — HIGH probability

**Evidence**: `cards <id> attach` fails. `.cards/CARD_ID` already exists in the worktree with a different card ID — or, if that marker is missing or empty, `core.hooksPath` still points at the cards shared hooks dir.

**Cause**: A worktree can only be bound to one card. The worktree was previously bound and not cleaned up. The bind probe checks `.cards/CARD_ID` first and falls back to the durable hooks-dir evidence when the marker is missing or empty, so the gate still refuses locally — before any client connection — even after the marker is lost.

**Recovery**: Remove the existing `.cards/CARD_ID` only if the previous bind is stale (no active session). Check `~/.cards/adhoc-active/{cardId}/` for live ref files — if all ref PIDs are dead, the bind is stale and the file can be safely removed.
**Risk**: **risky — removing CARD_ID during an active session breaks attribution and triggers orphan cleanup**.

### Attach Fails (Lock Held) — MEDIUM probability

**Evidence**: `cards <id> attach` hangs or fails. A bind-lock file exists at `~/.cards/bind-locks/{sha256(worktreeDir)}.lock`.

**Cause**: Another bind operation is in progress, or a previous bind crashed and left a stale lock.

**Recovery**: Check if a bind operation is running (`ps aux | grep bind`). If no bind is in progress, remove the lock file manually.
**Risk**: **risky — removing a live lock causes double-bind**. Verify no bind operation is running first.

**Post-fix verification**: `cards <id> attach` succeeds. `.cards/CARD_ID` contains the card ID.

### Hooks Not Running in Worktree — MEDIUM probability

**Evidence**: Git operations in the worktree don't trigger Cards hooks. `git config core.hooksPath` returns something other than the shared hooks directory.

**Cause**: `core.hooksPath` wasn't set during outfit, or the shared hooks directory wasn't provisioned.

**Recovery**: Rerun `cards <id> attach` to re-outfit the worktree — **safe**. Check `.cards/CARD_ORIGINAL_HOOK_PATH` for the previous value.

### Worktree Contents Not Isolated (Path Policy) — MEDIUM probability

**Evidence**: `create-worktree` exits 3. The worktree is missing paths that should be shared, has symlinks where real files should be, or contains generated output that should be omitted.

**Cause**: `.worktreeignore` (omit) and `.worktreeinclude` (copy) at the invoking checkout root configure ignored source content. `create-worktree` locates the nearest checkout root above its working directory; from a linked worktree it therefore reads and copies from that linked checkout, not the primary checkout behind the common Git directory. The policy is rebuilt for every creation.

### Exact policy contract

- **Eligibility** — discovery uses `git ls-files --ignored --exclude-standard --directory --others` in that source checkout. Consequently repository ignore files, Git's repository-local `info/exclude`, and configured global excludes participate. Tracked paths are supplied by normal checkout and never copied; untracked non-ignored paths are not provisioned. `.worktreeinclude` is a selector over existing ignored entries, not an existence manifest.
- **Independent matchers** — each policy file is loaded into its own `ignore` matcher. Within one file, gitignore ordering and `!` negation apply, including the rule that a child cannot be re-included while its parent remains excluded; a negation in one file cannot alter the other matcher's result. Leading `/` is relative to the source root. The matcher supports the gitignore/wildmatch forms implemented by the `ignore` package (`**`, character classes, escaped `#`/`!`, directory patterns, and trailing-space escaping). Before matcher input, blank lines and lines whose trimmed form begins `#` are removed.
- **Precedence** — omit is tested before copy. A leaf matching both is omitted and is excluded from the copy set before copy-ancestor calculation. Therefore matching include and ignore rules for the same leaf do **not** constitute a supported ancestor-rerouting trick.
- **Collapsed ignored directories** — Git reports a directory ignored as a unit as one collapsed entry. The loader enumerates its ignored descendants when either policy has patterns. An omitted descendant makes that whole directory absent unless at least one *different, non-omitted* descendant survives into the copy set. A surviving copy match prevents the collapsed ancestor symlink and materializes only matching ignored files; ordinary unmatched siblings remain absent at every depth. They are not individually shared beneath the real ancestor.
- **Directory include rules** — a rule such as `dir/` selects each enumerated ignored file beneath it; the executor itself skips directory entries. Tracked descendants remain from ordinary Git checkout, selected ignored files/symlinks are added with parents created as needed, and untracked non-ignored descendants remain absent. Selected source symlinks are recreated rather than dereferenced.
- **`node_modules` specialization** — root and workspace-package `node_modules` trees are rerouted per entry. A ruled ancestor becomes a real directory; omitted entries stay absent, copied files are left for the include executor, and share siblings are symlinked. This is the exception to ordinary collapsed-directory sibling absence. It also sees through ignored and tracked package symlinks within owned workspace `node_modules` trees; a tracked `node_modules`-segment symlink outside those trees fails closed because the rerouter cannot enforce its interior policy.
- **Symlink copy semantics** — `readlink` target text is passed unchanged to `symlink`; it is not dereferenced or rewritten. A relative target therefore intentionally resolves relative to the new link location. Regular-file mode bits are preserved. Windows privilege failure is fatal rather than converted to a different shape.
- **Races** — a listed path absent during enumeration is not selected even if it appears later. A selected source entry that disappears before `lstat` is silently skipped. Other stat, parent creation, copy, chmod, readlink, or symlink errors fail closed.
- **Policy files** — they need not be tracked or regular files. Absence means no patterns, and a non-dangling symlink is followed. A directory, unreadable target, dangling policy-file symlink, invalid matcher input, or other load failure is a `WorktreeIncludeError`. “Dangling symlink at a config path” refers to `.worktreeignore` or `.worktreeinclude` itself, not a matched source symlink.
- **Deadlines** — the initial `discoverIgnoredPaths()` Git scan has its own fixed 30-second timeout and does not use `CARDS_WORKTREE_POLICY_TIMEOUT_MS`. Once configs are loaded, one environment-controlled budget (default `30000` ms) is shared across per-directory Git scans, tracked-symlink scanning, workspace discovery, and see-through filesystem walks; each Git call is additionally killed when its remaining window expires. Invalid non-positive/non-numeric overrides fail closed.
- **Failure classification, timing, and cleanup** — config loading and the environment-controlled policy-expansion enumeration throw `WorktreeIncludeError` and map to exit 3. The separate initial ignored-path discovery scan is a general failure and maps to exit 2. Both finish before any policy-controlled source path is linked, although `git worktree add`, Git-config preparation, or unrelated `.cards` setup may already have begun. A later policy provisioning failure maps to exit 3 and can happen after some policy paths were linked or copied. Settle waits for in-flight work, then removes the partial directory and Git registration and deletes only a branch that invocation created. Cleanup failure is reported and leaves manual recovery work.
- **Same materializer in both modes** — offline and card-bound creation call the same path-policy materializer. The effective card ID is an explicit, nonempty `--card-id`, otherwise the trimmed `.cards/CARD_ID` at the nearest invoking Git checkout; ambient `CARD_ID` never selects it, and discovery stops before any containing checkout when invoked from a nested repository. No effective ID means offline. The card-bound path adds API registration, optional `--parent-branch` lineage, hooks, and attribution around materialization.
- **No preflight command** — there is no supported dry-run or classification CLI. Verify inputs with Git and inspect the created filesystem; internal `classify()` is not a public command.

**Recovery**:
```bash
# Run from the checkout that will be the materialization source
git rev-parse --show-toplevel
ls -la "$(git rev-parse --show-toplevel)"/.worktreeignore "$(git rev-parse --show-toplevel)"/.worktreeinclude
# What the source considers ignored (must match the policy's input)
git check-ignore -v <path>
# What the worktree actually contains
ls -la <worktree>/<path>
readlink <worktree>/<path>    # symlink = shared, or a recreated copy of a source symlink
stat -c '%F %a' <worktree>/<path>  # regular file = copied (or checked out); mode is preserved on copy
git ls-files --error-unmatch <path>  # exits 0 = tracked, so never copied whatever the include file says
```
Fix the pattern or file permissions, then re-run `create-worktree` — there is no policy cache. Failed settle normally cleans the directory, Git registration, and a branch created by that invocation; a pre-existing branch remains. If cleanup reports failure, remove the named leftover with `remove-worktree <path>` before retrying. **Risk**: **safe**.

**Post-fix verification**: `create-worktree` exits 0. Its JSON has numeric `copiedFromInclude` and `reroutedSymlinks` counts, not path lists: the former counts files/source symlinks actually written by the include executor; the latter counts internal workspace symlinks recreated by the `node_modules` rerouter. Neither reports every matched leaf or materialized ancestor. Inspect paths directly: omitted paths have no entry; copied regular files are real with source mode; copied symlinks remain symlinks; unmatched top-level ignored paths are shared symlinks; ordinary siblings below a copy-rerouted collapsed directory are absent; rerouted `node_modules` may contain individually shared siblings.

### Symlink Privilege Denied (Windows) — LOW probability

**Evidence**: On Windows, creation fails with a `SymlinkPrivilegeError` or a `WorktreeIncludeError` naming a symlink destination (`EPERM`/`EINVAL` underneath).

**Cause**: Provisioning shares git-ignored paths as symlinks and recreates source symlinks in the copy set, and Windows grants symlink creation only under Developer Mode or an elevated session. Creation fails closed rather than degrading to a copy, which would diverge worktree semantics from macOS/Linux.

**Recovery**: Enable Settings > System > For developers > Developer Mode (or run elevated), then re-run `create-worktree`. **Risk**: **safe**.

**Post-fix verification**: `create-worktree` exits 0 and the named destination exists as a symlink.

### Worktree Path on Windows — LOW probability

**Evidence**: Path mismatch between `git worktree list` output (forward slashes) and filesystem (backslashes).

**Cause**: Git emits forward-slash paths even on Windows. All consumers normalize via `path.resolve()`.

**Recovery**: No action needed — the code handles this. If a path comparison fails, run both sides through `path.resolve()`. **Risk**: **safe**.

### `create-worktree` Fails (Selected Card, Server Unreachable) — LOW probability

**Evidence**: `create-worktree --card-id <id>` or flagless `create-worktree` from a card-bound checkout fails because it can't reach the Cards API server.

**Cause**: An effective card ID requires complete card provisioning. Explicit `--card-id` wins; otherwise a marker inherited from the nearest invoking checkout selects the card. The CLI fails closed if registration, marker creation, hooks, attribution, or parent lineage cannot complete, and emits success JSON only after all of them are ready. An unbound invoking checkout has no effective card ID and stays fully offline; ambient `CARD_ID` does not change either result.

**Recovery**: Verify the server is running (load `diagnose-server-health.md`). If offline creation is intended, invoke the command from an unbound checkout; moving into a nested repository also establishes its own checkout boundary, but do not use that accidentally to evade a required binding. **Risk**: **safe**.

## Escalation

File a bug report — load `interview-issue-report.md`, then `issue-report-guide.md`. Escalate if:
- **Bind lock persists after confirming no bind operation is running**: Include `ls -la ~/.cards/bind-locks/` and `git worktree list`.
- **Worktree creation consistently fails with no collision**: Include `create-worktree` stderr output and the worktree directory listing.
- **Worktree contents wrong or creation exits 3 (path policy)**: Include `cat .worktreeignore` / `cat .worktreeinclude` (redacted), the `create-worktree` stderr, and `ls -la` of the affected worktree paths.
- **Hooks refuse to run after multiple re-outfit attempts**: Include `git config core.hooksPath` and `cat .cards/CARD_ORIGINAL_HOOK_PATH`.
- **Worktree removal fails with `git worktree remove`**: Include `git worktree list` and the specific error from `rm -rf` fallback.

## Out of Scope

- CLI implementation details → `inspect-cli-tools.md`
- Session identity and state → `find-session-state.md`
- Platform-specific path normalization → `platform-reference.md`
- Server health (prerequisite for card-bound worktree creation) → `diagnose-server-health.md`
