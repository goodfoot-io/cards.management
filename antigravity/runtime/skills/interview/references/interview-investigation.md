<first-principles>
1. An investigation exists to unblock a decision. Without a decision, it is research, not investigation.
2. Questions must be falsifiable — if no evidence could change the answer, the question is wrong.
3. The null result is a valid outcome: "We cannot tell from available evidence" must be acceptable.
4. Evidence has provenance — source, freshness, and trust level affect the conclusion.
5. Investigation perturbs its subject. Probing production changes the system being studied.
6. Confidence threshold is set before gathering evidence, not after.
7. Prior art constrains scope — what has already been investigated bounds this work.
</first-principles>

<critical-constraints>

- No investigation execution. No diagnostic scripts, no production probes, no prototype work.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds in the card; do not remediate.

</critical-constraints>

<instructions>

## 1. Dispatch Research Immediately

Spawn `Explore` subagents in parallel with `run_in_background: true` before engaging the user. Research targets:
- Current observability on the subject (logs, metrics, traces, events)
- System boundaries — what is white-box vs. black-box
- Existing diagnostic tooling (scripts, dashboards, profilers) — note but do not execute
- Prior investigations or decision logs that touch the same question
- Data sources that could supply evidence and their known trust level

Do not block on research. Proceed to Section 2 while subagents run.

## 2. Load Card Skills

Load `notes`.

## 3. Interview and Shape the Card

The card already exists. Read `CARD.md` and use the conversation to close gaps, sharpen ambiguities, and surface assumptions the author left implicit — refining the commander's intent where the interview reveals it needs refining, rather than rebuilding it from scratch.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the request. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete parameters the user is best placed to set:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach several short "good" and "bad" scenarios to each option — concrete, one-line each — when picking exposes non-obvious downstream consequences (e.g., a confidence threshold of "80% vs. 95%" changes which evidence sources become load-bearing and how long the investigation runs). Skip scenarios when the trade-off is implicit in the question itself (e.g., deliverable format, where the cost is obvious from the format itself).
  - Topic axes: confidence threshold, deliverable shape, what the outcome unblocks, evidence-staleness tolerance, subject boundary.
  - Stay in chat for the decision being unblocked, hypothesis generation, and falsifiability checks.
- Target the decision to unblock, hypotheses to test, confidence threshold, and acceptable deliverable — never facts recoverable by research.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see. Vocabulary from the writing guides does not belong in exchanges with the user.
- Force falsifiability: reject questions with no possible answer that would change behavior.

As research subagents return and as the conversation settles pieces of the destination, fold them into the card in place — do not batch to the end:

- `CARD.meta.json` — title and metadata
- `CARD.md` — revise the commander's intent as the conversation sharpens it, then the section structure in `./investigation.md`
- `notes/` — research findings, evidence-source inventory, rejected framings
- `plans/` — decision logs and load-bearing assumptions only; do **not** write an investigation plan

Commit frequently so the card improves monotonically. The null result is an acceptable form of arrival.

## 4. Finalize

When the user confirms the card is complete, reconcile notes into `CARD.md`, ensure every load-bearing assumption is recorded, then:

```bash
cd $CARD_REPO_PATH
git add -- CARD.md CARD.meta.json notes plans
git commit -m "[single sentence summarizing the investigation's focus and key decisions from the interview]"  # <card-repo-commit-style>
```

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>
