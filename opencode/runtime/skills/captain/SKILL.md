---
name: captain
description: Evaluate card state and load the appropriate reference.
---

**Use as few tokens as possible in this session by using subagents.**

Before creating or retaining card-level blocked state, load `$blocker-contract`; its `<blocker-contract>` is authoritative. When every criterion holds, commit the actionable blocker comment and `blocked` tag together without changing gates.

<subagents>
Use forked subagents for open-ended tasks suited to parallelization such as research, or when "fresh eyes" are required for tasks such as review. Development work follows `./references/developer-wave.md`'s persistent developer team. Choose the model most appropriate for the task; subagent tasks should be achievable within a single session.
</subagents>

<execution-environment>

Governs this session and every reference it loads. The runtime runs in a disposable per-card git worktree.

**Inside the worktree — proceed without per-action confirmation.** File mutations, branch operations, tag deletion, path-scoped cleanup, and workspace-local merges are authorized. Apply `<workspace-ownership>` before any broad reset, restore, clean, stash, or removal; never bypass safety hooks.

**`CARD.meta.json` `gates.*` carry the user's scoped, durable authorization.** Read the gate and act within the scope it authorizes. Do not re-derive consent from context, scope, commit volume, or overlap with prior work. Never modify gate fields.

**Confirm before acting beyond the worktree and workspace:**

- `git push` and any other write to a git remote
- `gh pr` and `gh issue` writes (create, comment, merge, close)
- Writes to systems outside the workspace not described in the card — databases, third-party services, network endpoints

A matching gate overrides this default only for the action the gate names, and only within its scope.

</execution-environment>

<workspace-ownership>

Before implementation, inspect `git diff`, `git diff --cached`, and `git ls-files --others --exclude-standard`; use `lstat` or equivalent for untracked symlink nodes. Classify paths against the card, plan, package scope, baseline, and recorded work. Snapshot pre-existing off-card paths.

- Card-owned coherent work: recover and continue.
- Card-owned incoherent work: preserve with a path-scoped stash or recovery commit, clean only those paths, and continue.
- Unrelated user work or pre-existing off-card generated/provisioned artifacts: preserve; exclude from work detection and staging. Use explicit paths or an isolated worktree.
- Generated deliverables required by the card: regenerate from their source, validate, and treat their explicit paths as card-owned.
- Overlap: reconcile intent from source/history or isolate. Apply the blocker contract only if neither can preserve ownership and advance the card.

For every commit, derive card-owned changed paths from the implementation diff and session-created files; stage only those explicit paths; inspect `git diff --cached --name-status` and `git diff --cached`; correct an off-card staged path locally and continue. Broad stash, restore, clean, or reset is allowed only after off-card paths are excluded or proven recoverable.

When preserved off-card state could affect a check, use isolation. Before commit, materialize only the exact card-owned staged/working diff and session-created files over the current HEAD, then validate that candidate. For final certification and review, use an isolated worktree at the exact committed card HEAD.

</workspace-ownership>

<routing-constraints>
Route only — evaluate, select, and load. The loaded reference does the work; run it directly or via subagents as best fits the task.
</routing-constraints>

<quiet>
Routing runs without user interaction. Messages describing state and routing decisions are not required.
</quiet>

<routing-instructions>

## 1. Evaluate Routing Signals

### 1.1 Read Card State

Read `$CARD_REPO_PATH/CARD.meta.json` for current `gates.*` and `tags`. Obtain the comment file listing from `$CARD_REPO_PATH/comments` directory.

### 1.2 Derive Routing Signals

> **Comment authorship convention**: Determine authorship from the git commit that added each comment file: `git log --diff-filter=A --format='%an' -1 -- comments/<file>`. User-authored comments are committed by the user's git identity; agent-authored comments are committed by your git identity. Sort `comments/*.md` by modification time; the most recent user-authored file is the "latest user comment."

| Signal | Derivation |
|--------|------------|
| HAS_QUESTION | Latest user comment contains a genuine information-seeking question (not rhetorical, not "Can you fix X?", not "Could you implement Y?") |
| HAS_BLOCKED_TAG | `tags` contains "blocked". Identify the blocker comment and all later user-authored comments; later handling instructions are reconciliation input even when not questions. |
| HAS_WORK | `commits/` contains an attributed commit, or workspace changes remain after `<workspace-ownership>` classifies them as card-owned. Off-card paths never count. |
| HAS_IMPLEMENTATION_FEEDBACK | `commits/` directory contains at least one commit file AND the latest user comment's modification time is more recent than the most recent agent comment's modification time. |
| REVIEW_APPROVED | `gates.mergeApproved` in CARD.meta.json |
| PLAN_REQUIRED | `gates.planRequired` in CARD.meta.json |
| PLAN_APPROVED | `gates.planApproved` in CARD.meta.json |
| USER_RESPONDED_TO_PLAN | `plans/` directory contains at least one `.md` file AND there exists a user-authored commit — more recent than the most recent `plans/*.md` file's commit — that adds or modifies non-metadata files. Metadata files (`CARD.meta.json`, `branches/` directory, `commits/` directory, and their contents) are excluded; gate changes and status transitions do not constitute a plan response. |
| DOR_MET | Card description states what the user wants to achieve and why; acceptance criteria inferable; technical approach determinable |
| IS_TESTABLE_BUG | Card describes an expected-vs-actual behavior gap on a named surface (file, component, command, or user action). Stack traces and error messages count; so does an observable wrong behavior. "Sometimes" and "intermittent" do not disqualify — they describe the race the test must force. |

## 2. Route

Select the **first** matching condition and note the matched reference:

| Condition | Reference |
|-----------|-----------|
| HAS_BLOCKED_TAG | `blocked` |
| HAS_QUESTION | `question-response` |
| HAS_IMPLEMENTATION_FEEDBACK | `implementation-feedback` |
| REVIEW_APPROVED | `merge` |
| PLAN_REQUIRED AND NOT PLAN_APPROVED AND USER_RESPONDED_TO_PLAN | `plan-feedback` |
| PLAN_REQUIRED AND NOT PLAN_APPROVED | `plan` |
| NOT DOR_MET | `clarify-and-enrich` |
| PLAN_REQUIRED AND PLAN_APPROVED | `implementation` |
| IS_TESTABLE_BUG | `bug` |
| HAS_WORK | `validate` |
| Otherwise | `plan` |

**Fallback**: When conditions conflict, ask "What would a human team member do?" and write down why. Articulating the ambiguity usually resolves it.

## 3. Load Routed Reference

Read `./references/[MATCHED].md`.

Reading a reference means following it. A bare `.md` filename — in a reference or a hook message — is in this skill's `references/`, not the workspace or card repo.

</routing-instructions>
