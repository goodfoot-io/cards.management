<instructions>

Launch a batch of cards through their `launch` action, one at a time, in an order
that respects what loose dependencies exist between them. Never launch two cards
concurrently — agents on the same branch or on `main`'s ref lock will contend.

## 1. Inputs

- **[CARD_IDS]** — the card IDs to launch, already selected by the caller. This
  skill starts from that set; it does not select it.

## 2. Determine an Informal Order

There is no formal dependency graph between cards — build a single heuristic
ordering, not a DAG solve:

- Fetch each card's relations to find pairwise links: `cards <id> --jsonpath
  '$.relations'` and `cards <id> --jsonpath '$.incomingRelations'`. Cluster
  cards that reference each other so related work lands close together in time.
- **A card in the set is about the launch tooling itself** (e.g., a bug in
  `cards action launch`, the CLI, or the extension): order it first, so its
  breakage doesn't produce false failures in every launch after it.
- Where relations are absent, group remaining cards thematically by title/tags
  (e.g., all cards touching the same page or subsystem).
- State the resulting order and the reasoning before starting.

## 3. Launch Each Card and Wait for `needs_review`

By default, omit `--variable-group`; the launch then uses the normal variable-group
selection persisted in the webview. When the caller requests specific groups for a
dispatch, discover safe summaries and their IDs first:

```bash
cards variable-group list [--workspace-path <path>] [--jsonpath <expr>]
```

The summaries contain only `id`, `name`, optional `description`, `variableCount`,
and `secretCount`; variable values and secrets are never returned. Append one
`--variable-group <id>` per requested group, preserving the caller's order:

For each card ID in order:

```bash
cards <id> action launch --exit-when-done
cards <id> action launch --exit-when-done --variable-group <id-a> --variable-group <id-b>
```

Use the second form only when groups were explicitly selected for that card. It
attaches exactly those IDs to that dispatch and does not mutate the webview's
persisted toggles, so selections do not carry into later launches automatically.

- This call returns immediately with `{"success": true|false}` — it does **not**
  block until the launched work finishes, regardless of which flags are passed.
  Poll for completion separately:

```bash
prevst=""
while true; do
  st=$(cards <id> --jsonpath '$.status' 2>&1)   # never name this var `status` — zsh reserves it read-only
  [ "$st" != "$prevst" ] && { echo "<id> status: $st"; prevst=$st; }
  case "$st" in needs_review|done|archived) break ;; esac
  sleep 20
done
```

- **`cards action launch` can report a false timeout/error even though the
  action started successfully.** Do not treat a non-zero exit or `"success":
  false` as a real failure by itself — verify via `cards <id>
  --jsonpath '$.status'` reaching `active` (or beyond) before deciding the
  launch actually failed.
- **Never retry a launch call.** A duplicate dispatch spawns a second agent on
  the same card, and the two will fight over its worktree.
- Only start the next card's launch once the current one reaches `needs_review`
  (or `done`/`archived`) — that transition is set automatically when the
  action handler exits, and is the serialization point the whole loop depends on.
- `needs_review` **is** the review gate, not a stall. A card agent committing
  its work and moving to `needs_review` is the process working correctly —
  do not pause the queue or flag it as a concern.
- When the agent signals shutdown (`cards <id> shutdown --outcome ...`, per the
  runbook), the dispatcher logs the record/relay decision and the outcome is
  recorded on the action — but no agent-reachable command returns it this
  iteration, so keep polling `$.status` as documented: status still settles to
  `needs_review` either way, and the signal never gates that transition.

## 4. Track and Report

- Represent each card as one task (TaskCreate/TaskUpdate or equivalent):
  mark it in_progress immediately before its launch call, completed the
  moment its status reaches `needs_review`.
- When the batch finishes, report each card ID with its final status, the
  order used, and the reasoning behind that order.

</instructions>
