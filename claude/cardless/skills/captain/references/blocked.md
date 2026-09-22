# Reconcile Blocked Work

Load `cardless:blocker-contract`. For `phase: blocked`, read the saved report; otherwise read the triggering evidence and current phase. Identify the concrete predicate, then read the brief, progress, source, external state, and every later user instruction.

Re-run safe diagnostics. Repair, isolate, retry with new evidence, re-plan, or delegate when any can advance the outcome. A relation, dirty checkout, failed approach, exhausted retry count, or unfamiliar failure does not establish a blocker.

When the predicate is false, superseded, independently repairable, or never met the contract, re-route in this execution. For existing blocked state, mark the report resolved and restore its saved prior phase. For a first-time candidate, retain the current phase and record the recovery evidence without creating a blocker. Historical evidence is not an active routing signal.

When every criterion holds, write or update `TASK_STATE/reports/blocked.md` with current evidence, attempts, preserved branch and commit, unblock owner, and exact resumption condition. Save the current phase as `prior phase` before setting `phase: blocked`; retain both fields on later checks. Drain live workers before stopping. Do not repeat an unchanged blocker report.
