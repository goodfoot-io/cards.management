---
name: spike
description: Resolve a technical uncertainty by running a small, throwaway investigation in the card repository and recording the result as a note.
---

<placeholder-variables>
[SPIKE_QUESTION] — The specific technical question the spike must answer (one sentence, yes/no or which-of-these)
[SPIKE_SLUG] — Kebab-case identifier for the spike directory (e.g., `redis-adapter`, `stream-backpressure`)
[SPIKE_PATH] — `[CARD_REPO_PATH]/spike/[SPIKE_SLUG]/` — throwaway workspace for artifacts
[CARD_REPO_PATH] — Absolute path to the card repository
</placeholder-variables>

<instructions>

## 1. Frame the Question

Write `[SPIKE_QUESTION]` as a concrete, verifiable question:

- **Yes/no**: "Does `@socket.io/redis-adapter@8.x` survive a Redis failover without dropping subscriptions?"
- **Which**: "Does `fetch` or `undici` surface a connection reset as a distinguishable error on Node 22?"

A spike that cannot be answered by running code belongs in plan research, not here. Stop and return to reading the workspace.

## 2. Set Up the Spike Directory

Choose `[SPIKE_SLUG]` and create the directory:

```bash
mkdir -p [SPIKE_PATH]
```

Everything the spike produces — scratch scripts, sample inputs, captured output — lives under `[SPIKE_PATH]`. Never write spike artifacts into the workspace codebase.

## 3. Run the Investigation

Write the smallest script or test that answers `[SPIKE_QUESTION]`. Run it. Capture the output.

- Prefer working code over documentation reading — a spike that does not execute anything is a research task, not a spike.
- Keep it narrow: one question per spike. A second question is a second spike.
- Iterate in place: if the first script doesn't answer the question, revise it. Spike code is throwaway; do not polish.

## 4. Record the Result as a Note

Load the `@notes` skill and follow its `<take-notes>` instructions to record the result. The note is the durable output — the spike directory is scratch.

The note should include:

- **Question**: `[SPIKE_QUESTION]`
- **Answer**: one line (yes/no, or the chosen option with why)
- **Evidence**: the specific observation that settled it — an error code, an API response, a benchmark number, a stack trace. Not "I tried it and it worked."
- **Artifacts**: reference `spike/[SPIKE_SLUG]/` so a future reader can re-run the investigation
- **Impact**: how this result changes the plan or implementation — which step it unblocks, which assumption it invalidates

## 5. Commit and Return

Commit the spike directory and the note to the card repository:

```bash
cd [CARD_REPO_PATH]
git add spike/[SPIKE_SLUG]/ notes/
git commit -m "[one sentence: the question and what settled it]"
```

Return to the caller (planner, developer, reviewer) with the one-line answer and the note path. The caller uses the result to revise its plan or implementation — do not revise on its behalf.

</instructions>
