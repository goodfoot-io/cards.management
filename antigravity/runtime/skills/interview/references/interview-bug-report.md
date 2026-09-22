<first-principles>
1. Reproducibility is the unit of truth — without it, everything else is speculation.
2. Observation and interpretation must be kept separate.
3. The environment is part of the bug: (code, state, inputs, environment) is the defect.
4. Severity tracks impact, not loudness. Silent data corruption outranks visible crashes.
5. Regression vs. latent defect changes the investigation entirely.
6. Missing observability is a defect of its own.
7. Workarounds are data — what makes the bug go away reveals its shape.
</first-principles>

<critical-constraints>

- No fixes. No code, no remediation, no test stubs.
- Never ask the user to look something up. If it is recoverable by Glob/Grep/Read/git, find it yourself.
- Report failing tests or broken builds in the card; do not remediate.

</critical-constraints>

<instructions>

## 1. Dispatch Research Immediately

Spawn `Explore` subagents in parallel with `run_in_background: true` before engaging the user. Research targets:
- The code path implicated by the error (symbol, file, caller/callee chain)
- Recent changes to that path via git log/blame (regression candidates)
- Test coverage of the path and known flaky history
- Error/log instrumentation already in place
- Adjacent failure modes the same code could exhibit

Do not block on research. Proceed to Section 2 while subagents run.

## 2. Load Card Skills

Load `notes`.

## 3. Interview and Shape the Card

The card already exists. Read `CARD.md` and use the conversation to close gaps, sharpen ambiguities, and surface assumptions the author left implicit — refining the commander's intent where the interview reveals it needs refining, rather than rebuilding it from scratch.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the report. Match the user's register — their vocabulary, level of formality, and concreteness.
- Use the `AskUserQuestion` tool for discrete classifications the user is best placed to pick:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach several short "good" and "bad" scenarios to each option — concrete, one-line each — when picking exposes non-obvious downstream consequences (e.g., "intermittent vs. deterministic" reproducibility routes the fix toward timing or ordering work the reporter may not have anticipated). Skip scenarios when the trade-off is implicit in the question itself (e.g., repro-data shape, where the fidelity-vs.-sensitivity trade is self-evident from the data involved).
  - Topic axes: regression vs. latent, reproducibility class, repro surface, source of expected behavior, repro-data shape.
  - Stay in chat for the reproduction narrative, observed-vs.-expected framing, and anything that risks freezing the user's hypothesis.
- Target what only the user can supply: reproduction specifics, environment, workarounds, observed vs. expected, sensitivity of repro data.
- Pin down what "done" looks like as a concrete oracle, not a sentiment. Drive the expected-behavior question until the answer is specific enough to become a reproduction-test assertion — "calling X with Y returns Z", "the copied file stays group-readable", "no `EACCES` is raised" — since that assertion is exactly what the fix flow's reproduction test will check. "Done" is the observable behavior the user expects, never the resolution: do not ask where the fix should live, which component to change, or which mechanism resolves the defect (e.g. "should stream liveness be derived at the store, by extending the Router overlay, or on the list route only?") — the reporter supplies the symptom, and choosing the fix is the fix flow's job, not theirs. If the user cannot name a correct behavior the current one diverges from, surface it: with no "[Expected] but [Actual]" to assert against, the fix flow treats the card as a feature request, not a bug.
- Do not ask the user how the bug currently affects them or to rate its severity — current-impact questions yield answers that are neither actionable nor relevant to the resolution. Characterize impact and blast radius yourself from the reproduction, the affected code path, and which surfaces it touches (e.g. a defect that hits the Codex CLI branch but not the Claude one, or silent corruption whose loudness understates its reach). Severity feeds card triage and the failure-mode review's severity axis, but derive it from observable evidence and record it — never solicit it from the user.
- Anchor in the user's frame: name the artefact, command, or moment they will actually see. Vocabulary from the writing guides does not belong in exchanges with the user.
- Separate observation from interpretation; do not let the user's hypothesis narrow the investigation prematurely.

As research subagents return and as the conversation settles pieces of the destination, fold them into the card in place — do not batch to the end:

- `CARD.meta.json` — title and metadata
- `CARD.md` — revise the commander's intent as the conversation sharpens it, then the section structure in `./bug-report.md`
- `notes/` — research findings, log excerpts, rejected hypotheses
- `plans/` — decision logs and load-bearing assumptions only; do **not** write a fix plan

Commit frequently so the card improves monotonically.

## 4. Finalize

When the user confirms the card is complete, reconcile notes into `CARD.md`, ensure every load-bearing assumption is recorded, then:

```bash
cd $CARD_REPO_PATH
git add -- CARD.md CARD.meta.json notes plans
git commit -m "[single sentence summarizing how the bug was characterized and key decisions from the interview]"  # <card-repo-commit-style>
```

**STOP** — Interview complete. Do not proceed to implementation.

</instructions>
