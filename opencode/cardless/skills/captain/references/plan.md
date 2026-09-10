<placeholder-variables>
[PLAN_FILE] — Absolute path of the current numbered plan under `TASK_STATE/plans/`, recorded in `session.md`.
</placeholder-variables>

<instructions>

## 1. Assess Starting State

Read `TASK_STATE/TASK.md`, session state, progress and relevant notes. An evaluated current plan with no new evidence routes to Step 4. Otherwise read existing plans and compare them with current requirements and source commits.

- Prior plans implemented and new work requested: create a follow-on plan; treat completed plans and implementation as established context.
- Current plan and no new information: proceed to Step 2.
- New information invalidates a plan: revise it, preserving prior revisions and the evidence that changed the approach, then proceed to Step 2.
- No plan: create one through Step 1.1.

### 1.1 Create Plan

#### Commander's Intent

Distill from the task what the situation looks like when the work is done and which constraints must hold regardless of approach. Lead with the done state, not the problem.

#### Research

Review relevant files, web sources and tools. Identify every consumer of each symbol, field and boundary the plan touches. A component discovered during implementation that belongs in the plan is a research failure. Fork subagents for independent consumer sweeps, external-system source reads or fixture capture. When the plan writes to or depends on another system's files or protocol, read that system's source at the deployed version: check for a native mechanism first and record its invariants.

When correctness depends on real payloads, injected values or file formats, capture a real sample now under `TASK_STATE/notes/`. Save a note for each architectural discovery: finding, source/evidence, consequence for the plan, and unresolved questions. Keep sensitive values out of retained fixtures.

#### Apply Markdown Guidelines

Write the plan per `<markdown-guidelines>` in `session.md`: verify file, symbol, line and behavior claims against current source. Use diagrams for relationships that need them and fenced code for configuration examples.

#### Consider Bootstrap Sequencing

For new behavior whose contract is worth validating ahead of implementation, consult `$tdd-bootstrap` and structure implementation along its three phases. Skip bootstrap for refactors, spikes, visual work, glue code, one-shot scripts, framework-determined shapes and small in-place edits.

#### Write and Store Plan

Save `[PLAN_FILE]` with intent, acceptance criteria, scope, investigated approach, ordered independently gateable tasks, contracts/dependencies and validation commands. Record its path as the current plan in `session.md`. Save revisions and their rationale in task state; no source commit is needed for a plan-only revision.

## 2. Investigate Testable Uncertainties

Scan for explicit and implicit assumptions, including task-brief claims about third-party behavior. Any assumption affecting implementation warrants investigation. Load-bearing assumptions are work items, not choices to send back to the user.

For each testable uncertainty load `$spike`. Independent spikes can run concurrently in separate directories. Revise the plan using the results. A disproven load-bearing assumption invalidates the plan from intent through approach: rewrite it rather than patching around the false premise.

## 3. Evaluate the Plan

Build failure-mode questions from the task, plan, notes and similar workspace code: what must hold at runtime for the plan to work? Verify answers against source, not the plan's assertions. If you have lost distance from the plan, dispatch a fresh-eyes subagent per angle.

- **Failure modes:** trace consumers, data flow and error paths. Look for runtime failures beyond the validation suite: new boundaries, async logic, shared state and silently drifting contracts.
- **Delivered experience:** compare the intended outcome with the acceptance criteria. Does the plan deliver the actual request?
- **Surviving assumptions:** verify each load-bearing claim that survived Step 2 against source or revise the plan.

List every finding; revise and re-evaluate the full question set until all questions are answered. Record the questions and resolutions in task state. Missing technical facts require research. Only a material missing user requirement that cannot be inferred from the brief and repository routes to `./blocked.md`.

## 4. Route to Implementation

Record the evaluated current plan and phase in `session.md`, then read `./implementation.md`. Continue within the delivery scope established at startup. Do not add a plan-approval gate unless the user or host requires one; publication still needs the authorization recorded in `session.md`.

</instructions>
