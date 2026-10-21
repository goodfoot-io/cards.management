
<placeholder-variables>
[PLAN_FILE] — The plan file path relative to the card repository root (e.g., `plans/initial.md`, or `plans/phase-N.md` for follow-on work)
</placeholder-variables>

<instructions>

## 1. Assess Starting State

If `gates.planApproved` is true, skip to Step 5: Route to Implementation — the plan is already approved.

Read `CARD.md` for goals and constraints. Read `CARD.meta.json` for current `title`, `gates`, and `tags`. Read the contents of the 5 most recent `comments/*.md` files for context.

Check whether any plan files exist in `plans/` in the card repository:

- **`plans/` contains at least one `.md` file**: Go to Step 1.1.
- **No plan files exist**: Go to Step 2.

### 1.1 Evaluate Existing Plans

Read all plan files from the `plans/` directory. Compare the plans against the current card state — comments added after a plan was last modified may contain new requirements, feedback, or context.

Determine whether prior plans have been implemented by checking for workspace commits on the current branch that correspond to plan tasks.

- **Prior plan(s) implemented and new work requested** (follow-on): Go to Step 2 to plan the new work. Treat prior plans and their implementation as established context — do not revise completed plans.
- **Plan is current and no new information**: Proceed to Step 3.
- **New information requires plan revision**: Incorporate changes into `[PLAN_FILE]`, commit, then go to Step 3.

## 2. Choose Planning Weight

Weight tracks **unknowns, not work volume**. Count genuine architectural forks — mechanisms with real trade-offs; variations of one mechanism are one approach. A large mechanical change with one obvious mechanism is a solo plan even if it touches many files; a small change with several plausible mechanisms, contested trade-offs, or ambiguous acceptance criteria warrants a contest even if it touches one file. Unverified domain knowledge — unfamiliar libraries, concurrency primitives, external APIs, legacy subsystems — raises the unknowns count.

- **Solo (default)** — one approach dominates, or the forks resolve by reading source. Continue to Step 2.1.
- **Contest** — two or more approaches with real trade-offs, or unknowns deep enough that diverse exploration pays for itself. Read `./contest.md`, choosing `[N_PLANNERS]` (2–4) by the size of the solution space and `[PLANNER_EFFORT]` per slot. Un-approved plan files already in `plans/` favor a contest with incumbent seeding — the prior work gets graded rather than re-derived. On return:
  - **`APPROVED`**: Skip to Step 5: Route to Implementation.
  - **`REPLAN`**: Use the contest evidence for focused research or a revised solo plan.
  - **`BLOCKED`**: Stop only because the contest already applied and recorded `<blocker-contract>`.

### 2.1 Create Plan (Solo)

#### Commander's Intent

Distill from the card what the situation looks like when the work is done and what constraints must hold regardless of approach. Lead with the done state, not the problem.

#### Research

Review all relevant resources: files, web searches, tools. Identify every consumer of each symbol, field, and boundary the plan will touch. A component discovered during implementation that belongs in the plan is a research failure. If the research spans several independent threads — consumer sweeps, external-system source reads, fixture capture — consider forking a subagent per thread. When the plan writes to or depends on another system's files or protocol, read that system's source at the deployed version: check for a native mechanism first; record the invariants it enforces.

When correctness depends on the shape of real-world data the plan will process (live payloads, environment-injected values, file formats), capture a real sample **now** and commit it as a fixture in the card repo's `notes/`.

Follow the `<take-notes>` instructions from `@notes` skill — write a note to the card repository for each architectural discovery made during research.

#### Apply Markdown Guidelines

When writing the plan file, fragment-link every named file, function, and type per `<markdown-guidelines>`. Use mermaid diagrams for multi-component interactions, state transitions, and data flows. Use fenced code blocks with language tags for configuration and code examples.

The plan file is stored in the card repository (`$CARD_REPO_PATH`), but the card's workspace may be at a different path (`$WORKSPACE_PATH`). Fragment links must be relative to `$WORKSPACE_PATH` — use `./packages/foo/bar.ts`, not a filesystem path from the card repository or your working directory to the workspace.

#### Consider Bootstrap Sequencing

When the card introduces new behavior whose contract is worth validating ahead of implementation — a new public function, API, data type, schema, or algorithm — **you must consult the `<tdd-bootstrap>` instructions** from the `@tdd-bootstrap` skill and structure the plan's implementation steps along the three phases. Skip the bootstrap for refactors, spikes, UI or visual work, glue code, one-shot scripts, framework-determined shapes, and small in-place edits.

#### Write and Store Plan

Write the plan to `[PLAN_FILE]` in the card repository. Before committing, re-verify every file, line, symbol, and behavior claim the plan makes against current source — read or grep each one.

Create a sidecar at `[PLAN_FILE].meta.json` with a `title` prefixed with `"Plan: "` followed by a description of at most ten words (e.g., `"title": "Plan: Three-phase migration starting with schema"`). Commit to the card repository:

```bash
cd $CARD_REPO_PATH
git add plans/
git commit -m "[single sentence summarizing the approach and key decisions]"
```

## 3. Investigate Testable Uncertainties

Scan the plan for assumptions — both explicit and implicit (statements presented as facts not read from source — including CARD.md claims about third-party behavior). Any assumption that affects a planned implementation step warrants investigation; spike it per the procedure below. Load-bearing assumptions are work items for this step, not questions to surface to the user as a choice — converting a spike into an (a)/(b) prompt is a protocol violation. Skip only when no load-bearing assumptions exist.

For each testable uncertainty, load the `@spike` skill and follow its instructions. With several independent uncertainties, they can run as concurrent subagents rather than in sequence.

After spikes return, revise `[PLAN_FILE]` to incorporate their results — a spike that disproves a load-bearing assumption invalidates the plan from intent through approach, so rewrite rather than patch.

## 4. Evaluate the Plan

Build the failure-mode question set for the card — from `CARD.md`, the plan, your notes, adjacent cards, and similar workspace code: what must hold at runtime for the plan to work? Verify each answer against workspace source, not the plan's own assertions; a question the plan cannot answer is a finding.

If the plan is large enough that you have lost distance from it, a fresh-eyes subagent per angle is worth the handoff. For the failure-mode angle on a high-stakes solo plan, `spawn_agent` a `$card-plan-failure-mode` child (`task_name: plan_failure_mode`) with a `message` stating: the card repository and workspace paths; "Solo review — there are no planners. Review `[PLAN_FILE]` as `[PLANNER]` = me, the orchestrator, round-1. Draft your questions note, then report `FINDING:` and the single `VERDICT:` to me; skip `SELECT_WINNER`/`WINNER:` and end your turn after the verdict." Revise per its findings yourself; re-engage it (`send_message` if live, `resume_agent` if completed) with a `PLAN: READY round-K+1` message for re-review.

Evaluate from the angles below and list every finding — do not stop at the first one:

**Failure modes.** Perform a failure mode and effects analysis on the plan. Trace consumers, data flow, and error paths for each planned change. Where could this break at runtime that the validation suite wouldn't catch — new API boundaries, async/error-path logic, shared state, silently drifting contracts?

**Delivered experience.** Read the card's acceptance criteria against the plan's outcome. Does it deliver what the card asked, not just a technically sound approach?

**Surviving assumptions.** A load-bearing assumption that outlived Step 3's spikes is an unanswered question — verify it against source or revise the plan; never surface it as a user question.

Revise `[PLAN_FILE]` per finding, commit, and re-evaluate against the full question set — a fix can raise a new question. Stop only when every question is answered. Findings are plan-revision work; re-prompting the user to resolve them is a protocol violation.

## 5. Route to Implementation

Do not re-prompt the user for confirmation — `gates.planApproved` and `gates.planRequired` are the authorization. Asking "shall I proceed?" or offering (a)/(b) options is a protocol violation.

- **`gates.planRequired` is true**: **STOP** — plan submitted for approval. Do not modify gates in `CARD.meta.json`.
- **`gates.planRequired` is false**: Read `./implementation.md`.

</instructions>
