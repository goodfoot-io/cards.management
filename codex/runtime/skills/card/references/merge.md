<placeholder-variables>
[BASE_BRANCH] — The branch the card worktree was created from
[WORKSPACE_BRANCH] — The card worktree branch
[WORKSPACE_PATH] — The card worktree path
</placeholder-variables>

<instructions>

## 1. Integrate the Current Local Base

Fetch is neither required nor implied. Rebase onto local `$BASE_BRANCH`. On conflicts, list unmerged paths, inspect both intents and history, resolve what is derivable, stage each resolved file by name, and continue. If one strategy fails, abort it to the prior state and retry only with new evidence or use an isolated integration worktree. Apply `<blocker-contract>` only when neither method can preserve ownership and advance the card.

If rebase drops every card commit as already present, record that result and stop. Otherwise run every validation gate declared by the project's AGENTS.md. Repair code, dependencies, tooling, derived artifacts, and baseline failures; re-plan when the approach is wrong. A failed first merge or validation strategy is not a blocker.

## 2. Fast-Forward the Base

Locate the worktree holding `$BASE_BRANCH` with `git worktree list --porcelain`. Classify its changes per `<workspace-ownership>`.

- **Clean:** `git merge --ff-only "$WORKSPACE_BRANCH"`.
- **Disjoint unrelated work:** preserve it exactly. Validate the integration in a clean isolated worktree, then fast-forward only when Git confirms those paths remain intact. Use explicit path-scoped staging or stashing where needed; never stash the whole tree.
- **Overlap:** reconcile intent or use an isolated integration worktree. Restore any preserved user paths and verify them afterward.

Diagnose a failed fast-forward, conflict, or restore; resolve, rebase, or re-plan and validate again. Block only after loading `$runtime:blocker-contract` and proving every criterion. On success, stop without changing card status or adding a completion comment.

</instructions>
