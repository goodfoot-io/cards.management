# Evaluator Wave

Independent adversarial evaluation via spawned evaluator children. Entered from `./implementation-evaluation.md` Step 3 (or `./validate.md` Step 4) with changes committed, validation passing, and a clean tree.

The evaluator children form an ephemeral spawn tree under you. You spawn them directly in Step 1, and they report their result to you when their task completes.

<placeholder-variables>
[HEAD_SHA] — The commit under evaluation; the tree must be clean at dispatch
[EFFORT] — Chosen by the diff's scope and risk, same criteria as `./developer-wave.md`'s `<effort-selection>`
</placeholder-variables>

<instructions>

## 1. Spawn Evaluators

Diff `implement/[CARD_ID]/baseline..HEAD`. **Choose which evaluators to spawn by judgment**: `failure_mode` always; add `experience_evaluator` when the change materially touches user-facing behavior, acceptance criteria are experiential, or the card's value is only observable from its entry points. Spawning both is "Deep"; adjust the peer references in the messages to match.

Read the diff and the card before writing the spawn messages — each must reflect this implementation and this card. Record the HEAD SHA you spawn against and inline it in every message. When spawning both evaluators, issue both `spawn_agent` calls in the same turn. Pass `[EFFORT]` as each evaluator's `agent_type` when a matching config role exists.

For the `failure_mode` child (`task_name: failure_mode`), the `message`:

```
Use the $runtime:card-failure-mode skill and follow it from the top. Record each finding with a `FINDING:` marker and report a `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED` as your final message to me, the orchestrator that spawned you. On Deep depth I relay the experience-evaluator's findings to you for cross-evaluator critique; include any `CRITIQUE: <label>` responses in your report and I relay them back. After fix commits land I re-engage you to re-evaluate — extend the questions, triage prior findings, and report a fresh verdict.

## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]

## Baseline
Evaluate commit [HEAD_SHA]; changes are `implement/[CARD_ID]/baseline..HEAD`. Never evaluate the working tree — if `git status --porcelain` is non-empty, report the dirty paths to me instead of a verdict.

## Validation
All validation has passed. Focus on runtime behavior, semantic failures, and gaps the validation suite does not cover.

[Describe the specific failure risks this implementation presents. Where does the diff suggest the implementer's attention was concentrated, and where are the blind spots most likely? Which runtime paths are unexercised by tests, which contracts may drift silently, and which consumer assumptions break?]
```

For **Deep**, also spawn the `experience_evaluator` child (`task_name: experience_evaluator`) with the `message`:

```
Use the $runtime:card-experience-evaluator skill and follow it from the top. Record each finding with a `FINDING:` marker and report a verdict as your final message to me, the orchestrator that spawned you. I relay the failure-mode evaluator's findings to you for cross-evaluator critique; include any `CRITIQUE: <label>` responses in your report and I relay them back. After fix commits land I re-engage you to re-evaluate — extend the questions, triage prior findings, and report a fresh verdict.

## Card Repository
[CARD_REPO_PATH]

## Workspace
[WORKSPACE_PATH]

## Baseline
Evaluate commit [HEAD_SHA]; changes are `implement/[CARD_ID]/baseline..HEAD`. Never exercise the working tree — if `git status --porcelain` is non-empty, report the dirty paths to me instead of a verdict.

## Validation
All validation has passed. Focus on what a user would experience as broken, wrong, or missing that the validation suite does not cover.

[Translate the card's requirements into user scenarios this implementation must satisfy: acceptance criteria to verify, user-facing entry points, what a user testing against the card should do and observe.]
```

When an evaluator needs to compare behavior against the pre-implementation state, spawn a `$runtime:card-pre-existing-condition` child with the behavior under investigation and the card's diff scope rather than running the comparison in the active workspace.

## 2. Collect Verdicts and Route

Each evaluator child returns a structured final report to you when its task completes, and on a live re-evaluation reports a fresh verdict via the same channel:

- **`FINDING:` entries**: Record each finding (short label and body) — what you need to route it into a developer wave in Step 3 and brief the evaluators after fixes land.
- **`VERDICT:` line**: Record the verdict for this round. From a `CHANGES_REQUESTED` body, capture each blocking finding's mechanism requirement and witness matrix — the developer wave is briefed from the verdict bodies, not the earlier streamed findings. From an `APPROVED` body, capture the open sub-blocking list (label + witness) — it is the pre-finalize sweep's only input.

On Deep depth you mediate cross-evaluator critique: relay each evaluator's `FINDING:` entries to the peer evaluator (via `send_message` if the peer is still live, or inlined into the peer's next resume or spawn message), and relay any `CRITIQUE: <label>` an evaluator includes back to the evaluator it targets. If an evaluator verifies a relayed critique and folds it into its own findings, it returns that as a fresh `FINDING:` in its report. Treat each `FINDING:` as a record from its sender — do not deduplicate across evaluators.

Continue until every spawned evaluator has reported a `VERDICT:` for the current round. Before accepting a `VERDICT: APPROVED`, confirm the evaluator's questions note (`failure-mode-questions` or `user-outcome-questions`) is committed in the card repo's `notes/`; if missing, re-engage the evaluator to publish it and re-issue — an unnoted `APPROVED` does not count. A `CHANGES_REQUESTED` counts without its note; if the note is missing at round 1, add "publish your questions note before your next verdict" to that lane's Step 5 re-evaluation message. Do not spawn or re-engage developer workers while any evaluator is still mid-round. Do not adjudicate findings — route on the verdict. A retracted finding is dropped; one under peer critique stays in the wave until its owner retracts it. You may not override a verdict, reclassify a finding as a "limitation" or "follow-up," or document it as a known issue in lieu of fixing it.

An `idle_notification` or a report that arrives without a verdict means the evaluator's process has stopped; it runs again only when you re-engage it. An evaluator that reported dirty paths instead of a verdict is the exception. Commit or revert the outstanding changes, then re-engage that lane with the new HEAD SHA — never spawn a fresh replacement, which would re-open findings already accepted.

Otherwise, an evaluator that finished without a usable verdict, or that cannot run, is a judgment call: spawn a fresh replacement, or BLOCKED per the branch below. Re-engage the lane first — `send_message` if live, `resume_agent` if completed — never spawn a replacement without a failed re-engagement attempt on record. A fresh replacement is a new child with no prior context: spawn it through Step 1, evaluating current HEAD from scratch — point it at its lane's questions note in the card repo's `notes/`, inline the known prior-round findings for its lane, and state the round number it inherits.

A mixed set — one evaluator approves while another requests changes — is CHANGES_REQUESTED.

- **All APPROVED** (every spawned evaluator): Proceed to Step 6: Finalize. This is the only path to Finalize.
- **Any CHANGES_REQUESTED**: Proceed to Step 3: Dispatch Developer Team with the recorded findings. You do not fix evaluator findings — the developer team does.
- **BLOCKED** (an evaluator names an external constraint preventing the fix): Document the constraint and the specific finding in a comment, add `blocked` to `tags` in `CARD.meta.json`, commit, then **STOP**.

## 3. Dispatch Developer Team

Group the findings by the package they touch and route each group to the owning worker per `./developer-wave.md` — spawn a fresh worker for a package with none yet. Inline every finding the worker must address into its task — full body, its mechanism requirement and witness matrix from the verdict, and the file or runtime path; do not stream new findings to a worker mid-task. Developer-team workers are **not** part of the evaluation group and receive no follow-up messages from evaluators. Add to each task's Workflow: implement the finding's stated mechanism — not a patch of the flagged instance — and land a green in-suite control for every witness-matrix entry; a fix introducing a new mechanism lands with a regression test and an end-to-end exercise of the mechanism composed with what it touches; report each witness (matrix entry or mechanism → test/command) in the `REPORT:`.

## 4. Validate and Commit

Merge every worker's branch per `./developer-wave.md`'s `<integration-gate>`. Lint and typecheck, then re-run the affected tests, broadening to each touched package's suite. Commit — or fix mechanical errors inline, or send an implementation error back to the owning worker. Confirm every witness-matrix entry is pinned by a green in-suite control and every new mechanism carries its regression test and composed exercise — a matrix entry covered only by a manual run, or a mechanism without its test, is an implementation error; send it back.

If you arrived from the caller's pre-evaluation validation failure, return there; otherwise proceed to Step 5.

## 5. Trigger Re-Evaluation

Re-engage every evaluator lane against the revised implementation. If an evaluator is still live, `send_message` it the re-evaluation context by its task path; if its task already completed, `resume_agent` it and send the same context — it resumes per its skill's "When Resuming" path. Only if re-engagement fails, `spawn_agent` a fresh child for that lane and inline its prior findings plus the re-evaluation context into the spawn `message`.

Give it the new HEAD SHA, the commit range, a plain account of what the wave changed and why, and anything the wave could *not* fix. The literal `RE_EVALUATE` marker wakes the evaluator's resume behavior — a free-form status message with the same content does not.

```
The implementation has been updated to address the prior round's findings. Re-evaluate against commit [HEAD_SHA]; the tree is clean at that commit.

Fix commits: implement/[CARD_ID]/baseline..HEAD (this wave: [SHA list])
What changed and why: [a plain account — which findings the wave addressed and how, in enough detail to re-check]
New witnesses: [mechanism → test/command, for each new mechanism the wave introduced — omit if none]
In-suite controls: [finding → matrix entry → committed test, for each entry the wave pinned — omit if none]
Not fixed: [any finding the wave could not address, and why — including findings a worker disputed, with its reasoning; omit if none]

RE_EVALUATE
```

For Deep, deliver the same message to the `experience_evaluator` lane.

Each evaluator resumes and reports a fresh verdict — return to Step 2 until every evaluator reports `APPROVED`, or a BLOCKED branch fires.

## 6. Finalize

Enter only when every spawned evaluator has reported `VERDICT: APPROVED` for the current round.

**Pre-finalize sweep.** If sub-blocking findings or witness repairs remain open (the lists from the `APPROVED` bodies), dispatch one final developer wave for them per Step 3, scoped to the listed findings' own files — no discretionary refactoring. Validate and commit per `./developer-wave.md`'s gate — do **not** route into Step 5 — then re-run each repaired witness yourself and run the caller's validation commands. If a witness re-run fails or validation cannot pass, fall back to Step 5. Skip the sweep when nothing is open.

The evaluator children auto-terminate when their tasks complete — wait for any still-live evaluator to finish, and do not spawn new ones.

If you dispatched the developer team in this wave, drain it per `./developer-wave.md` `<lifecycle>` before returning. Do not modify gates in `CARD.meta.json`. Return control to the caller.

</instructions>
