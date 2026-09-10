---
name: spike
description: Resolve a technical uncertainty with a small, throwaway investigation and record its evidence in task state.
---

<placeholder-variables>
[SPIKE_QUESTION] — The specific technical question the spike must answer (one sentence, yes/no or which-of-these)
[SPIKE_SLUG] — Kebab-case identifier for the spike directory (for example, `redis-adapter`, `stream-backpressure`)
[TASK_STATE] — Captain-owned state directory for this task
[SPIKE_PATH] — `[TASK_STATE]/spike/[SPIKE_SLUG]/` — throwaway workspace for artifacts
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
- Iterate in place: if the first script does not answer the question, revise it. Spike code is throwaway; do not polish.

## 4. Record the Result

Write `[TASK_STATE]/notes/[SPIKE_SLUG].md`. The note is the durable output; the spike directory is scratch. Include:

- **Question**: `[SPIKE_QUESTION]`
- **Answer**: one line (yes/no, or the chosen option with why)
- **Evidence**: the specific observation that settled it — an error code, API response, benchmark number, or stack trace; not "I tried it and it worked"
- **Artifacts**: reference `spike/[SPIKE_SLUG]/` so a future session can re-run the investigation
- **Impact**: how this result changes the plan or implementation — which step it unblocks or which assumption it invalidates

## 5. Return

Do not create a separate artifact repository or commit scratch artifacts. Return to the caller with the one-line answer and note path. The caller uses the result to revise its plan or implementation — do not revise on its behalf.

</instructions>
