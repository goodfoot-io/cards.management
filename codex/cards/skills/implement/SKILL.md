---
name: implement
description: Worktree workflow for implementing a task — create a worktree, create a bound card, implement, rebase, fast-forward merge back, and clean up.
---

<worktree-task-workflow>

1. **Record the starting point** before doing anything else:
   - `ORIGIN_DIR=$(pwd)` — the directory to return to and merge into.
   - `ORIGIN_BRANCH` — the branch currently checked out there.
   - Confirm this checkout is unbound (`.cards/CARD_ID` is absent or empty). Flagless `create-worktree` inherits a trimmed marker from the nearest invoking Git checkout, so a bound origin would create another checkout for that existing card instead of the fresh-card workflow below. Ambient `CARD_ID` is ignored, and a nested repository forms its own inheritance boundary.

2. **Create a worktree** with the `create-worktree` CLI — Codex CLI has no built-in worktree tool:
   `create-worktree <task-branch>`
   then `cd` into the printed `worktree` path (parsed from the JSON output).

3. **Create a card for the task** by running `cards create` from inside the worktree. Creating it from within the worktree auto-attaches the card to it — no separate attach step.

4. **Implement the change** in the worktree, on its branch.

5. **Rebase onto the origin branch**, from the worktree:
   `git rebase --empty=drop $ORIGIN_BRANCH`

6. **Fast-forward merge back**, from `$ORIGIN_DIR` (not the worktree):
   `git merge --ff-only <worktree-branch>`
   Fails loudly on divergence instead of creating a merge commit — resolve by rebasing again rather than forcing a merge commit.

7. **Remove the worktree**, from `$ORIGIN_DIR`, with the `remove-worktree` CLI:
   `remove-worktree <worktree-path>`

</worktree-task-workflow>
