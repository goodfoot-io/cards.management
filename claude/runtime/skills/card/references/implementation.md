
<instructions>

## 1. Prepare Environment

Pin the baseline tag at HEAD. The baseline does not advance during implementation; if the tag already exists, leave it where it is — you are resuming from a prior checkpoint.

```bash
git tag "implement/$CARD_ID/baseline" HEAD  # skip if the tag already exists
```

## 2. Implement

Check `plans/` in the card repository for plan files.

- **Plan file(s) exist**: Execute the plan's tasks. When multiple plan files exist, treat the one with the most recent commit touching it as layering on top of older ones (`git log -1 --format=%H -- plans/<file>`). Do not rewrite the plan while implementing it — if it turns out to be wrong, see `<when-to-return-to-planning>`.
- **No plan file**: The card describes one obvious mechanism and no plan was written. Implement from `CARD.md`. If mid-work you discover the mechanism isn't obvious after all, see `<when-to-return-to-planning>`.

Read `CARD.md` for goals and constraints and `CARD.meta.json` for current `title`, `gates`, and `tags` before starting.

**Choose the execution weight.** Implement directly when the whole card is small enough that direct edits beat a handoff — proceed in logical units below. Otherwise read `./developer-wave.md`, split the work into packages, and dispatch a persistent developer team; its own `<integration-gate>` replaces `<per-unit-gate>` and `<completion-gate>` below.

Direct implementation proceeds in **logical units** — a coherent change that leaves the workspace type-check-clean and tests-passing, the natural point to commit and tag a rollback. For each unit:

1. Read relevant files.
2. Implement the change.
3. Pass the `<per-unit-gate>`.
4. Commit, then tag the rollback point: `git tag -f "implement/$CARD_ID/step-N" HEAD`.

When all units are complete, pass the `<completion-gate>` before proceeding to Step 3.

Every commit in this flow follows the `<workspace-commit-style>` and `<markdown-guidelines>` conventions.

When the card introduces new behavior whose contract is worth validating ahead of implementation — a new public function, API, data type, schema, or algorithm — consult the `<tdd-bootstrap>` instructions from the `runtime:tdd-bootstrap` skill. Skip the bootstrap for refactors, spikes, UI or visual work, glue code, one-shot scripts, framework-determined shapes, and small in-place edits.

## 3. Evaluate Quality

Diff `implement/$CARD_ID/baseline..HEAD` to assess scope: number of files changed, types of changes, and runtime risk signals (new API boundaries, async logic, shared state, error-path changes).

- **Simple** — single-file change, or mechanical edit (rename, type signature update, config tweak) with no behavioral change. Skip evaluation; proceed to Step 4.
- **Behavioral or cross-file** — any new logic, new API boundary, multi-file change, or async/error-path modification. Read `./implementation-evaluation.md`.

## 4. Finalize

The card is not COMPLETED until every part of this section has run. Passing the completion gate at the end of Step 2 is not the terminal state — staging, tag cleanup, and the merge decision all follow.

**Commit remaining work.** If a developer team is live, drain it first. Stage only card-owned paths per `<workspace-ownership>`:

```bash
git add -- [CARD_OWNED_PATHS...]
git diff --cached
git diff --cached --quiet || git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines>]
COMMITMSG
)"
```

**Clean up tags.** The rollback window closes once implementation commits are finalized:

```bash
git tag -l "implement/$CARD_ID/*" | xargs -r git tag -d
```

**Route to merge or await review.** Based on `gates.mergeRequestRequired`:
- **false or unset** — read `./merge.md`.
- **true** — **STOP**. Merge occurs after user approval.

</instructions>

<implementation-discipline>

**Scope is the card's scope.** Implement only what the card (or plan) specifies; do not introduce unrelated cleanup, refactoring, or abstractions. File a card (load `cards:cards`) for discoveries in code the change does not interact with before finalizing.

**Zero errors in affected packages.** Fix priority: pre-existing errors, then direct implementation, then test infrastructure, then environment.

**No mocks.** Test with real implementations. Use dependency injection so code stays testable, and create thin adapter interfaces with real test implementations for external services — never mock libraries or framework internals.

**Iterate on evidence.** Fix and re-run when an attempt tests a new hypothesis; otherwise return to planning.

**Follow repository conventions** and existing patterns. Do not create extra artifacts unless the scope or loaded skills require them.

</implementation-discipline>

<per-unit-gate>

Lint and typecheck per the project's CLAUDE.md validation conventions. Re-run only the failing test or suite until it passes; broaden to the changed package's suite once green, and defer cross-package runs to `<completion-gate>`.

- **All pass** — commit, then tag the rollback point.
- **Failure originates in this unit's changes** — fix and re-run.
- **Otherwise** — proceed to `<completion-gate>` and apply its routing.

</per-unit-gate>

<completion-gate>

After all logical units are complete, run workspace-wide lint and typecheck plus the test suite of every package the `implement/$CARD_ID/baseline..HEAD` diff touches (or the plan's validation commands, when following a plan). Every command must pass before proceeding to Step 3.

- **All pass** — proceed to Step 3.
- **Failure originates in files the card's diff touched** — fix and re-run.
- **Otherwise** (failure is not obviously the card's work — anything ambiguous, unfamiliar, or that "feels" pre-existing) — diagnose per `<pre-existing-diagnosis>` before deciding whether to fix or block.

</completion-gate>

<pre-existing-diagnosis>

Reproduce against the baseline instead of guessing. For long diagnosis, dispatch `runtime:card-pre-existing-condition` with the command, output, and card diff. Its `BLOCKED` is evidence for orchestrator reconciliation, never card state. To diagnose yourself, use a disposable baseline worktree:

```bash
create-worktree "implement/$CARD_ID/baseline"
```

Run the failing command in that worktree, then delete the worktree and branch.

- **Baseline setup fails** — ownership is inconclusive. Diagnose and repair provisioning, tools, dependencies, or services; retry with new evidence.
- **Reproduces on baseline** — repair local drift (base-branch sync, dependencies, artifacts), then the root cause; re-run the failing command.
- **Does not reproduce on baseline** — the failure is in scope of this card's work; fix it and re-run.
- **Independent progress is impossible** — load `runtime:blocker-contract`. Block only if every criterion holds; otherwise repair, isolate, delegate, or re-plan.

</pre-existing-diagnosis>

<when-to-return-to-planning>

At any point during implementation, stop and return to planning if any of the following emerges. The first is the strongest signal — it usually means the chosen approach is wrong, not just incomplete.

1. **Implementation creates problems it then has to solve** — the approach introduces complexity that wouldn't exist with a different approach: timing windows, error-handling machinery, interface mismatches caused by the approach itself.
2. **Load-bearing assumption proved false** — the implementation depends on something about the codebase that turns out to be untrue or uncertain ("only one caller," "always returns X," "this field is optional"). The correct path forward now depends on what the truth implies.
3. **Approach fork with non-trivial tradeoffs** — a decision point arises where multiple viable paths have meaningfully different implications (correctness, performance, future extensibility) that can't be resolved by reading the code alone.
4. **Scope exceeded the card's implied boundary** — the in-scope work must touch significantly more files or systems than the card (or plan) described. Discovering issues in code the change does not interact with is *not* this condition — create a new card for those and continue. Scope too large for one worker is also not this condition — split into another package per `./developer-wave.md`.
5. **A plan assumption proved false, or the plan missed scope that changes the approach, or a completed planned step invalidates a later one** — when following a plan, any of these means the plan needs revision, not a workaround.

Build missing capabilities within the card outcome. Before deferring work to a separate prerequisite, prove `<blocker-contract>`, name the consumed deliverable, then search for or create its card.

When any condition holds, drain a live developer team. Preserve the off-card snapshot; restore card-owned tracked paths from the baseline and remove only session-created owned paths. A whole-tree reset or clean is allowed only when no off-card state exists. Then discard step tags:

```bash
git restore --source "implement/$CARD_ID/baseline" --staged --worktree -- [CARD_OWNED_TRACKED_PATHS...]
git tag -l "implement/$CARD_ID/step-*" | xargs -r git tag -d
```

Read `./plan.md`. The discoveries made during implementation — the false assumption, the scope boundary, the fork — are live context for the next approach.

</when-to-return-to-planning>
