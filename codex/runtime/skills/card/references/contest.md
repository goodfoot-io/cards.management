# Parallel Planner Contest

Spawn multiple planner children in parallel plus one reviewer, hold the contest open until every live plan is approved and no planner is mid-revision, then have the reviewer select the strongest qualifier.

The orchestrator runs the contest as an ephemeral spawn tree: the planners and the reviewer are children spawned directly under the orchestrator. There is no team and no settlement handshake. All coordination is orchestrator-mediated — planners report up to the orchestrator, the orchestrator relays research and critiques between children, and the orchestrator routes the reviewer's findings and verdicts. The orchestrator decides closure by looking at the contest's state it has assembled from those reports, not by collecting confirmations from a peer roster.

Approval is the *qualifying bar*, not the finish line — `APPROVED` is sticky-but-revocable (see `<definitions>` and Closure below).

<definitions>

**Live planner.** A planner that has not reported `PLAN: BLOCKED for:planner_N` and has not been ruled `VERDICT: BLOCKED for:planner_N` by the reviewer. The set of live planners shrinks over the contest as planners self-quit or are disqualified. The orchestrator tracks the live set from the reports it has collected.

**Most recent report.** When multiple reports of the same shape exist for the same subject (e.g., several `VERDICT:` reports for `planner_1 round-1`), "most recent" means the latest one the orchestrator received. A later report for the same subject supersedes earlier ones — this is how revocation works: a `VERDICT: CHANGES_REQUESTED for:planner_N round-K` that arrives after a `VERDICT: APPROVED for:planner_N round-K` revokes the earlier approval.

</definitions>

<placeholder-variables>
[N_PLANNERS] — Number of parallel planners, chosen by the caller (2–4) by the size of the solution space
[PLANNER_EFFORT] — Chosen per planner slot: the effort tier that handles most planning work reliably by default; mix in the deepest tier for slots facing the deepest unknowns
[REVIEWER_EFFORT] — Chosen by the same unknowns-depth judgment as `[PLANNER_EFFORT]`: the deepest tier when the contest's unknowns run deep, otherwise the tier that handles most review work reliably
[WINNING_PLANNER] — The `planner_N` child the reviewer named in its `WINNER:` report
[WINNING_SLUG] — Semantically descriptive slug chosen from the winner's most recent `PLAN: READY` report (e.g., `initial`, `phase-2`, `schema-first`)
[PRE_EXISTING_UNAPPROVED_FILES] — Un-approved plan files (and sidecars) that existed before the contest and were not seeded as the incumbent; empty when none
</placeholder-variables>

<instructions>

## 1. Spawn the Planners

`spawn_agent` `[N_PLANNERS]` planner children in parallel, with `task_name`s `planner_1`, `planner_2`, ... `planner_[N_PLANNERS]`, and the reviewer (Step 2) in the same turn so its questions note lands before the planners' first round. Each planner writes its own plan file at `plans/[task_name].md`. Each child's `message` tells it to use `$runtime:card-planner`. Pass `[PLANNER_EFFORT]` as each planner's `agent_type` when a matching config role exists.

**Incumbent seeding.** If un-approved plan files already exist in `plans/` (e.g., a prior solo plan that never reached approval), pick the most substantive one and seed `planner_1` with it as the **incumbent**: `git mv` the file to `plans/planner_1.md` (and its `.meta.json` sidecar) before spawning, and add an `## Incumbent Role` section to `planner_1`'s message directing it to defend or refine that plan rather than draft from scratch. Skip seeding when the pre-existing plan is thin or clearly off-track — treat it as discarded prior art and run a normal contest. Other planners draft fresh as challengers either way; they may read the incumbent's file like any other peer plan.

Each planner's spawn `message`:

```
Use the $runtime:card-planner and $cards:notes skills.

## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]

Read the card from the card repository. Create a plan at `plans/[task_name].md`, investigate uncertainties, and report research findings to me, the orchestrator, as you work — I relay them to the reviewer and the other live planners, and relay theirs to you. Cheating off relayed peer findings and plan files is encouraged.

Follow the $runtime:card-planner skill from the top — it is the canonical source for the contest protocol, including round-numbered `PLAN: READY` reports, the post-approval revise-or-stay-put choice, and contest-end handling. Your `task_name` is `[task_name]`; report all findings, plan-state updates, and critiques to me.
```

## 2. Spawn the Reviewer

`spawn_agent` exactly one reviewer child (`task_name: plan_failure_mode`) in the same turn as the planners (Step 1), so its questions note lands before their first round. It reviews each plan as the orchestrator relays that plan's `PLAN: READY` report, and stays live until the contest closes. Its `message` tells it to use `$runtime:card-plan-failure-mode`. Pass `[REVIEWER_EFFORT]` as its `agent_type` when a matching config role exists:

```
Use the $runtime:card-plan-failure-mode and $cards:notes skills.

[N_PLANNERS] planners are working on parallel plans for this card. Each writes to `plans/planner_N.md`. I, the orchestrator, relay each planner's round-numbered `PLAN: READY` updates to you, and relay your findings, verdicts, and winner selection back to the planners.

Follow the skill from the top — it is the canonical source for the contest protocol, including round-tagged verdicts, retroactive approval revocation, the `BLOCKED for:planner_N` authority you hold over non-progressing planners, the `SELECT_WINNER` handler, and contest-end handling. Report all findings, verdicts, and the winner to me.

## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]
```

## 3. Mediate the Contest

Process the reports your children send and relay between them. Maintain a per-planner state machine in conversation context — round, verdict, live status — updated as each report arrives. Relay each message to the children that need it:

- A planner's `FINDING:` → relay to the reviewer and every other live planner.
- A planner's `CRITIQUE: <label> for:planner_N` → relay to the reviewer only (it adjudicates; never relay a critique to the targeted planner).
- A planner's `PLAN: READY for:planner_N round-K` → relay to the reviewer (so it evaluates the round) and to the other live planners (so they may steal or critique).
- The reviewer's streamed `FINDING:` / `MONOCULTURE:` → relay to the named planner(s).
- The reviewer's `VERDICT:` → relay to the targeted planner; a `VERDICT: BLOCKED for:planner_N` also goes to every other live planner so they update their live-set tracking.

Use `send_message` by task path to deliver each relay to a live child. A planner that is uncertain about contest state will ask you a plain-language question — answer from your in-memory state, or query the relevant child yourself if you need to verify.

Each planner moves along the state machine:

```
PLANNING → READY round-K ⇄ APPROVED round-K
                ↓
                CHANGES_REQUESTED round-K → revise → READY round-K+1

BLOCKED is terminal — entered by a self-reported `PLAN: BLOCKED` or by the
reviewer's `VERDICT: BLOCKED for:planner_N` ruling.
```

`APPROVED` is sticky-but-revocable: a question raised later by a peer's plan can drop an approved planner back into the revision loop. A planner that holds approval and is not revising has nothing more to send — that is what "done" looks like.

A reviewer that finishes its task with a `PLAN: READY` unanswered is a stall, never an implied verdict — re-engage it naming the planner and round.

A `VERDICT:` missing its `for:planner_N` or round tag updates no state — require a re-issue. A revocation of an `APPROVED` must name the planner, the round it revokes, and the witnessed finding; anything less does not reopen the field.

### Closure — Judgment, Not a Handshake

Close the contest when every planner in the live set holds `APPROVED` for its most recent `PLAN: READY round-K` and none is under an outstanding `CHANGES_REQUESTED` without a later `PLAN: READY round-K+1`. A planner that revises after approval does not announce it — it just revises and later reports a new `PLAN: READY round-K+1`. So "approved and silent" is indistinguishable from "approved and quietly revising," and you do not need to tell them apart: closing is safe even if a planner was mid-revision, because its next `PLAN: READY` reopens the field before any winner is finalized (Step 4). When several reports share the same subject, the latest supersedes earlier ones — that is how revocation works.

You can see every open revision from the reports you have collected; you do not need planners to certify the peer field back to you. A planner that holds approval and has gone quiet is done. An approved set with nothing in flight is closeable now — proceed to Step 4: Trigger Selection. If you find yourself tracking which peer round each planner has read, or waiting for a confirmation while a usable set of approved plans already exists, that is the signal to close, not to keep mediating.

The only things that legitimately reopen a closeable field: a planner choosing to revise because a peer's plan changed its answer to a real risk (it reports a new `PLAN: READY round-K+1`), or the reviewer retroactively revoking an approval. Absent one of those, do not wait.

### Convergence Collapse (Instrumented)

When every live plan has converged on the same architecture — the reviewer's `MONOCULTURE:` reports plus matching mechanisms across plan files are the signal — the design fork is settled. Record the collapse point (round and evidence) the moment the signal covers every live plan. From then on, at each `APPROVED` for a converged plan, either trigger Step 4 with `SELECT_WINNER (convergence collapse)` as the marker line — do not wait for the others to qualify — or append one card-note line stating why not; never continue silently. One deferral per collapse point: the next `APPROVED` for a converged plan triggers Step 4 unconditionally.

After the `WINNER:` report, before Step 5: `send_message` each losing live planner a red-team assignment naming `[WINNING_PLANNER]` — stop revising your own plan; report `CRITIQUE: ... for:[WINNING_PLANNER]` to the orchestrator for every real risk you find in the winning plan. Relay those critiques to the reviewer per §3; the reviewer verifies them, streams verified findings to the winner (relay them), and re-verdicts per its §5. Proceed to Step 5 once the winner holds `APPROVED` with no critique or finding in flight and every red-teamer has gone silent — since every critique routes through you, silence is the settle signal, same as Step 3 closure. Record the red-team yield (count of reviewer-verified findings) in a card note; this path is piloted.

**Lone-survivor case** is the special case where the live set has exactly one element: closure reduces to the survivor holding `APPROVED` for its most recent `PLAN: READY` round. You still trigger Step 4 — the reviewer's lone-survivor branch names the survivor without comparison.

### Other Outcomes from Step 3

- **All planners blocked.** No viable plan. Document the blocking reasons in a card comment, add the `blocked` tag, commit. Skip to Step 5: End the Contest with no winner, then return `BLOCKED` to the caller.
- **Contest in progress.** A live planner is mid-revision or under an outstanding `CHANGES_REQUESTED`. Continue mediating. Do not intervene.
- **Stalled planner.** A live planner stuck under `CHANGES_REQUESTED` without revising holds the contest open. The reviewer holds the disqualification authority and may BLOCK them per §5.1 of `$runtime:card-plan-failure-mode`; you do not BLOCK planners yourself. You may ask the planner its intent if its state is genuinely unclear to you.

Do not adjudicate findings. Route on the contest state you can see.

### Answering State Questions

A planner may ask you a plain-language question about contest state — peer rounds, who is live. Answer from the contest state you track. Examples:

- "What is planner_2's current round?" → "planner_2 is at round-3, APPROVED."
- "Is planner_4 still live?" → "No, planner_4 was BLOCKED by the reviewer in round 2."

If a question requires verification beyond what you know directly (e.g., "is planner_2 about to emit a new round?"), message that planner to ask, then synthesize a response to the original asker. Most questions resolve from your own state.

## 4. Trigger Selection

Before sending, confirm the reviewer's `plan-failure-mode-questions` note exists in the card repo's `notes/` — if missing, require it first.

`send_message` the reviewer requesting selection. Lead the message with the `SELECT_WINNER` marker; the body is empty or notes the closure-condition state for context:

```
SELECT_WINNER
Every live plan is approved and nothing is in flight; please confirm the field is closed and name a winner.
```

Two responses are possible:

- **`WINNER: planner_N`** from the reviewer: record `[WINNING_PLANNER] = planner_N`. Proceed to Step 5: End the Contest with a winner.
- **A fresh `VERDICT: CHANGES_REQUESTED for:planner_N round-K`** from the reviewer: the reviewer's final pass uncovered a question the plan no longer answers. The contest reopens — relay the verdict to the affected planner, the closure condition no longer holds, and you return to Step 3: Mediate the Contest.

A reviewer that names a winner overrides any earlier `CHANGES_REQUESTED` for that planner — the `WINNER:` report is the authoritative end signal.

## 5. End the Contest

This step runs on every exit path from Step 3 and Step 4 (winner, all-blocked, lone survivor).

Tell every still-live child that the contest has ended via `send_message`, so each finishes its task cleanly and returns control to you. The children auto-terminate when their tasks complete; wait for them to finish before proceeding. There is no team to delete.

If there is a winner, first append the open sub-blocking findings from the `WINNER:` body (label + witness) as a `## Known Open Findings` section at the end of `plans/[WINNING_PLANNER].md` — implementation inherits them and reads the plan, not your context. Then promote the winning plan and delete the losing planner files. Choose `[WINNING_SLUG]` from the winner's *most recent* `PLAN: READY` report body — use a semantically descriptive slug (e.g., `initial`, `phase-2`, `schema-first`). Then run, with `[WINNING_PLANNER]` and `[WINNING_SLUG]` substituted in:

```bash
cd $CARD_REPO_PATH

# Promote the winner to a semantic slug
git mv plans/[WINNING_PLANNER].md plans/[WINNING_SLUG].md
git mv plans/[WINNING_PLANNER].md.meta.json plans/[WINNING_SLUG].md.meta.json

# Remove the losing planner files and any pre-existing un-approved plan you chose not to
# seed. Never remove approved or implemented plans — follow-on work layers on them.
git ls-files 'plans/planner_*' [PRE_EXISTING_UNAPPROVED_FILES] | xargs -r git rm

git commit -m "[single sentence summarizing the winning approach]"
```

## 6. Return to Caller

- **Winner**: return `APPROVED` so the caller routes to implementation.
- **All planners blocked or no viable plan**: return `BLOCKED`.

</instructions>
