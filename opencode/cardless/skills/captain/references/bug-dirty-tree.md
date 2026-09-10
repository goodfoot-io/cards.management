# Recover a Dirty Checkout

Inspect staged, unstaged and untracked files against the task brief, recorded initial state, and pinned baseline. Never infer ownership from the directory alone.

- **Task-owned and coherent:** inspect every file, commit the recoverable partial unit when repository hooks permit it, record its SHA and recovery in `progress.md`, then return to the caller. It still needs validation and review.
- **Task-owned but incoherent:** preserve all affected tracked and untracked files in a named stash, record the exact stash ref and paths in task state, then continue from the clean checkout. Do not later report success until that saved work is accounted for as superseded or restored.
- **Unrelated or ownership uncertain:** preserve the files in place and read `./blocked.md` with the exact paths. No broad staging, cleaning, restoring or reset is allowed over them.

Recovery never moves the pinned baseline forward. If a new session begins with task-owned dirty work, pin the initial HEAD first and record the dirty files; the recovered commit must remain inside the reviewed diff.
