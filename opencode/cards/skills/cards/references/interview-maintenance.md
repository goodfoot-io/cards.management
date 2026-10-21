<interview-before-creating-a-maintenance-card>

Reach the signal required to write a well-formed maintenance request before the card is created. The companion `./maintenance.md` defines the target CARD.md structure; this guide defines how to get there.

<first-principles>
1. Debt is only debt if it costs something observable — incidents, toil, risk, blocked work — not aesthetic.
2. A refactor without a safety net is a rewrite. Tests, observability, and rollback paths are preconditions.
3. Partial migrations are a steady state to be designed, not an accident to be avoided.
4. Removal is the completion criterion — debt is not retired until the old path is gone.
</first-principles>

<instructions>

## 1. Dispatch Research Immediately

Spawn `explorer` sub-agents in parallel (`spawn_agent` with `agent_type: explorer`) before engaging the user. Research targets:
- Complexity-vs.-churn hotspots on the subject (git log frequency + file size/complexity)
- Test coverage of the subject; flaky or missing cases
- Dependency freshness and deprecation signals from lockfiles
- Public surfaces and their consumers (imports, API callers, exported types)
- TODO/FIXME/`deprecated` markers in-scope

Do not block on research. Proceed to Step 2: Interview and Accumulate Findings while subagents run.

## 2. Interview and Accumulate Findings

Interview the user conversationally. The commander's intent is built through the conversation, not drafted and approved as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete parameters the user is best placed to set:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach short one-line "good"/"bad" scenarios to each option when the pick has non-obvious downstream consequences (e.g., scope — narrowing to one consumer leaves invariants unproven elsewhere, widening pulls in migrations the user didn't price in). Skip them when the trade-off is implicit in the question itself (e.g., renaming a helper).
  - Topic axes: scope, per-consumer disposition, completion criterion, invariant surface, whether test fixtures may change.
  - Stay in chat for motivation, invariant naming, and trade-off discussion.
- Target motivation, invariants, rollout strategy, and completion criteria — never facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see.
- Force the user to name what must *not* change; unstated invariants produce regressions.

As research subagents return and as the conversation settles pieces of the destination, hold findings, consumer inventory, and rejected approaches in conversation state, shaped against the section structure in `./maintenance.md`. The destination must be describable without reference to the current mechanism.

## 3. Create the Card

When the destination is clear, write the opening paragraph as a summary of what the conversation has settled and check it with the user inline. Then create the card via the `cards create` flow in the parent `@cards` skill. Compose CARD.md against `./maintenance.md`. Include consumer inventory, rejected approaches, and any approach that emerged from research in `notes/` in the initial commit. Report the new card ID.

## 4. Constraints

- No refactoring. No dependency upgrades. No code changes of any kind.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds you encounter during research in the card; do not remediate.

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>

</interview-before-creating-a-maintenance-card>
