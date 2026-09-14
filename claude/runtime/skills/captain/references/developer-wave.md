# Developer Team

Persistent-worker delegation for implementation work you choose not to do inline. Loaded from `./implementation.md` (plan/card units) and `./implementation-evaluation.md` (finding fixes). You are the lead — you never implement, and you own every gate, merge, and integration. Each worker implements, tests, and commits in its own package worktree; only you run git in the card worktree.

<placeholder-variables>
[MODEL] — LLM model for worker delegation, per `<model-selection>`
[WORKER_BRANCH] — `implement/$CARD_ID/[package]`, the package branch a worker commits on
[WORKER_WORKTREE] — the worktree checked out on `[WORKER_BRANCH]`, from `create-worktree`'s output
</placeholder-variables>

<roster>

Split the assigned work into packages — one per disjoint directory or subsystem a worker can gate independently. A worker owns its package for the whole wave, not one task: dispatch it once by name, in the background, and reuse it for every later task in that package via `SendMessage` — never spawn a second `Agent` for a package that already has a live worker, except the one-off high-capability escalation in `<dispatch>`. Keep the roster small enough that you review every checkpoint and report promptly; queue the rest. Size each task so its package gate can pass at its end — a task that would leave the gate red until a later step includes that step; one that cannot pass in a single session is too large — split it. Order tasks so no gate depends on a peer task still in flight; when one still reports BLOCKED on a peer's unfinished work, re-issue it as a `TASK:` once the peer's branch is merged.

Cross-package contracts (types, wire shapes, storage layouts) are yours to decide and state explicitly in each worker's dispatch prompt — do not let two workers negotiate a shared boundary. Verify a stated contract at the `REPORT:` that touches it, not at the gate: diff the reported contract files against the `## Contract` in every consuming worker's brief; `REVISE:` the deviator.

**If two workers' file sets turn out to overlap mid-wave**: `HOLD` both, assign the files to one package, re-task with corrected `## Package` scopes, and resolve the overlap yourself when the second branch merges.

</roster>

<worktrees>

Before a package's first dispatch, from the card worktree, create its branch and worktree at the card tip:

```bash
create-worktree --parent-branch "$WORKSPACE_BRANCH" "implement/$CARD_ID/[package]"   # inherits this checkout's card
```

Run this from the card worktree: flagless card selection reads its trimmed `.cards/CARD_ID` at the invoking checkout boundary (not ambient `CARD_ID`), while `--parent-branch` remains available for that inherited binding. Do not dispatch the worker until the JSON is printed; it is emitted only after registration, marker, hooks, attribution, and parent lineage are complete. Any selected-card provisioning failure fails closed and must be resolved rather than treating the child as an offline checkout.

Pass the printed values as `[WORKER_BRANCH]` and `[WORKER_WORKTREE]`. The worktree persists across tasks and worker refreshes. Never run git inside a worker's worktree; never let a worker run git in the card worktree.

</worktrees>

<dispatch>

Every worker DM — from you or from the worker — carries its marker as the first body line, then `Sender: [name]`, then `---`, then content (the worker's brief states the same envelope in `## Envelope`).

Reassess the model tier per task: for a system-level or cross-cutting task, dispatch a one-off worker on the strongest available model. Never `HOLD` an in-flight task for it — wait for a green `REPORT:` from every worker whose package it touches, send them no `TASK:` until the one-off reports, then inline its report into their next `TASK:`.

```xml
<invoke name="Agent">
<parameter name="description">[Package name] developer</parameter>
<parameter name="subagent_type">runtime:card:developer</parameter>
<parameter name="model">[MODEL]</parameter>
<parameter name="name">[worker-package-name]</parameter>
<parameter name="run_in_background">true</parameter>
<parameter name="prompt">
## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKER_WORKTREE] — your private worktree on branch `[WORKER_BRANCH]`; your cwd and the only place you run git. The card worktree at [WORKSPACE_PATH] is read-only to you.

## Package
You own [absolute paths under WORKER_WORKTREE]. Do not touch files outside this set without a message from team-lead.

## Context
[Why this work exists; relevant plan or exploration findings; what is already done and must not be redone. When intent is ambiguous, the plan's opening (commander's intent) is the tiebreaker.]

## Task
[Description with testing requirements. This task is its own scope: judge COMPLETED/NEEDS_REVISION/BLOCKED, iteration count, and decision narratives against THIS task only — do not carry forward or blend in a prior task's narrative.]

## Contract
[Signatures, wire formats, flag names, storage keys this task must produce or consume — state explicitly when another worker builds the other side]

## Dependencies
[Peer packages or outside work this task consumes that has not merged yet, or "None". Build against the stated contract; report what remains BLOCKED on it — never fetch, rebase onto, or reconstruct the missing side.]

## Workflow
When this task adds new behavior worth validating ahead of implementation, follow `runtime:tdd-bootstrap`: Phase 1 contract + stubs → checkpoint below (if required) → Phase 2 skipped checks → Phase 3 implement and unskip. Bug fixes skip the bootstrap — reproduce first. Commit each validated logical unit on `[WORKER_BRANCH]` per `<workspace-commit-style>` and `<markdown-guidelines>`. [Task-specific additions]

## Checkpoint
[Required | Not required]. When required: after Phase 1, DM team-lead `CHECKPOINT: contract-ready` and hold — no tests, no implementation — until team-lead DMs `PROCEED`. Silence is a stall, not a green light. If you discover a cross-package coupling this brief didn't flag, DM `CHECKPOINT: unanticipated-contract` and hold the same way, even when marked "Not required."

## Gate
Run [gate commands scoped to this package, not the root] before every commit and report. A failure originating outside your package: re-run once; if it persists, report BLOCKED with the output — do not fix it. Nothing is uncommitted at a report.

## Constraints
- Never trigger interactive git auth; scratch files go in the scratchpad; never edit shared settings outside your package
- A hook rejects a commit: [known obstacles and the skill that resolves each, or "none known"] — resolve it, never `--no-verify`
- A plan assumption that proves false, or an approach that creates problems it must then solve: `REPORT: BLOCKED` naming it — never work around it

## Report
DM team-lead `REPORT: <status>` with: `[WORKER_BRANCH]` and its HEAD SHA, what changed, files touched, gate results, any deviation from this task and why, anything left undone.

## Envelope
Every DM you send: marker on the first line, then `Sender: [worker-package-name]`, then `---`, then body. Inbound from team-lead: `PROCEED` (resume the held task after a checkpoint or `HOLD`), `TASK:` (next task; same rules as this brief; first run `git merge --ff-only $WORKSPACE_BRANCH` to pick up merged peer work), `REVISE:` (corrections to the current task — may amend any section of this brief, including `## Package`; same task scope and narrative; resume from the correction; during a hold, apply it and re-send the checkpoint), `HOLD` (finish and commit the current step, DM `HELD:` with your HEAD SHA and what remains, and wait for `TASK:` or `PROCEED`).

## Peers
team-lead is the orchestrator. [Name any peer worker whose contract this task depends on.] Contract questions go to team-lead, never to peers.
</parameter>
</invoke>
```

Dispatch every package whose first task consumes no peer contract in one message so they start concurrently; dispatch a consumer's first task after the producer's `contract-ready` is accepted. A follow-up task to a live worker is a `TASK:` DM, sent only after its prior `REPORT:` is merged per `<integration-gate>`, restating `## Task`, `## Contract`, `## Dependencies`, `## Checkpoint`, and any changed `## Package` or `## Workflow` — the rest of the original brief still applies.

</dispatch>

<checkpoints>

A `CHECKPOINT:` DM (`contract-ready` or `unanticipated-contract`) holds the worker — it does not proceed without your `PROCEED` reply; review what it built and reply `PROCEED` or `REVISE:` promptly, since the worker is blocked until you do. A `REPORT:` DM means the worker has gone idle; a report with unmet criteria gets a `REVISE:` back, never a re-dispatch. A `REPORT: BLOCKED` naming a false plan assumption or an approach that creates its own problems is a `<when-to-return-to-planning>` signal — evaluate it there before re-tasking. A `REPORT: BLOCKED` on a failure outside the worker's package: `REVISE:` the owning worker if a package owns the file; otherwise `<pre-existing-diagnosis>`. A `HELD:` DM means the worker paused mid-task with a committed partial step on its branch — resume it with `PROCEED` or `TASK:`; merge the branch only on a green `REPORT:`. A background worker's turn-end also surfaces as an Agent completion result — the DM body is authoritative; a completed turn is not a stopped worker. An `idle_notification` with no `REPORT:`, `CHECKPOINT:`, or `HELD:` means the worker is stuck — wake it with a DM inlining what it was waiting on.

When a task's `REVISE:` rounds stop producing new information (usually by the third), stop correcting: split it, re-scope it, or replace the worker with a fresh one given the restated task and the failed attempts.

Route contract questions and integration bugs to the worker that owns the affected package; bug fixes skip `runtime:tdd-bootstrap` — reproduce first. Workers do not message each other — contract questions come to you. Use the `Sender:` line, not timing or content, to attribute every inbound DM to its package — concurrent workers make timing-based attribution unreliable.

</checkpoints>

<integration-gate>

**Merge each green `REPORT:` as it lands, one branch at a time, from the card worktree.** Confirm `git status --porcelain` is empty, verify the reported HEAD SHA is the branch tip, then:

```bash
git merge --ff-only "[WORKER_BRANCH]" || git merge --no-edit "[WORKER_BRANCH]"
```

Resolve conflicts yourself; the merge is complete before the next merge starts or that worker's next task is sent. The merged commits are card work — attribute them if the session's attribution has not.

A wave is the set of tasks dispatched since the last step tag; a worker that reports green with nothing queued in the current wave idles until the gate runs. When every branch in the wave is merged: review cross-package consistency yourself, run workspace lint and typecheck plus each touched package's suite, reconcile any code-span/wiki anchors the diff affects, commit integration fixes per `<workspace-commit-style>` and `<markdown-guidelines>`, and tag `git tag -f "implement/$CARD_ID/step-N" HEAD`.

- **All pass** — tag, then dispatch the next wave (new tasks to existing workers, or a fresh worker per new package). When no work remains, return to the caller's next step with the roster live and idle — evaluation findings route back to the owning workers; drain per `<lifecycle>` before Step 4 Finalize.
- **Implementation error** (including a contract deviation) — `REVISE:` the owning worker with the failure; fix it yourself only when a round trip costs more than the fix.
- **Failure in files no package owns and not obviously this card's work** — apply `<pre-existing-diagnosis>`.

</integration-gate>

<lifecycle>

Workers stay live and idle between waves; stop one (`{"type": "shutdown_request"}`) only when its package is out of scope for the rest of the card, or at drain. **Drain** (required before `git reset`, `git clean`, Step 4 Finalize, or returning to planning): DM `HOLD` to every worker with a task in flight, wait for each `HELD:`, then `shutdown_request` every worker. Merge every branch whose work you keep per `<integration-gate>`, then for each package `remove-worktree "[WORKER_WORKTREE]"` and `git branch -D "[WORKER_BRANCH]"`. When draining to return to planning, carry the `HELD:` summaries and the triggering `BLOCKED` body into `./plan.md` as live context; delete the branches unmerged. Never repurpose an idle worker for an unrelated package — its context is stale; spawn a fresh one instead. **Refresh a worker** after roughly 6 tasks, or sooner when a report contradicts or forgets an earlier constraint: stop it, dispatch a fresh one for the same package on the same worktree and branch, and inline the current state (what's done, what's queued, live contracts) into its first task.

</lifecycle>

<model-selection>

`[MODEL]` defaults to the model that reliably handles most package work. Escalate to the strongest available model — either the package worker itself, or a one-off task dispatch per `<dispatch>` — only for system-level or cross-cutting work where early decisions shape the rest, never as the roster default. A lighter, cheaper model fits a package that is bounded, low-ambiguity, single-component work.

</model-selection>

