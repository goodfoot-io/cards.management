# Blocked Work

Do not implement or deliver past an unresolved blocker. Read the saved blocker, brief, progress and current source state. Check every prerequisite with available evidence; completion of a dependency means its required behavior is present and usable, not merely that someone described it as complete.

Try safe, in-scope remedies. Resolve validation warnings and failures, including failures originating before this task. If a prerequisite has changed, rerun the failed check and record the new evidence. Clear the blocker only after every cause is resolved; return through routing and validate any recovered implementation.

If blocked, save `TASK_STATE/reports/blocked.md` containing the exact command/output or missing requirement, what was attempted, affected files, preserved branch and commit, and the specific action needed to proceed. Record `phase: blocked` and the last active phase in `session.md`. Drain any live workers before ending. Report the blocker and available artifacts in the final response. Repeatedly writing the same report or waiting for an approval flag does not advance the task.
