<instructions>

At any natural terminal state — after a merge, after recording a blocker, or after all tasks are complete — check whether `EXIT_WHEN_DONE` is `true` in your environment context. If it is not set, stop here and continue normally.

If `EXIT_WHEN_DONE=true`:

1. Finish or roll back the current card-owned step; confirm no card-owned change is pending and the recorded off-card snapshot is preserved. Do not signal while a commit, tool call, subagent, or background process is still active.
2. Tell Cards you are done, choosing the honest outcome:

```bash
cards "$CARD_ID" shutdown --outcome success
# or
cards "$CARD_ID" shutdown --outcome blocked --message "[committed blocker predicate and resumption condition]"
# or
cards "$CARD_ID" shutdown --outcome error --message "what failed"
```

Use `success` for completion and normal review or approval boundaries. Use `blocked` only after loading `$blocker-contract` and committing a compliant blocker record. Use `error` when execution must end without a valid success or blocker record. `--outcome` defaults to `success`; exit 0 confirms request acceptance, not cleanup.

3. End the session cleanly. The action handler terminates this session gracefully in response to the signal — no kill commands are needed.

</instructions>
