
<placeholder-variables>
[CARD_ID] — The current card identifier
[BASE_BRANCH] — The branch the card's worktree was created from
</placeholder-variables>

<instructions>

## 1. Check for Changes

Count the commits on `$WORKSPACE_BRANCH` relative to `$BASE_BRANCH` (`git rev-list --count $BASE_BRANCH..$WORKSPACE_BRANCH`).

Based on commit count:
- **COMMIT_COUNT = 0**: No changes to merge. **STOP**.
- **COMMIT_COUNT >= 1**: Proceed to Step 2: Rebase and Validate.

## 2. Rebase and Validate

Rebase the branch onto local `$BASE_BRANCH` to keep history linear:

```bash
git rebase --empty=drop $BASE_BRANCH
```

Based on rebase result:
- **Conflicts occur**: Identify all conflicted files before resolving, then stage each resolved file by name rather than using `git add -A`:

```bash
git diff --name-only --diff-filter=U   # list conflicted files
git add <resolved-file-1> <resolved-file-2>
git rebase --continue
```

- **Conflicts cannot be resolved**: Add `blocked` to `tags` in `CARD.meta.json` if not already present. Write conflict details to `comments/merge-conflict.md` (files involved, manual resolution steps). Commit both files and **STOP** — Awaiting user intervention.

- **Rebase reports branch is already up to date** (no commits moved): Proceed to validation below.

- **Rebase completes with 0 commits ahead of `$BASE_BRANCH`** (commit was dropped as empty): The changes are already present in `$BASE_BRANCH`. Write a comment to the card repository noting this, and **STOP** — nothing to merge.

Run the validation gates the project's AGENTS.md declares, whether or not the rebase moved commits.

**Validation rules:**
- All validation commands must execute and pass — a command that errors before producing results is a failure
- Fix any errors you encounter — do not dismiss errors as "pre-existing" or "unrelated"
- "Resolve or block" is the only valid outcome — there is no "proceed despite errors" path
- Fix infrastructure failures (missing dependencies, path issues) — do not work around them
- Creating a card is not an alternative to fixing a validation failure — test failures, lint errors, and type errors must be fixed in this branch
- **Structural obstacle** (unreachable services, missing system tools or credentials, hardware constraints, an unresolved upstream bug on the base branch): Add `blocked` to `tags` in `CARD.meta.json` if not already present. Write the failure output and your diagnosis to `comments/validation-failed.md`. Commit both files and **STOP** — Awaiting user intervention.

Based on validation result:
- **All validation passes**: Proceed to Step 3: Fast-Forward Merge.
- **Validation fails**: Fix errors, re-run validation — repeat until it passes; there is no attempt limit

## 3. Fast-Forward Merge

`$WORKSPACE_PATH` is a worktree — `$BASE_BRANCH` is checked out elsewhere. Find where `$BASE_BRANCH` is checked out:

```bash
BASE_WORKTREE=$(git -C "$WORKSPACE_PATH" worktree list --porcelain \
  | awk -v b="$BASE_BRANCH" '/^worktree /{wt=$2} /^branch refs\/heads\//{if($2=="refs/heads/"b) print wt}')
cd "$BASE_WORKTREE"
```

Check for uncommitted changes with `git status --porcelain`:

- **Clean**: Merge with `git merge --ff-only "$WORKSPACE_BRANCH"`. **STOP** — Merge complete. Do not update card status, write comments, or take further action.
- **Dirty**: Stash uncommitted changes, fast-forward merge, then restore:

```bash
git stash push --include-untracked -m "card-merge: stash before ff-merge" && git merge --ff-only "$WORKSPACE_BRANCH" && git stash pop
```

  - **Succeeds**: **STOP** — Merge complete. Do not update card status, write comments, or take further action.
  - **`git stash pop` reports conflicts**: Add `blocked` to `tags` in `CARD.meta.json` if not already present. Write failure details to `comments/merge-failed.md` — stashed changes conflict with the merged branch; user must resolve the stash conflict manually. Commit both files and **STOP**.
  - **`git merge --ff-only` fails**: Run `git stash pop` to restore uncommitted changes before stopping. Add `blocked` to `tags` in `CARD.meta.json` if not already present. Write failure details to `comments/merge-failed.md` — branch is not a fast-forward of `$BASE_BRANCH`; include likely cause and resolution steps. Commit both files and **STOP**.
- **Merge or apply fails for any other reason**: Add `blocked` to `tags` in `CARD.meta.json` if not already present. Write failure details to `comments/merge-failed.md` — branch is not a fast-forward of `$BASE_BRANCH`; include likely cause and resolution steps. Commit both files and **STOP**.

</instructions>
