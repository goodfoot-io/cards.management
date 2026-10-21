<interview-before-creating-an-investigation-card>

Reach the signal required to write a well-formed investigation request before the card is created. The companion `./investigation.md` defines the target CARD.md structure; this guide defines how to get there.

<first-principles>
1. An investigation exists to unblock a decision. Without a decision, it is research, not investigation.
2. Evidence has provenance — source, freshness, and trust level affect the conclusion.
3. Investigation perturbs its subject. Probing production changes the system being studied.
4. Confidence threshold is set before gathering evidence, not after.
</first-principles>

<instructions>

## 1. Dispatch Research Immediately

Spawn `explorer` sub-agents in parallel (`spawn_agent` with `agent_type: explorer`) before engaging the user. Research targets:
- Current observability on the subject (logs, metrics, traces, events)
- System boundaries — what is white-box vs. black-box
- Existing diagnostic tooling (scripts, dashboards, profilers) — note but do not execute
- Prior investigations or decision logs that touch the same question
- Data sources that could supply evidence and their known trust level

Do not block on research. Proceed to Step 2: Interview and Accumulate Findings while subagents run.

## 2. Interview and Accumulate Findings

Interview the user conversationally. The commander's intent is built through the conversation, not drafted and approved as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete parameters the user is best placed to set:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach short one-line "good"/"bad" scenarios to each option when the pick has non-obvious downstream consequences (e.g., a confidence threshold of "80% vs. 95%" changes which evidence sources become load-bearing and how long the investigation runs). Skip them when the trade-off is implicit in the question itself (e.g., deliverable format).
  - Topic axes: confidence threshold, deliverable shape, what the outcome unblocks, evidence-staleness tolerance, subject boundary.
  - Stay in chat for the decision being unblocked, hypothesis generation, and falsifiability checks.
- Target the decision to unblock, hypotheses to test, confidence threshold, and acceptable deliverable — never facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see.
- Force falsifiability: reject questions with no possible answer that would change behavior.

As research subagents return and as the conversation settles pieces of the destination, hold findings, the evidence-source inventory, and rejected framings in conversation state, shaped against the section structure in `./investigation.md`. The null result is an acceptable form of arrival. Prior investigations constrain scope — do not re-ask what they already answered.

## 3. Create the Card

When the destination is clear, write the opening paragraph as a summary of what the conversation has settled and check it with the user inline. Then create the card via the `cards create` flow in the parent `@cards` skill. Compose CARD.md against `./investigation.md`. Include evidence-source inventory, prior-art references, and any approach that emerged from research in `notes/` in the initial commit. Report the new card ID.

## 4. Constraints

- No investigation execution. No diagnostic scripts, no production probes, no prototype work.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds you encounter during research in the card; do not remediate.

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>

</interview-before-creating-an-investigation-card>
