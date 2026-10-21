<interview-before-creating-an-enhancement-card>

Reach the signal required to write a well-formed enhancement request before the card is created. The companion `./enhancement.md` defines the target CARD.md structure; this guide defines how to get there.

<first-principles>
1. A feature is defined by its contract (inputs, outputs, invariants, error behavior), not its code.
2. Empty, partial, and broken states are part of the feature.
3. Behavior at boundaries (limits, concurrency, permissions, failures) defines the feature more than behavior at the center.
</first-principles>

<instructions>

## 1. Dispatch Research Immediately

Spawn `explorer` sub-agents in parallel (`spawn_agent` with `agent_type: explorer`) before engaging the user. Research targets:
- Data flow, schemas, and API contracts adjacent to the request
- Why existing code is shaped this way (git log/blame on the affected surface)
- Existing extension points, feature flags, and compatibility surfaces
- Current observability coverage of the affected paths
- Tests that protect current behavior (or their absence)

Do not block on research. Proceed to Step 2: Interview and Accumulate Findings while subagents run.

## 2. Interview and Accumulate Findings

Interview the user conversationally. The commander's intent is built through the conversation, not drafted and approved as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete forks the user is best placed to pick:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach short one-line "good"/"bad" scenarios to each option when the pick has non-obvious downstream consequences (e.g., "replace vs. add alongside" forces migration work across callers that aren't visible from the question). Skip them when the trade-off is implicit in the question itself (e.g., naming a new flag or setting).
  - Topic axes: owning package, replace vs. add alongside, default/empty state, edge-case behavior, telemetry shape.
  - Stay in chat for intent recovery, priority weighting, and branching follow-ups.
- Target intent, priorities, trade-offs, and load-bearing assumptions — never facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see.
- Surface failure modes, edge cases, and invariants they may not have considered. Choices here are cheaper than choices made in planning.

As research subagents return and as the conversation settles pieces of the destination, hold findings, user answers, rejected alternatives, and open questions in conversation state, shaped against the section structure in `./enhancement.md`. If the user's first description named a mechanism, climb to the underlying job before the destination is articulated.

## 3. Create the Card

When the destination is clear, write the opening paragraph as a summary of what the conversation has settled and check it with the user inline. Then create the card via the `cards create` flow in the parent `@cards` skill. Compose CARD.md against `./enhancement.md`. Include research excerpts, rejected alternatives, and any approach that emerged from research in `notes/` in the initial commit. Report the new card ID.

## 4. Constraints

- No implementation. No code, no scaffolding, no script execution.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds you encounter during research in the card; do not remediate.

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>

</interview-before-creating-an-enhancement-card>
