# Pre-existing validation

Capture the exact required command, output, environment, and diff scope. Try relevant cheap repairs such as installing declared dependencies or rebuilding derived artifacts, then rerun the full command. If it still fails ambiguously, prove ownership on the pinned baseline.

## Isolate the baseline

Never switch branches, stash, reset, or rewrite the active implementation checkout. Create a disposable detached worktree:

```bash
CHECK_DIR=$(mktemp -d)
git worktree add --detach "$CHECK_DIR" "$BASELINE"
```

Run the same command there with equivalent dependencies and environment; do not share writable build/cache artifacts with the active checkout. For a bug witness, copy only the new test and required test fixtures, not implementation changes. Capture output and exit status. Remove only this disposable worktree afterward, including after a failed check:

```bash
git worktree remove --force "$CHECK_DIR"
```

## Decide and repair

The same failure on baseline establishes pre-existence, not permission to ignore it. Repair its root cause or route it to its code owner. A passing baseline or different failure does not prove pre-existence; investigate the current diff. Repeat intermittent checks under equivalent conditions. If the baseline cannot run faithfully, the result is inconclusive: preserve the evidence and repair the environment or reconsider the approach; apply `$blocker-contract` only when independent progress is impossible.

Never skip or weaken tests, suppress required checks, or bypass hooks. After any repair, rerun the original full command; focused passes alone do not close the gate. Return to [implementation](./implementation.md) only when required checks pass.
