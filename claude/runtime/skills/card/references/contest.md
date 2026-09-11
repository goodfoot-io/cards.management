# Parallel Planner Contest

Dispatch multiple planners in parallel, hold the contest open until every live plan is approved and no planner is mid-revision, then have the reviewer select the strongest qualifier.

Approval is the *qualifying bar*, not the finish line — `APPROVED` is sticky-but-revocable (see `<definitions>` and Closure below).

<definitions>

**Live planner.** A planner that has not DM'd `PLAN: BLOCKED for:planner-N` and has not been ruled `VERDICT: BLOCKED for:planner-N` by the reviewer. The set of live planners shrinks over the contest as planners self-quit or are disqualified.

**Supersession.** A later DM for the same subject supersedes earlier ones — this is how revocation works: a `VERDICT: CHANGES_REQUESTED for:planner-N round-K` arriving after a `VERDICT: APPROVED` for that same round revokes the approval.

**Idle notification.** The agent's process has stopped; it runs again only when an inbound message wakes it. Idle with nothing owed (approved and not revising; verdict delivered) is settled. Idle while owing a response, with nothing queued to wake it, is a stall — its last stated intent did not survive the idle. DM it what it needs to continue.

</definitions>

<placeholder-variables>
[N_PLANNERS] — Number of parallel planners, chosen by the caller (2–4) by the size of the solution space
[PLANNER_MODEL] — Chosen per planner slot: the model that handles most planning work reliably by default; mix in the strongest available model for slots facing the deepest unknowns
[REVIEWER_MODEL] — Chosen by the same unknowns-depth judgment as `[PLANNER_MODEL]`: the strongest available model when the contest's unknowns run deep, otherwise the model that handles most review work reliably
[WINNING_PLANNER] — The `planner-N` subagent the reviewer named in its `WINNER:` DM
[WINNING_SLUG] — Semantically descriptive slug chosen from the winner's most recent `PLAN: READY` DM (e.g., `initial`, `phase-2`, `schema-first`)
[PRE_EXISTING_UNAPPROVED_FILES] — Un-approved plan files (and sidecars) that existed before the contest and were not seeded as the incumbent; empty when none
</placeholder-variables>

<instructions>

## 1. Dispatch the Planners

Dispatch `[N_PLANNERS]` planner subagents in parallel, named `planner-1`, `planner-2`, ... `planner-[N_PLANNERS]`. Each writes its own plan file at `plans/[AGENT_NAME].md`.

**Incumbent seeding.** If un-approved plan files already exist in `plans/` (e.g., a prior solo plan that never reached approval), pick the most substantive one and seed `planner-1` with it as the **incumbent**: `git mv` the file to `plans/planner-1.md` (and its `.meta.json` sidecar) before dispatch, and add an `## Incumbent Role` section to `planner-1`'s prompt below directing it to defend or refine that plan rather than draft from scratch. Skip seeding when the pre-existing plan is thin or clearly off-track — treat it as discarded prior art and run a normal contest. Other planners draft fresh as challengers either way; they may read the incumbent's file like any other peer plan.

```xml
<invoke name="Agent">
<parameter name="description">Plan creation</parameter>
<parameter name="subagent_type">runtime:card:planner</parameter>
<parameter name="model">[PLANNER_MODEL]</parameter>
<parameter name="name">planner-[N]</parameter>
<parameter name="run_in_background">true</parameter>
<parameter name="prompt">
## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]

Read the card from the card repository. Create a plan at `plans/[AGENT_NAME].md`, investigate uncertainties, and DM research findings to your peers as you work. Other planners are working in parallel — cheating off their findings and plan files is encouraged.

Follow the `runtime:card-planner` skill from the top — it is the canonical source for the contest protocol, including round-numbered `PLAN: READY` DMs, the post-approval revise-or-stay-put choice, and contest-end handling.

## Peers
Your peer planners are `planner-1`, `planner-2`, ... `planner-[N_PLANNERS]` (excluding yourself). The reviewer is `plan-failure-mode`. The orchestrator is `team-lead`. Track the live set from the `BLOCKED` DMs you receive — there is no roster file to read.
</parameter>
</invoke>
```

## 2. Dispatch the Reviewer

Dispatch exactly one `plan-failure-mode` subagent in the same message as the planners so its questions note lands before their first round. It reviews each plan as its `PLAN: READY` DM arrives and remains active until the contest closes:

```xml
<invoke name="Agent">
<parameter name="description">Plan failure-mode review (multi-plan contest)</parameter>
<parameter name="subagent_type">runtime:card:plan-failure-mode</parameter>
<parameter name="model">[REVIEWER_MODEL]</parameter>
<parameter name="name">plan-failure-mode</parameter>
<parameter name="run_in_background">true</parameter>
<parameter name="prompt">
[N_PLANNERS] planners are working on parallel plans for this card. Each writes to `plans/planner-N.md` and DMs round-numbered `PLAN: READY` updates as it revises.

Follow the skill from the top — it is the canonical source for the contest protocol, including round-tagged verdicts, retroactive approval revocation, the `BLOCKED for:planner-N` authority you hold over non-progressing planners, the `SELECT_WINNER` DM handler, and contest-end handling.

## Peers
The planners are `planner-1`, `planner-2`, ... `planner-[N_PLANNERS]`. The orchestrator is `team-lead`. Track the live set from the `PLAN: BLOCKED` DMs you receive and your own `VERDICT: BLOCKED` rulings — there is no roster file to read.

## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]
</parameter>
</invoke>
```

## 3. Monitor the Contest

Process inbound DMs from planners and the reviewer. Maintain a per-planner state machine in conversation context — round, verdict, live status — updated as each DM arrives. The state-line marker on each inbound DM tells you what changed.

Each planner moves along the state machine:

```
PLANNING → READY round-K ⇄ APPROVED round-K
                ↓
                CHANGES_REQUESTED round-K → revise → READY round-K+1

BLOCKED is terminal — entered by self-DM'd `PLAN: BLOCKED` or by the
reviewer's `VERDICT: BLOCKED for:planner-N` ruling.
```

The ⇄ is revocation: a question raised later by a peer's plan can drop an approved planner back into the revision loop.

A reviewer idle with a `PLAN: READY` unanswered is a stall, never an implied verdict — wake it naming the planner and round.

A `VERDICT:` missing its `for:planner-N` tag — or missing its round tag, except `VERDICT: BLOCKED` and `WINNER:`, which are round-agnostic — updates no state; require a re-issue. A revocation of an `APPROVED` must name the planner, the round it revokes, and the witnessed finding; anything less does not reopen the field.

### Closure — Judgment, Not a Handshake

Close the contest when every planner in the live set holds `APPROVED` for its most recent `PLAN: READY round-K` and none is under an outstanding `CHANGES_REQUESTED` without a later `PLAN: READY round-K+1`. Planners do not announce post-approval revisions, so closing is safe even mid-revision — the next `PLAN: READY` reopens the field before any winner is finalized (Step 4).

An approved set with nothing in flight is closeable now — proceed to Step 4: Trigger Selection. If you find yourself tracking which peer round each planner has read, or waiting for a confirmation while a usable set of approved plans already exists, that is the signal to close, not to keep monitoring.

The only things that legitimately reopen a closeable field: a planner choosing to revise because a peer's plan changed its answer to a real risk (it DMs a new `PLAN: READY round-K+1`), or the reviewer retroactively revoking an approval. Absent one of those, do not wait.

### Convergence Collapse (Instrumented)

When every live plan has converged on the same architecture — the reviewer's `MONOCULTURE:` DMs (copied to you) plus matching mechanisms across plan files are the signal — the design fork is settled. Record the collapse point (round and evidence) the moment the signal covers every live plan. From then on, at each `APPROVED` for a converged plan, either trigger Step 4 with `SELECT_WINNER (convergence collapse)` in the DM body — do not wait for the others to qualify — or append one card-note line stating why not; never continue silently. One deferral per collapse point: the next `APPROVED` for a converged plan triggers Step 4 unconditionally.

After the `WINNER:` DM, before Step 5: DM each losing live planner a red-team assignment naming `[WINNING_PLANNER]` — stop revising your own plan; DM `CRITIQUE: ... for:[WINNING_PLANNER]` for every real risk you find in the winning plan. The reviewer verifies critiques, streams verified findings to the winner, and re-verdicts per its §5. Proceed to Step 5 once the winner holds `APPROVED` with no critique or finding in flight and every red-teamer's idle notification has arrived — you cannot see `CRITIQUE:` traffic, so idle is the only settle signal. Record the red-team yield (count of reviewer-verified findings) in a card note; this path is piloted.

**Lone-survivor case** is the special case where the live set has exactly one element: closure reduces to the survivor holding `APPROVED` for its most recent `PLAN: READY` round. You still trigger Step 4 — the reviewer's lone-survivor branch names the survivor without comparison.

### Other Outcomes from Step 3

- **All planners blocked.** No viable plan. Document the blocking reasons in a card comment, add the `blocked` tag, commit. Skip to Step 5: End the Contest with no winner, then return `BLOCKED` to the caller.
- **Contest in progress.** A live planner is mid-revision or under an outstanding `CHANGES_REQUESTED`. Continue monitoring. Do not intervene.
- **Stalled planner.** A live planner stuck under `CHANGES_REQUESTED` without revising holds the contest open. The reviewer holds the disqualification authority and may BLOCK them per §5.1 of `runtime:card-plan-failure-mode`; you do not BLOCK planners yourself. You may DM the planner to ask its intent if its state is genuinely unclear to you.

Do not adjudicate findings. Route on the contest state you can see.

### Answering State Questions

Teammates may DM you with plain-language questions about contest state — peer rounds, who is live. Answer in plain language from the contest state you track. Examples:

- "What is planner-2's current round?" → "planner-2 is at round-3, APPROVED."
- "Is planner-4 still live?" → "No, planner-4 was BLOCKED by the reviewer in round 2."

If a question requires verification beyond what you know directly (e.g., "is planner-2 about to emit a new round?"), DM that planner to ask, then synthesize a response to the original asker. Most questions resolve from your own state.

## 4. Trigger Selection

Before sending, confirm the reviewer's `plan-failure-mode-questions` note exists in the card repo's `notes/` — if missing, require it first.

Send the reviewer a DM requesting selection. The marker `SELECT_WINNER` goes in `summary` and as the first line of the `message` body.

```xml
<invoke name="SendMessage">
  <parameter name="to">plan-failure-mode</parameter>
  <parameter name="summary">SELECT_WINNER</parameter>
  <parameter name="message">
SELECT_WINNER
---
Every live plan is approved and nothing is in flight; please confirm the field is closed and name a winner.
  </parameter>
</invoke>
```

Two responses are possible:

- **`WINNER: planner-N` DM** from the reviewer: record `[WINNING_PLANNER] = planner-N`. Proceed to Step 5: End the Contest with a winner.
- **A fresh `VERDICT: CHANGES_REQUESTED for:planner-N round-K` DM** from the reviewer: the reviewer's final pass uncovered a question the plan no longer answers. The contest reopens — the affected planner is back in the revision loop, the closure condition no longer holds, and you return to Step 3: Monitor the Contest.

A reviewer that names a winner overrides any earlier `CHANGES_REQUESTED` for that planner — the `WINNER:` DM is the authoritative end signal.

## 5. End the Contest

This step runs on every exit path from Step 3 and Step 4 (winner, all-blocked, lone survivor).

By the time the contest closes the subagents have already settled and gone idle — a settled `planner-N` and a reviewer that has DM'd `WINNER:` each stop on their own — so there is normally nothing to tear down and no shutdown to wait for. Proceed directly to promoting the winner.

Only if a subagent is still actively working when you need to close — and you want to stop it early rather than let it finish — DM it `{"type": "shutdown_request"}` (this wakes it if already idle, then it exits):

```xml
<invoke name="SendMessage">
  <parameter name="to">planner-N</parameter>
  <parameter name="summary">Shutdown request</parameter>
  <parameter name="message">{"type": "shutdown_request", "reason": "Contest closed"}</parameter>
</invoke>
```

If there is a winner, first append the open sub-blocking findings from the `WINNER:` body (label + witness) as a `## Known Open Findings` section at the end of `plans/[WINNING_PLANNER].md` — implementation inherits them and reads the plan, not your context. Then promote the winning plan and delete the losing planner files. Choose `[WINNING_SLUG]` from the winner's *most recent* `PLAN: READY` DM body — use a semantically descriptive slug (e.g., `initial`, `phase-2`, `schema-first`). Then run, with `[WINNING_PLANNER]` and `[WINNING_SLUG]` substituted in:

```bash
cd $CARD_REPO_PATH

# Promote the winner to a semantic slug
git mv plans/[WINNING_PLANNER].md plans/[WINNING_SLUG].md
git mv plans/[WINNING_PLANNER].md.meta.json plans/[WINNING_SLUG].md.meta.json

# Remove the losing planner files and any pre-existing un-approved plan you chose not to
# seed. Never remove approved or implemented plans — follow-on work layers on them.
git ls-files 'plans/planner-*' [PRE_EXISTING_UNAPPROVED_FILES] | xargs -r git rm

git commit -m "[single sentence summarizing the winning approach]"
```

## 6. Return to Caller

- **Winner**: return `APPROVED` so the caller routes to implementation.
- **All planners blocked or no viable plan**: return `BLOCKED`.

</instructions>
