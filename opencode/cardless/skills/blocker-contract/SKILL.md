---
name: blocker-contract
description: Authoritative test for creating, retaining, or reporting blocked work.
---

<blocker-contract>

Treat work as blocked only when every condition holds:

- **Causal** — the condition prevents the current outcome, not one preferred approach.
- **Current** — current source, task state, comments, dependencies, and external state still prove it.
- **Non-overridable** — no later user instruction supplies authority or handling direction.
- **Independently irreparable** — safe repair, isolation, evidence-driven retry, re-planning, or delegation cannot advance the outcome.
- **Externally owned or separately scoped** — resumption needs a user decision, credential, permission, external state change, or a distinct prerequisite enhancement.
- **Actionable** — the record names evidence, attempts, the unblock owner, and the exact resumption condition.

If any condition is absent, do not block. Preserve unrelated state; repair tools, dependencies, derived artifacts, conflicts, and baseline failures; isolate ownership; or re-plan with the evidence. Retry only to test a new hypothesis.

Relations are not dependencies unless the work consumes a specific unfinished deliverable. A worker's `BLOCKED` report is scheduling input, not task-level proof. `STOP`, `needs_review`, questions, and approval waits are not blockers.

</blocker-contract>
