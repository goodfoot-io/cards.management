---
name: implement
description: Implement, validate, and fast-forward merge a card-bound worktree.
---

On resume, restore saved context, verify binding and origin, and skip Steps 1–3.

1. From a clean, unbound checkout (`.cards/CARD_ID` absent/empty), record `ORIGIN_DIR=$(pwd)` and a named `ORIGIN_BRANCH=$(git branch --show-current)`.

2. Run `create-worktree <task-branch>`; enter its JSON `worktree` path and record `branch`.

3. Run `cards create` here (auto-attaches), or `cards <requested-id> attach --parent-branch "$ORIGIN_BRANCH"`. Capture `CARD_ID`; fetch `cards "$CARD_ID"`'s `repositoryPath` as `CARD_REPO_PATH`. Follow card-repository instructions; commit origin/worktree paths and branches in a card comment.

4. Pin the baseline; preserve an existing tag:

```bash
BASELINE="implement/$CARD_ID/baseline"
git show-ref --verify --quiet "refs/tags/$BASELINE" || git tag "$BASELINE" HEAD
```

Read [implementation](./references/implementation.md). Preserve worktree/baseline on failure or unmet approval gates.

5. Run `git rebase --empty=drop "$ORIGIN_BRANCH"` from the worktree. Revalidate, then `git merge --ff-only <worktree-branch>` from the clean `$ORIGIN_DIR` on `$ORIGIN_BRANCH`. On divergence, rebase and validate again; never force.

6. Record landed SHAs and results in the card.
From `$ORIGIN_DIR`, run `remove-worktree <worktree-path>`.
Delete the baseline: `git tag -d "$BASELINE"`.
