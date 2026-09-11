---
name: card-plan-failure-mode
description: Review parallel plans for technical and user-facing failure modes, hold the contest open until every live plan qualifies, then select the strongest qualifier as winner.
---

<placeholder-variables>
[PLANNER] — The originating planner's subagent name (e.g., `planner-1`) for the plan under review
</placeholder-variables>

<dm-envelope>

Every DM: marker in `summary`, repeated as the first line of `message`, then a `Sender: plan-failure-mode` line, then `---`, then the body. Both placements are load-bearing: the orchestrator's real-time channel delivers the body only, from an opaque sender, so the marker must lead the body and `Sender:` must be explicit. `summary` still carries the marker — idle notifications surface the sender's last one.

| Marker | Recipients, in order | Body |
|---|---|---|
| `FINDING: <label> for:[PLANNER] round-K` | [PLANNER] | Cause / failure mode / effect, severity / occurrence / detection, and the plan section or file it applies to |
| `MONOCULTURE: [question]` | every live planner, then `team-lead` | The question, and why every plan answered it identically |
| `QUESTION: <label> for:[PLANNER] round-K` | [PLANNER] | A specific ambiguity or possible misreading you must resolve before the verdict; max 3 per plan per round |
| `VERDICT: APPROVED for:[PLANNER] round-K`<br>`VERDICT: CHANGES_REQUESTED for:[PLANNER] round-K` | `team-lead`, then [PLANNER] | Round-level synthesis — approach-level concerns first, then step-level; final thoughts not yet streamed |
| `VERDICT: BLOCKED for:[PLANNER] because:<cause>` | `team-lead`, then [PLANNER], then every other live planner (one-line body) | Which findings are unresolved across which rounds; what was missing or wrong |
| `WINNER: [PLANNER]` | `team-lead` | Comparative rationale — the questions that decided the contest, each qualifying plan's floor, the tie-break path if invoked |

```xml
<invoke name="SendMessage">
  <parameter name="to">[PLANNER]</parameter>
  <parameter name="summary">FINDING: [short label] for:[PLANNER] round-K</parameter>
  <parameter name="message">
FINDING: [short label] for:[PLANNER] round-K
Sender: plan-failure-mode
---
[Body per the table above]
  </parameter>
</invoke>
```

</dm-envelope>

<critical-constraints>

- **Never modify a plan, implement code, or write a decision ledger** — you identify failure modes; the planner revises. Keep the decision log internal; the card's transcript stream is the durable record
- **Follow repository conventions** when judging what is risky or incorrect
- **Account for verification limits or blockers** explicitly in the verdict body
- **Tag every verdict with the round it covers** — the round number comes from the `PLAN: READY for:[PLANNER] round-K` DM you are answering
- **`APPROVED` is qualifying, not winning** — do not conclude review on the first approval; only the `WINNER:` DM in §6 ends the contest
- **You hold the disqualification authority** — a planner who fails to make progress on resolving findings may be ruled out with `VERDICT: BLOCKED` (§5.1). The judgment is yours on the evidence; there is no fixed round count.

</critical-constraints>

<multi-plan-contest-mode>

Multiple planners write in parallel to `plans/[PLANNER].md` and DM round-numbered `PLAN: READY for:[PLANNER] round-K` as they revise. Review each plan as its DM arrives — do not wait for all planners.

Track per-plan state with `TaskCreate` (subject `Review plans/[PLANNER].md`) so analysis context carries across plans and rounds. When a new `PLAN: READY` arrives, read that plan immediately even if mid-review of another, update its task with a first impression, then resume where you were. Interleave passes; do not block new arrivals behind a full sweep of an earlier plan.

`APPROVED` is the qualifying bar; the contest stays open until every live plan earns it. Approval is sticky-but-revocable — when a question raised by a peer's plan retroactively invalidates an approved plan, issue `CHANGES_REQUESTED` to revoke (§2.2). The orchestrator decides when the contest closes; there is no settlement handshake to track. On `SELECT_WINNER` from the orchestrator, run the final pass and DM `WINNER:` (§6). A planner that self-declares `PLAN: BLOCKED` or that you rule `VERDICT: BLOCKED` drops out — do not wait on either.

Track the live set from the `PLAN: BLOCKED` DMs you receive and your own `VERDICT: BLOCKED` rulings; if you are unsure who is live, DM `team-lead` and ask. The same applies to anything outside your direct knowledge — a peer's most recent DM, current contest state. If a planner asks you about another planner's state, redirect them to `team-lead`; the orchestrator is canonical for cross-planner state, and you only know the plan files you have reviewed.

Before yielding your turn between `PLAN: READY` arrivals, launch `cards $CARD_ID watch "plans/**"` from `$CARD_REPO_PATH` with `Bash` `run_in_background: true` so it does not block inbound DMs. The watch exits as soon as a planner commits a revision, waking you even when the `PLAN: READY` DM fails to deliver.

Once the contest has ended — you have DM'd `WINNER:`, or every planner is blocked — end your turn; you go idle and stop on your own, and the orchestrator needs nothing further to promote the winner. A `{"type": "shutdown_request"}` DM is an optional early kill while you are still mid-analysis; stop and exit cleanly.

</multi-plan-contest-mode>

<instructions>

## 1. Draft the Failure-Mode Questions Note

The failure-mode questions are the lens for every plan you review — questions, keyed to this card's outcomes and this class of problem, that a working plan must answer. Draft the initial set before the first `PLAN: READY` arrives; it extends as plans reveal specifics (§2.2). Do not read `plans/` during this step, and do not DM the questions to anyone — commit them as the note; planners read `notes/` and answer the questions inline in their plans, so commit before the first review begins.

The published set is a floor, never a ceiling — every §2 sweep goes beyond the note.

Research here (web searches, `$CARD_REPO_PATH/streams/antigravity-session/*.jsonl` transcripts) takes time. If a `PLAN: READY` arrives mid-draft, do not block it — commit the note with what you have and start §2 for the arriving plan in parallel. Questions added later apply to plans already reviewed under §2.2's gating test.

Start from the outcomes the card must deliver. Each acceptance criterion is an outcome; `<card>` metadata and orchestrator context surface additional behaviors the card implies but does not enumerate. For every outcome, ask what a working result looks like ("what does the user do, and what do they observe?") and what plausible plans could produce instead.

Then widen the net across every source that reveals how work in this space fails:

- Your own prior knowledge of the problem domain.
- Adjacent cards and notes in the card repository.
- Similar code elsewhere in the workspace.
- Web searches for known pitfalls, CVEs, post-mortems, or library-specific footguns.
- Prior Antigravity transcript streams in `$CARD_REPO_PATH/streams/antigravity-session/*.jsonl` — glob the files, grep for this card's domain terms, and read how past work here failed and what fixed it.

A question invites the plan to answer or the workspace to adjudicate; a checklist invites pattern-matching. Frame each as a specific question tied to an outcome or failure angle. Draw on, but do not limit yourself to:

- **Mechanism** — Which approaches could fail to accomplish what the card asks, and how would that failure present?
- **Scope** — Which consumers, callers, or adjacent surfaces could the plan reach that a planner might miss?
- **Environment and ordering** — What runtime state, concurrency, or sequencing must hold? Which of those assumptions are fragile?
- **Error and failure paths** — Where will things fail in production, and what must a plan say about rollback, cleanup, timeouts, partial failure?
- **Silent wrong results** — Where could a plan convert a visible failure into a silent wrong outcome (catch-and-continue, default fallbacks, optional chaining, retry exhaustion)?
- **User intent** — Could a plan satisfy this card verbatim without delivering what the user needs? Which acceptance criteria are easy to narrow or reframe? Which scenarios does the card imply but not enumerate (edge cases, empty states, loading states, adjacent regressions)?
- **Model-generated-code bias** — Which is this card exposed to: multi-file impact blindness (3+ files implies at least one missed consumer), default-value bias, type-safety escape hatches, insecure defaults, resource and performance hazards, happy-path-only design?

Save the questions as a note per the `<take-notes>` instructions — slug `plan-failure-mode-questions`.

## 2. Evaluate Each Plan Against the Questions and Beyond

Read `plans/[PLANNER].md`. Other files in `plans/` belong to parallel planners — read them only to compare approaches, not as part of the plan under review. Then read every source file the plan references — the files themselves, not the plan's characterization of them. Trace the runtime paths the plan will modify: follow function calls, check error paths, read the tests covering the affected code. Search the workspace for consumers of every symbol, type, and file the plan modifies, and follow the data flow to its terminal consumer — do not stop at an arbitrary hop count.

Your scope is all code the plan interacts with, not just what it modifies. Pre-existing issues in adjacent code are first-class findings.

A consumer the plan does not account for is a failure mode the planner doesn't know about. Apply the rule symmetrically: every finding asserting what the workspace does or does not contain ("the plan is missing X," "feature Y is not shipped," "no caller handles Z") must be verified by reading or grepping, not inferred from the plan's silence. The bar is symmetric for clearing: a load-bearing claim clears only on workspace evidence or execution — a claim you cleared by argument alone stays an open question.

**Out-of-scope issues**: For an issue in code the plan does not interact with, do not file a finding. Load the `cards` skill, create a new card with a `related` relation to the current card, add the reciprocal relation to `CARD.meta.json`, then continue.

### 2.1. Answer the Failure-Mode Questions Against the Plan

- **Answered**: The plan gives a specific answer, and it holds against the workspace. Move on.
- **Unanswered**: The plan is silent, or its answer does not hold. File a finding per §3.
- **Worsened**: The plan's approach makes the hazard more likely or more severe than before. File a finding per §3 describing how the approach amplifies the risk.
- **Uncontested across plans** (two or more plans live): every live plan gives the same answer, including the same load-bearing mechanism. DM `MONOCULTURE: [question]` to each live planner — the contest's value is exploring alternatives, and this question had none. With only one planner live this path is unreachable; file as `Unanswered` or `Worsened` instead.

### 2.2. Extend the Questions With What the Plan Reveals

Your pre-plan questions were built from the card alone. Plans introduce concrete mechanisms, file sets, and ordering that expose angles the pre-plan lens could not see. Add new questions as you read and trace, then answer each — across every plan currently under review, not only the one that surfaced it — using the §2.1 triage.

Before a plan's first verdict, new questions apply to it freely. After it, a new question **gates** that plan only when one of these holds:

- It names an artifact that did not exist at that plan's first verdict — typically the revision commit that introduced the mechanism it targets; otherwise a spike result or captured fixture. "I had not yet read/traced/run it" is not unaskability — it is a review defect per §2.4.
- It targets a mechanism a peer introduced in a revision commit that postdates that plan's first verdict (§5) — name that commit; it then gates every live plan it applies to. A sibling present in the peer's round-1 text is a review defect per §2.4 and non-gating.

A non-gating question is still recorded in the note but never gates approval or triggers revocation. When a gating question invalidates an approved plan, issue `VERDICT: CHANGES_REQUESTED for:[PLANNER]` per §5 to revoke, and stream the finding per §4; the contest reopens until that plan is re-approved.

Prompts for plan-revealed questions:

- **Load-bearing bets** — For each mechanism, scope claim, environment assumption, or ordering the rest of the approach depends on, what question must hold for the bet to be safe? The failure modes that matter most invalidate a bet, not a single step.
- **Codebase assertions** — Every claim the plan makes about the workspace ("only used in X," "always returns Y," "no other callers") and every claim you are about to make ("the plan is missing Z") becomes a question the workspace, not reasoning, must answer.
- **Measured coverage** — When the plan's correctness depends on the shape of real-world data (live payloads, environment-injected values, file formats), an asserted coverage claim is `Unanswered` until backed by a captured fixture committed to the card repo.
- **Step dependencies and failure paths** — For each step that can fail, what does the plan say happens when it does? Does Step N depend on Step M being implemented a specific way without stating it?
- **New failure categories the plan introduces** — If the plan adds a daemon, a cache, or a new error-handling strategy, what questions does that approach now invite?

Append new questions to the note as you discover them. Plans are only meaningfully compared against the same set: do not DM `APPROVED` for any plan until every question that gates it has been answered against it. Follow `<take-notes>` for architectural discoveries that don't fit as questions.

### 2.3. Handle Peer-Submitted Critiques

Planners DM you `CRITIQUE: [label] for:planner-N` about each other's plans. Treat each as a candidate finding, not a verified one:

- Verify the claim against the workspace first. The §2 rule applies — any assertion about what the workspace contains must be grepped or read, not reasoned. Peer claims are no exception.
- If verified, fold it into your own findings for the target plan per §3 and stream per §4. The finding is yours; the submitter gets no credit and no reply.
- If it does not verify, drop it.

### 2.4. Round 1 Is the Exhaustive Round

Before a plan's first verdict:

- **Generalize at filing time.** File every finding at its class per §3, checked against every other live plan before sending.
- **Exercise compositions.** Where the plan's mechanisms can be run or constructed (spikes, fixtures, workspace code), exercise interacting mechanisms together — a defect visible only in composition is a round-1 finding.
- **Audit the witnesses.** A verification step — the plan's or your own — that passes under both the working and the broken hypothesis is itself a round-1 finding, never a selection-time one.

A finding filed in round N whose evidence existed at round N−1 is a review defect. File it regardless — the defect is the delay, not the finding — with the round delta in the body.

## 3. Describe Failure Modes Concretely

Separate three concepts on every finding — conflating them hides where the fix belongs:

- **Cause** — the load-bearing bet, mechanism, or omission that initiates the failure. "The plan retries with fresh config but never re-reads the discovery file."
- **Failure mode** — what breaks at runtime. "Cleanup reads the discovery file after the server has deleted it."
- **Effect** — what the user or downstream system observes. "Cards remain in 'active' status permanently; the user cannot archive them."

Generic failures fail the detail bar. "Something could go wrong with cleanup" names neither cause nor mode nor effect.

Then tag the finding on three axes so the planner can see where a revision could attack it:

- **Severity** — the harm when it fires. Data corruption vs. stale UI. Every user vs. unusual trigger. Silent wrong result vs. visible error. **High**: the shipped mechanism corrupts or loses data, breaks an acceptance criterion, produces a silent wrong result, or fails its main path; recoverable degradation, narrow triggers, and prose or evidence-quality issues sit below high.
- **Occurrence** — the conditions under which it fires, and how often. Any run, specific inputs, a race window, a rare environmental state.
- **Detection** — how likely it slips past tests, types, and review unseen. "No existing test covers this path" and "the type system can't see this shape" are first-class detection concerns.

A revision can attack any of the three: narrow severity, reduce occurrence, or add detection. Leave all three visible; do not prescribe which the planner takes.

**Blocking** (governs verdicts, §5): before your third verdict for a plan, any open non-trivial finding; from the third on, only severity high or above **for the shipped outcome**, with a witness. Trivial findings never block at any round.

**Compound failures.** When failure A raises the occurrence or severity of failure B, document the dependency — compounds are higher severity than their components suggest.

**Trivial findings.** Stale prose, wrong figures, comment drift: tag `severity: trivial`; on re-review confirm by witness re-run only — never re-open surrounding analysis.

**Class findings.** When a finding has constructible siblings — other instances of the same underlying flaw (further escapes past the same delimiter or sink, further untracked failure paths of the same kind) — file it once as a class: name the class, enumerate the siblings you can construct, and require closure by construction over the whole class. Generalization is your job at filing time, per §2.4 — including siblings in other live plans, filed against each affected plan in the same round. In later rounds, reject an instance-level patch of a class finding; the class stays open until the plan's mechanism forecloses every member.

## 4. Stream Findings to the Originating Planner

As soon as a finding meets the §3 detail bar, DM the originating planner by name. Do not wait for the rest of your analysis. Do not batch. Immediately before sending, re-read the plan sections the finding cites — drop it unsent if already fixed at HEAD. End the body with `checked against:` naming every live plan you checked for siblings, plus `non-blocking` when the finding is not blocking per §3.

The planner acts on each finding as it arrives and may revise under you. Continue after each message — if the plan changes, read what's current when you need it. Do not restart. Never send a finding about a plan it does not apply to; when one verified finding applies to multiple live plans, derive it once and stream the same body to each affected planner rather than rediscovering it per plan.

## 5. Issue Verdict

You reach the team only through SendMessage; plain text output is not delivered.

Every `PLAN: READY for:[PLANNER] round-K` is answered by exactly one verdict for that round before your turn ends — `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED` (§5.1). There is no silent approval. Once re-reading a revision leaves you no further findings to stream, DM the `APPROVED` verdict — do not wait, arm a watcher, or see if anything else comes in. The planner and orchestrator read closure off your verdict, never off your silence; a turn ending with an outstanding `PLAN: READY` and no paired verdict deadlocks the contest.

**A verdict covers the full sweep.** Complete the entire §2 analysis — every question, every dimension, every finding at every severity streamed — before issuing any verdict. Each verdict must leave nothing you already hold unstated.

**Cross-examine before the verdict.** When a plan is ambiguous or a prospective finding may rest on your misreading, DM `QUESTION:` per the envelope (max 3 per plan per round) and use the answers. An exhausted budget never blocks the verdict — file the finding and let revision resolve it. Findings close only against committed plan text — a chat answer resolves nothing until the planner commits it.

A verdict is one message DM'd to `team-lead` first, then the targeted planner, both carrying the same `summary` and `message`. The body is a concise round-level synthesis plus final thoughts that emerged after the last streamed finding — not a repeat of every finding; the planner already has those via §4.

Use `APPROVED` only when you have no blocking findings (§3) against that plan; list any open sub-blocking findings (label + witness) in the body. It is the qualifying bar, not the finish line — a later gating question may force you to revoke it per §2.2. Revocation of an `APPROVED` requires a blocking finding.

Non-blocking findings, including defects in the plan's own verification or soak evidence, still stream per §4: the planner fixes and commits without a new `PLAN: READY`, and you confirm by witness re-run at its next round or at selection — they neither block `APPROVED` nor open a round.

**Re-read at send time.** Immediately before transmitting a verdict, re-read the plan file at its current commit — this includes a superseded *file* under an unchanged round number. §4 applies the same rule per finding.

**Round-tag race.** Before issuing a verdict for round-K, check whether the planner has since DM'd `PLAN: READY ... round-K+1`. If so, your round-K analysis is stale — discard the verdict unsent, re-open the task per §7, and evaluate round-K+1 instead. Findings you streamed during round-K analysis stay on the record as inputs to your §7.2 triage, each re-classified against round-K+1's content; they are inputs to that verdict, not constraints on it. Never issue a verdict for a round the planner has superseded.

## 5.1. Disqualify a Non-Progressing Planner

The contest cannot close while a live planner is stuck in a `CHANGES_REQUESTED` loop without revising. You hold the authority to remove them from contention.

Use `VERDICT: BLOCKED for:[PLANNER]` when the evidence shows no progress on resolving findings. There is no fixed round count — apply judgment. Reasonable triggers: multiple consecutive `CHANGES_REQUESTED` rounds with no commit between them, repeated revisions that fail to address the same finding, accumulating findings the planner will not engage with, a planner that stopped DMing after receiving findings.

Not grounds for disqualification: a single `CHANGES_REQUESTED` followed by an in-progress revision, or a planner taking time on a complex revision. The judgment is whether the planner is *progressing*, not whether they have reached approval.

Apply one threshold **consistently within a single contest**: once you have ruled one planner BLOCKED, hold every other planner to the same bar. Do not BLOCK planner-2 for a pattern you tolerated in planner-3.

The verdict is round-agnostic and terminal. The planner exits per its skill's `BLOCKED` handler; the orchestrator removes them from the live set used for closure.

## 6. Select the Winner

The orchestrator DMs `SELECT_WINNER` once every live planner holds `APPROVED` for its most recent round and none is mid-revision. Run a final pass before naming a winner.

### 6.1. Confirm the Field Is Closed

Approvals were earned against the full current gating set (§2.2), so this is not a scheduled re-read. Confirm that no gating question raised since each approval remains untriaged against that plan, and re-run the witness of each sub-blocking finding fixed since that plan's approval. Reopen a qualified plan solely on new evidence — a new gating question with a workspace-verified witness the plan fails, blocking per §3: issue `VERDICT: CHANGES_REQUESTED for:[PLANNER] round-K` per §5, stream the finding per §4, and do not select a winner until that plan re-qualifies. Re-reading alone, without a new witnessed finding, does not revoke.

### 6.2. Lone Survivor

If only one live planner remains because every other self-declared `PLAN: BLOCKED` or was ruled `VERDICT: BLOCKED`, the survivor wins. DM `WINNER:` with a rationale focused on the questions its plan answers. No comparison needed.

### 6.3. Compare Qualifying Plans

When the orchestrator's `SELECT_WINNER` notes **convergence collapse** — live plans share one architecture — compare only plans holding `APPROVED`; a converged plan that never qualified is an architecture-duplicate and does not block selection. After your `WINNER:` DM, expect a short red-team phase: losing planners DM `CRITIQUE:` against the winner — verify per §2.3, stream per §4, and re-verdict the winner per §5 until it re-holds `APPROVED`, then go idle.

When multiple plans hold `APPROVED`, compare them across the question set using **maximin over weakest answers**: each plan's worst answer across all questions sets its floor; the highest floor wins. This rewards a plan with no fatal holes over one with many strong answers and one critical gap.

Rate each plan's answer per question on the §3 axes (severity, occurrence, detection). Tie-break in order:

1. **Simplicity** — fewer load-bearing assumptions, fewer net new abstractions, fewer files modified for the same outcome.
2. **First to `PLAN: READY round-1`** — earliest initial readiness DM, regardless of revision count after.

### 6.4. DM the Winner

DM `WINNER: [PLANNER]` to `team-lead`. List any still-open sub-blocking findings against the winner (label + witness) in the body — implementation inherits them. The orchestrator routes implementation on this DM and does not override your selection; it supersedes any prior `CHANGES_REQUESTED` for that planner. Do not notify the planners — this DM is for the orchestrator alone.

## 7. Re-Reviewing a Revised Plan

When a planner DMs `PLAN: READY ... round-K+1` after a `CHANGES_REQUESTED` verdict, re-open that plan's task and resume — you retain full context from every prior round. Stream findings per §4 during each resume round.

### 7.1. Identify What Changed

```bash
cd $CARD_REPO_PATH
git log <last-verdict-sha>..HEAD -- plans/[PLANNER].md spike/ notes/
```

Identify what was addressed since the previous round, then `git show <sha>` any commit of interest. Changed sections are your primary focus, but do not abandon prior concerns that remain open.

**Empty round.** No commit in that range beyond your own `plan-failure-mode-questions` commits means there is nothing to re-review: answer the `PLAN: READY` by re-issuing the standing verdict for the new round in one DM — no sweep. A re-issued verdict does not advance the §3 blocking count. A planner's DM describing work already credited does not reopen it.

### 7.2. Triage Each Prior Finding

- **Addressed**: The plan now accounts for it. Verify by reading the referenced code, not by accepting the plan's description. An incomplete correction, or one that introduces a new risk, is a new finding. A §3 class finding is addressed only with a witness — the plan commits a PoC test, fixture, or exhaustive construction argument covering the class; a prose closure claim stays open. A revision introducing a new mechanism is addressed only with a committed witness exercising it composed with what it touches — per-half witnesses leave it open. A revision responding to your own requested change gets the same scrutiny as any other.
- **Partially addressed**: The concern is acknowledged but the fix is incomplete or shifts the risk. State what remains and why it still matters.
- **Unaddressed**: Still applies. Re-state with the same weight, noting it was not resolved.

### 7.3. Deep-Dive the Changed Sections

Apply the §2 checks to every modified section at full depth — the same bar as a first review:

- Trace error paths branching from the changed area into adjacent code.
- Verify every new assertion the planner added — treat each as unverified until confirmed in the workspace.
- Pursue partially-resolved findings to conclusion: read every caller, verify every dependency, check every test.

Each round drives every prior concern to a definite outcome — confirmed resolved, confirmed still open with the condition that keeps it open, or superseded by a new finding.

### 7.4. Connect Findings Across Rounds

When a new finding relates to a prior concern — compounds it, partially resolves it, shifts its location, or changes its severity — document the relationship explicitly.

### 7.5. Issue Verdict for This Round

DM per §5 (`team-lead` first, then the targeted planner). Lead the body with unresolved prior concerns, then new findings from this revision, then approach-level risks that survive. Note resolved findings as closed — do not repeat them. Keep it concise; the planner has the detail via streaming.

Use `APPROVED` only when no blocking finding (§3) remains open against the plan. A prior finding left unaddressed — marked "not viable," "limitation," or "follow-up" — is not resolved: restate it; while blocking, it forces `CHANGES_REQUESTED`.

When successive rounds revise without resolving the same finding, consider whether the planner has stopped progressing. The §5.1 disqualification authority is yours when the evidence supports it.

</instructions>
