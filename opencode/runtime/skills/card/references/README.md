# Card References

Per-condition reference files for the `@card` skill. The router in `../SKILL.md` evaluates card state, selects one condition, and reads the matched file.

## Consumer

**`$card` skill** — loads exactly one of these references per session, per Step 3 of `../SKILL.md`. The skill is self-contained: it shares no reference files with `$captain`. Protocol references spawn the plugin's shared `$card-*` agent skills, which are plugin assets, not card-skill dependencies.

## Routing Map

The condition → reference table lives in `../SKILL.md` Step 2 — the router is the single source of truth. Each routed condition maps to `[condition-reference].md` in this directory.

## Shared Procedures

- `implementation.md` — implementation entry point for both plan-driven and direct work, loaded by `plan.md` and `implementation-feedback.md`.
- `implementation-evaluation.md` — post-implementation review, loaded by `implementation.md` when evaluation is needed.
- `bug-dirty-tree.md` — dirty-worktree triage, loaded by `bug.md` Step 1.1.

## Escalation Protocols (Loaded by Judgment)

Loaded only when the orchestrator chooses the heavy end of a step's weight spectrum:

- `contest.md` — parallel planner contest, loaded by `plan.md` Step 2.
- `developer-wave.md` — persistent developer-team delegation, loaded by `implementation.md`, `implementation-evaluation.md`, and `evaluation-wave.md`.
- `evaluation-wave.md` — background evaluator protocol, loaded by `implementation-evaluation.md` Step 3 and `validate.md` Step 4.

`contest.md` and `evaluation-wave.md` run as ephemeral spawn trees under the orchestrator; `developer-wave.md`'s workers are spawned once and kept live across a wave. No protocol gives children a direct channel to each other — `send_message` and `resume_agent` are the only coordination primitives, and every relay between children passes through the orchestrator.

## Not Router-Reachable

- `shutdown.md` — shutdown runbook. Loaded by the idle-nudge hooks via a hard-coded path when `EXIT_WHEN_DONE=true`; also referenced by the terminal-state protocol. Never loaded by the router.
