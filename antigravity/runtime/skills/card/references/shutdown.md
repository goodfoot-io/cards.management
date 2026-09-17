<instructions>

At any natural terminal state — after a merge, after recording a blocker, or after all tasks are complete — check whether `EXIT_WHEN_DONE` is `true` in your environment context. If it is not set, stop here and continue normally.

If `EXIT_WHEN_DONE=true`:

1. If you are running inside a teammate team, send both messages below regardless of whether `team-lead` resolves. If a call errors with no such recipient, you are the team lead — don't retry or search for one.

```xml
<invoke name="SendMessage">
  <parameter name="to">team-lead</parameter>
  <parameter name="summary">Shutdown request</parameter>
  <parameter name="message">{"type": "shutdown_request", "reason": "Shutdown requested"}</parameter>
</invoke>
```

```xml
<invoke name="SendMessage">
  <parameter name="to">team-lead</parameter>
  <parameter name="summary">Approve shutdown</parameter>
  <parameter name="message">{"type": "shutdown_response", "request_id": [REQUEST ID FROM shutdown_request], "approve": true}</parameter>
</invoke>
```

2. Finish or roll back every mutation, check, and commit; confirm both the workspace and card repository are clean; and wait until every subagent and background process has finished.
3. In your final assistant turn, make the shutdown command the sole tool call, choosing the honest outcome:

```bash
cards "$CARD_ID" shutdown --outcome success
# or
cards "$CARD_ID" shutdown --outcome blocked --message "waiting on review"
# or
cards "$CARD_ID" shutdown --outcome error --message "what failed"
```

`--outcome` defaults to `success`; `--message` is optional free text. Exit 0 confirms durable request acceptance, not that cleanup has completed.

Do not make any later tool call after the shutdown command. Delivery is not completion: the runtime records one terminal decision, and the execution wrapper reports containment and output finalization after stopping its owned processes.

4. End the session cleanly. The execution wrapper owns termination in response to the accepted decision — no separate kill commands are needed.

</instructions>
