# Native Git Worktrees

Use Git directly. Read the repository's instructions for setup in a fresh checkout; a linked worktree does not inherit ignored dependencies, generated files or local configuration. Provision each worker and baseline worktree with the repository's declared package manager and install/build commands before its gate. Do not copy secrets or assume mutable dependency directories are safe to share.

## Package Worktree

Before its first dispatch, choose a filesystem-safe package slug and verify the branch does not already belong to another worker. From the lead checkout, allocate a private temporary parent with `mktemp -d`; save its literal path and ownership in `workers.md`. Set `[WORKER_WORKTREE]` to its `checkout` child and `[WORKER_BRANCH]` to `implement/[TASK_KEY]/[package]`.

```bash
git worktree add -b "[WORKER_BRANCH]" "[WORKER_WORKTREE]" HEAD
```

Verify the output with `git worktree list --porcelain` and record the branch/path/initial SHA. A failed allocation is a blocker; never reuse an unfamiliar path. Pass literal paths and branch names to the worker. It owns setup, commits and Git operations inside that worktree. Only the lead integrates branches in the lead checkout. Worktrees persist across tasks and worker refreshes.

Before code edits, require the worker to verify its actual working directory, branch, HEAD, and access to the lead's explicit task-state path. Resolve `git rev-parse --path-format=absolute --git-common-dir` in both checkouts: linked worktrees must share that common store, not necessarily their per-worktree Git directories. Verify a lead-written non-secret marker is readable from the worker when host sharing is untested. An identical-looking path in another container or two clones of the same repository is not shared storage. Missing access blocks local-branch integration; do not improvise worker remote pushes or assume that a host isolation flag selected this preallocated worktree.

## Baseline Diagnosis

Allocate a separate temporary parent and use its `checkout` child:

```bash
git worktree add --detach "[BASELINE_WORKTREE]" "[PINNED_BASELINE_REF]"
```

Provision the same declared toolchain and run the failing command there. Record the exact ref, environment and output; no diagnosis is valid if setup failed before the test. No new branch is needed for a detached baseline checkout.

## Cleanup

First drain the worker, inspect its status and record any retained SHA/evidence. Confirm the exact path is a worktree created by this session. Remove a clean worktree with `git worktree remove "[WORKER_WORKTREE]"`; remove its now-empty temporary parent with `rmdir`. Never use broad recursive deletion or a force flag to clear unfamiliar files. A setup-generated ignored file that prevents removal must be inspected and handled explicitly before retrying.

For accepted work, verify its branch is merged into the lead branch and remove it with `git branch -d "[WORKER_BRANCH]"`. For a deliberately abandoned unpublished attempt, retain its SHA and diagnosis in task state before deleting only that recorded branch with `git branch -D`. Do not delete the assigned task branch, base branch, unrecorded branches or remote refs. Cleanup failures must be resolved or reported, not suppressed.
