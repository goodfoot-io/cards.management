<instructions>

## 1. Prepare Environment

Verify the pinned baseline and checkout against `session.md`. The baseline does not advance during implementation. Record the implementation phase before starting.

```bash
git rev-parse --verify "implement/$TASK_KEY/baseline^{commit}"
```

## 2. Implement

Check the current plan path and pending follow-up units recorded in `TASK_STATE/session.md`. Execute pending feedback units even when all tasks in the prior plan are complete. Record their committed SHA and validation before marking them completed.

- **Current plan exists**: Execute its unfinished tasks, using the recorded completed units and Git evidence to avoid repeating work. Follow-on plans layer on completed plans. Do not rewrite the plan while implementing it — if it turns out to be wrong, see `<when-to-return-to-planning>`.
- **No plan file**: The task describes one obvious mechanism and no plan was written. Implement from `TASK_STATE/TASK.md`. If mid-work you discover the mechanism isn't obvious after all, see `<when-to-return-to-planning>`.

Read `TASK_STATE/TASK.md` for goals and constraints and `TASK_STATE/progress.md` for current evidence before starting.

**Choose the execution weight.** Implement directly when the whole task is small enough that direct edits beat a handoff — proceed in logical units below. Otherwise read `./developer-wave.md`, split the work into packages, and dispatch a persistent developer team; its own `<integration-gate>` replaces `<per-unit-gate>` and `<completion-gate>` below.

Direct implementation proceeds in **logical units** — a coherent change that leaves the workspace type-check-clean and tests-passing, the natural point to commit and tag a rollback. For each unit:

1. Read relevant files.
2. Implement the change.
3. Pass the `<per-unit-gate>`.
4. Commit, then tag the rollback point: `git tag -f "implement/$TASK_KEY/step-N" HEAD`. Record the completed unit, SHA and gate results in task state.

When all units are complete, pass the `<completion-gate>` before proceeding to Step 3.

Every commit in this flow follows the `<workspace-commit-style>` and `<markdown-guidelines>` conventions.

When the task introduces new behavior whose contract is worth validating ahead of implementation — a new public function, API, data type, schema, or algorithm — consult the `<tdd-bootstrap>` instructions from the `$cardless:tdd-bootstrap` skill. Skip the bootstrap for refactors, spikes, UI or visual work, glue code, one-shot scripts, framework-determined shapes, and small in-place edits.

## 3. Evaluate Quality

Diff `implement/$TASK_KEY/baseline..HEAD` to assess scope: number of files changed, types of changes, and runtime risk signals (new API boundaries, async logic, shared state, error-path changes).

- **Simple** — single-file change, or mechanical edit (rename, type signature update, config tweak) with no behavioral change. Skip evaluation; proceed to Step 4.
- **Behavioral or cross-file** — any new logic, new API boundary, multi-file change, or async/error-path modification. Read `./implementation-evaluation.md`.

## 4. Finalize

The task is not COMPLETED until delivery succeeds. Passing Step 2's completion gate is not the terminal state — final staging, review evidence and PR delivery all follow.

**Stage remaining changes.** If a developer team is live, drain it per `./developer-wave.md` `<lifecycle>` first. Stage any uncommitted implementation artifacts and commit per the workspace commit style:

```bash
git add -A
git diff --cached --quiet || git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines>]
COMMITMSG
)"
```

**Record completion evidence.** Save the final implementation SHA and quality evaluation outcome in task state. Preserve baseline and step refs until delivery succeeds; any new commit invalidates prior validation/review evidence.

**Deliver.** Read `./deliver.md` to synchronize the base, validate, review the final diff, push the assigned branch and open the PR.

</instructions>

<implementation-discipline>

**Scope is the task's scope.** Implement only what the task (or plan) specifies; do not introduce unrelated cleanup, refactoring, or abstractions. Record discoveries outside the task's interactions in `TASK_STATE/notes/` for the final report. A required validation failure must still be resolved or reported as blocking.

**Zero errors in affected packages.** Fix priority: pre-existing errors, then direct implementation, then test infrastructure, then environment.

**No mocks.** Test with real implementations. Use dependency injection so code stays testable, and create thin adapter interfaces with real test implementations for external services — never mock libraries or framework internals.

**Iterate, then escalate.** On validation failure, fix and re-run. When repeated attempts produce no new information, stop and route via `<completion-gate>` rather than thrashing.

**Follow repository conventions** and existing patterns. Create additional artifacts only when the task or its loaded instructions require them.

</implementation-discipline>

<per-unit-gate>

Lint and typecheck per the project's AGENTS.md validation conventions. Re-run only the failing test or suite until it passes; broaden to the changed package's suite once green, and defer cross-package runs to `<completion-gate>`.

- **All pass** — commit, then tag the rollback point.
- **Failure originates in this unit's changes** — fix and re-run.
- **Otherwise** — proceed to `<completion-gate>` and apply its routing.

</per-unit-gate>

<completion-gate>

After all logical units are complete, run workspace-wide lint and typecheck plus the test suite of every package the `implement/$TASK_KEY/baseline..HEAD` diff touches (or the plan's validation commands, when following a plan). Every command must pass before proceeding to Step 3.

- **All pass** — proceed to Step 3.
- **Failure originates in files the task's diff touched** — fix and re-run.
- **Otherwise** (failure is not obviously the task's work — anything ambiguous, unfamiliar, or that "feels" pre-existing) — diagnose per `<pre-existing-diagnosis>` before deciding whether to fix or block.

</completion-gate>

<pre-existing-diagnosis>

Reproduce the failing command against the baseline instead of guessing. If the reproduction looks like it will be long or noisy, a subagent keeps it out of your context. Use a disposable worktree at the baseline ref — never switch branches or stash in the active workspace:

Follow `./worktrees.md` to create a disposable detached worktree at `implement/$TASK_KEY/baseline`, provision its dependencies, and run the failing command. Preserve the output, then remove that verified temporary worktree.

- **Reproduces on baseline** — the failure predates this task's changes. Try cheap remedies first (sync with the local base branch, reinstall dependencies, rebuild derived artifacts); if that doesn't clear it, repair the root cause in the active workspace, then re-run the failing command.
- **Does not reproduce on baseline** — the failure is in scope of this task's work; fix it and re-run.
- **Structural obstacle** (unreachable services, missing system tools or credentials, hardware constraints, an unresolved upstream bug on the base branch) — save the failure output and diagnosis under `TASK_STATE/reports/` and read `./blocked.md`. Do not proceed past a required check that could not run.

</pre-existing-diagnosis>

<when-to-return-to-planning>

At any point during implementation, stop and return to planning if any of the following emerges. The first is the strongest signal — it usually means the chosen approach is wrong, not just incomplete.

1. **Implementation creates problems it then has to solve** — the approach introduces complexity that wouldn't exist with a different approach: timing windows, error-handling machinery, interface mismatches caused by the approach itself.
2. **Load-bearing assumption proved false** — the implementation depends on something about the codebase that turns out to be untrue or uncertain ("only one caller," "always returns X," "this field is optional"). The correct path forward now depends on what the truth implies.
3. **Approach fork with non-trivial tradeoffs** — a decision point arises where multiple viable paths have meaningfully different implications (correctness, performance, future extensibility) that can't be resolved by reading the code alone.
4. **Scope exceeded the task's implied boundary** — the in-scope work must touch significantly more files or systems than the task (or plan) described. Discovering issues in code the change does not interact with is *not* this condition — record those in notes and continue.
5. **A plan assumption proved false, or the plan missed scope that changes the approach, or a completed planned step invalidates a later one** — when following a plan, any of these means the plan needs revision, not a workaround.

When any condition holds, **stop implementation immediately**. If a developer team is live, drain it per `./developer-wave.md` `<lifecycle>` first. Save the triggering evidence and worker reports in task state. For an unpublished attempt containing only verified task-owned changes, revert to the pinned baseline and discard this attempt's exact recorded step tags. Published or supplied commits must be preserved; plan a corrective follow-on instead of rewriting them.

```bash
git reset --hard "implement/$TASK_KEY/baseline"
git clean -fd
git tag -d "implement/$TASK_KEY/step-N"  # each recorded task-owned step tag
```

Read `./plan.md`. The discoveries made during implementation — the false assumption, the scope boundary, the fork — are live context for the next approach.

</when-to-return-to-planning>
