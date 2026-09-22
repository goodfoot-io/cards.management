<instructions>

Load `$runtime:blocker-contract`. The tag requests reconciliation; it does not prove a live blocker.

1. Find the comment that caused the tag and state its concrete predicate. Read all later user-authored comments plus current source, metadata, dependencies, and relevant external state.
2. Re-run safe diagnostics. Repair, isolate, re-plan, delegate, or route work to its owner where that can advance the card.
3. Treat a relation as a blocker only when this card consumes a named unfinished deliverable. A related card becoming done can clear that predicate; it is not the only unblock shape.
4. If the predicate is false, superseded, independently repairable, or never met `<blocker-contract>`, remove `blocked`, commit the reconciliation in the card repository, and re-run routing in this execution.
5. Retain the tag only when every contract criterion is proven. If evidence or the unblock action changed, commit an updated comment naming the predicate, evidence, attempts, unblock owner, and exact resumption condition.
6. Before stopping on a retained blocker, collect the paths or IDs of every unanswered later user question and pass that exact set to `./question-response.md`, then re-route. Otherwise add no repeated status comment and stop.

</instructions>
