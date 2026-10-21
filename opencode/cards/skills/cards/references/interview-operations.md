<interview-before-creating-an-operations-card>

Reach the signal required to write a well-formed operations request before the card is created. The companion `./operations.md` defines the target CARD.md structure; this guide defines how to get there.

<first-principles>
1. Fail closed by default — when uncertain, the safer action preserves current state.
2. Verification precedes the declaration of success. Intent to change is not evidence of change.
3. Observability before action — if the signal that would detect failure doesn't exist, create it first.
4. Environment parity is a premise to verify, not assume.
</first-principles>

<instructions>

## 1. Dispatch Research Immediately

Spawn `explorer` sub-agents in parallel (`spawn_agent` with `agent_type: explorer`) before engaging the user. Research targets:
- Deploy, rollback, and safety scripts currently in the repo
- Configuration surface (env vars, feature flags, secrets) touching the subject
- Monitoring/alerting tied to the affected system
- Recent changes to the target system via git log (recent volatility)
- Existing runbooks or ops notes for adjacent procedures

Do not block on research. Proceed to Step 2: Interview and Accumulate Findings while subagents run.

## 2. Interview and Accumulate Findings

Interview the user conversationally. The commander's intent is built through the conversation, not drafted and approved as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete classifications the user is best placed to pick:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach short one-line "good"/"bad" scenarios to each option when the pick has non-obvious downstream consequences (e.g., new-step failure posture — "block vs. warn" can halt unrelated pipelines the user hasn't traced, or let real failures drift unnoticed). Skip them when the trade-off is implicit in the question itself (e.g., log-retention window).
  - Topic axes: target pipeline, trigger scope, new-step failure posture, secrets scope, caching impact.
  - Stay in chat for the reason the change is needed, verification steps, and rollback narrative.
- Target urgency, blast radius, reversibility, approvals, verification, and who must be informed — a change is a communication event, not only a technical one. Never ask for facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see.
- Force a rollback and verification plan — the rollback may be "escalate", but it must exist. An operation without both is not ready to plan.

As research subagents return and as the conversation settles pieces of the destination, hold findings, related incidents, and rejected approaches in conversation state, shaped against the section structure in `./operations.md`.

## 3. Create the Card

When the destination is clear, write the opening paragraph as a summary of what the conversation has settled and check it with the user inline. Then create the card via the `cards create` flow in the parent `@cards` skill. Compose CARD.md against `./operations.md`. Include related incidents, rejected approaches, and any approach that emerged from research in `notes/` in the initial commit. Report the new card ID.

## 4. Constraints

- No operational execution. No scripts, no infra changes, no configuration edits.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds you encounter during research in the card; do not remediate.

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>

</interview-before-creating-an-operations-card>
