
<placeholder-variables>
[CARD_ID] — The card identifier
</placeholder-variables>

<instructions>

This reference fires when card work exists (`commits/` directory has commit files and/or the worktree has uncommitted changes) and no stronger signal claims the card — typically after the card emerged from a `blocked` state, after a session crashed or terminated mid-flow, or when work exists without an approved plan or pending merge approval.

**Output asymmetry.** You may route backward to planning or implementation on your own judgment. You may not route forward to merge without passing Step 4's review.

## 1. Prepare Environment

### 1.1 Baseline Tag

If `implement/$CARD_ID/baseline` does not exist, create it at the prior committed state — the latest commit recorded in the `commits/` directory when present, otherwise current `HEAD` (which represents the workspace branch tip before any uncommitted work is staged in Step 1.2).

```bash
if git rev-parse "implement/$CARD_ID/baseline" >/dev/null 2>&1; then
  echo "Baseline tag already exists — resuming from prior checkpoint."
else
  baseline_sha=$(git -C "$CARD_REPO_PATH" log -1 --name-only --pretty=format:"" -- commits/ 2>/dev/null | grep "^commits/" | head -n 1 | cut -d/ -f2)
  if [ -z "$baseline_sha" ]; then
    baseline_sha=$(git rev-parse HEAD)
  fi
  git tag "implement/$CARD_ID/baseline" "$baseline_sha"
fi
```

### 1.2 Stage Uncommitted Work

**Every commit below follows the `<workspace-commit-style>` and `<markdown-guidelines>` conventions.**

If the worktree contains uncommitted changes — typical after a crashed session that left work unsaved — commit them so validation and review analyze a coherent implementation:

```bash
git add -A
git diff --cached --quiet || git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines> — describe the uncommitted changes recovered from the worktree]
COMMITMSG
)"
```

## 2. Pre-Review Validation

Run the workspace's typecheck and lint, plus each package suite the diff `implement/$CARD_ID/baseline..HEAD` touches. If a plan file in `plans/` declares custom validation commands, run those instead.

- **All validations pass**: Proceed to Step 3.
- **Failure not obviously the active card's work** (anything ambiguous, unfamiliar, or that "feels" pre-existing): Diagnose it per `./implementation.md`'s `<pre-existing-diagnosis>`.
  - **Reproduces on baseline**: repair per that procedure, re-run the validation command. If it passes, proceed to Step 3.
  - **Does not reproduce on baseline**: the failure is in scope of the active card's work. Proceed to Step 3 — the escape hatch in Step 3 should fire on this evidence.
  - **Structural obstacle**: add `blocked` to `tags` in `CARD.meta.json`, write the diagnosis and exact failure output to `comments/validation-failed.md`, commit, **STOP**.
- **Failure clearly originates in files the active card's diff touched**: Proceed to Step 3 — the validation suite is reporting that the work is not actually done.

## 3. Optional Escape Hatch — Your Judgment

Before reviewing, you may bail out if your reading of `plans/`, `commits/`, `CARD.md`, the diff `implement/$CARD_ID/baseline..HEAD`, and the pre-review validation result indicates the implementation is not ready for review. The trigger is your judgment — there is no checklist.

This step may only re-route backward, never forward to merge:

- **Plan file exists in `plans/`**: Read `./implementation.md`. It detects partial implementation via the plan and resumes the work.
- **No plan file**: Read `./plan.md`.

If you choose not to bail out, continue to Step 4.

## 4. Review

Weight completeness against the card's acceptance criteria alongside the usual failure-mode questions — this is a re-check of already-committed work, not first-pass evaluation. Diff `implement/$CARD_ID/baseline..HEAD`, read the card, and evaluate.

**Choose the review weight.** For a substantial diff, read `./evaluation-wave.md` and follow it in place of this step's inline review — treat its finalize-and-return as "no findings" and proceed to Step 5; its BLOCKED branch stops as usual. A fresh-eyes subagent per angle is a middle weight. Otherwise review inline:

**Failure modes.** Where could this break at runtime that the validation suite wouldn't catch?

**Delivered experience.** Does it satisfy the card's acceptance criteria and intent?

- **No findings**: Proceed to Step 5: Finalize.
- **Findings that are in-scope fixes**: Fix them, re-run Step 2's validations, then return to Step 4 and re-review the new HEAD.
- **Findings that require a different approach or missed scope**: Treat as Step 3's escape hatch — route to `./implementation.md` (plan exists) or `./plan.md` (no plan), carrying the findings as context.
- **Structural constraint blocking the fix**: Document the constraint and finding in a comment, add `blocked` to `tags` in `CARD.meta.json`, commit, **STOP**.

## 5. Finalize

Only enter this step once Step 4 finds nothing further to fix.

### 5.1 Stage Remaining Changes

```bash
git add -A
git diff --cached --quiet || git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines>]
COMMITMSG
)"
```

### 5.2 Tag Cleanup

```bash
git tag -d "implement/$CARD_ID/baseline" 2>/dev/null
```

### 5.3 Complete or Await Review

Based on `gates.mergeRequestRequired`:
- **false or unset**: Read `./merge.md`.
- **true**: **STOP** — Merge occurs after user approval.

</instructions>

<rollback>

| Tag | Created At | Advances | Purpose |
|-----|------------|----------|---------|
| `implement/[CARD_ID]/baseline` | Step 1.1 (if missing) | Never | Comparison ref for review and rollback target if Step 3's escape hatch fires. Pinned at last commit file in `commits/` directory, or HEAD when the directory is empty. |

</rollback>
