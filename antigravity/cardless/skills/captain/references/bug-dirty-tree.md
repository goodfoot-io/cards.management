# Recover a Dirty Checkout

Inspect `git diff`, `git diff --cached`, and `git ls-files --others --exclude-standard`. Use `lstat` or equivalent for untracked paths so provisioned symlinks are classified without following them. Compare each path with the brief, baseline diff, package scope, and recorded initial state; snapshot the off-task set.

- **Task-owned, coherent:** commit the recoverable unit with explicit paths, record its SHA, and continue to validation.
- **Task-owned, incoherent:** preserve those paths in a path-scoped stash or recovery commit, clean only those paths, and continue.
- **Unrelated user work:** preserve exactly; use explicit path staging or an isolated worktree.
- **Pre-existing off-task generated or provisioned artifacts:** leave untouched; exclude from work detection and staging.
- **Task-required generated deliverables:** regenerate from their source, validate, and stage only their explicit paths.
- **Overlapping state:** reconcile intent from source and history, or use an isolated worktree.

Dirty state alone never blocks. Apply the shared blocker contract only when neither reconciliation nor isolation can preserve ownership and advance the task. Broad stash, restore, clean, or reset is allowed only after every affected off-task path is excluded or proven recoverable.

When preserved off-task state could affect a check, use isolation. Before commit, materialize only the exact task-owned staged/working diff and session-created files over the current HEAD, then validate that candidate. For final certification and review, use an isolated worktree at the exact committed task HEAD.
