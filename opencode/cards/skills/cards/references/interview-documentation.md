<interview-before-creating-a-documentation-card>

Reach the signal required to write a well-formed documentation request before the card is created. The companion `./documentation.md` defines the target CARD.md structure; this guide defines how to get there.

<first-principles>
1. Audience and task define the document; format follows.
2. A doc without an owner will lie. Source of truth and maintainer must be named up front.
3. Discoverability is part of the doc — an unfindable doc does not exist.
4. Scope is bounded by what the reader needs, not by what the author knows.
</first-principles>

<instructions>

## 1. Dispatch Research Immediately

Spawn `explorer` sub-agents in parallel (`spawn_agent` with `agent_type: explorer`) before engaging the user. Research targets:
- Existing documentation culture (`docs/`, co-located `README.md`, wiki, website)
- The code/behavior the documentation must describe (to verify accuracy)
- Consumers of the subject (grep for import patterns, API callers) to infer audience
- Existing related docs that may overlap, conflict, or be replaced
- Freshness — git timestamps of candidate source-of-truth files

Do not block on research. Proceed to Step 2: Interview and Accumulate Findings while subagents run.

## 2. Interview and Accumulate Findings

Interview the user conversationally. The commander's intent is built through the conversation, not drafted and approved as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete classifications the user is best placed to pick:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach short one-line "good"/"bad" scenarios to each option when the pick has non-obvious downstream consequences (e.g., superseding an existing doc — redirects, broken bookmarks, and stale references in adjacent docs the user hasn't audited). Skip them when the trade-off is implicit in the question itself (e.g., heading capitalization or format preference).
  - Topic axes: home location, format, which existing doc is superseded, example source, freshness-linkage strategy.
  - Stay in chat for audience definition, task articulation, and intent recovery.
- Target intent, audience, ownership, and trade-offs — never facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see.
- Force clarity on audience and task; ambiguity here produces unusable docs.

As research subagents return and as the conversation settles pieces of the destination, hold findings, candidate sources, and rejected framings in conversation state, shaped against the section structure in `./documentation.md`.

## 3. Create the Card

When the destination is clear, write the opening paragraph as a summary of what the conversation has settled and check it with the user inline. Then create the card via the `cards create` flow in the parent `@cards` skill. Compose CARD.md against `./documentation.md`. Include candidate-source inventory, freshness findings, and any approach that emerged from research in `notes/` in the initial commit. Report the new card ID.

## 4. Constraints

- No documentation drafting. The card describes the need; writing happens in a later phase.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds you encounter during research in the card; do not remediate.

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>

</interview-before-creating-a-documentation-card>
