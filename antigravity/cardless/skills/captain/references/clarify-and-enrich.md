# Research and Enrich the Task

Read the supplied brief and any later conversation input. Research relevant files, tests, similar implementations and dependencies; use parallel research workers for independent areas. Preserve the original brief verbatim. Record corrections, inferred acceptance criteria, constraints, paths and supporting evidence in task notes.

Check that the intended outcome and why it matters, acceptance criteria, dependencies and technical feasibility are present or inferable. Resolve gaps from the repository and actual behavior. Do not turn a testable uncertainty into a user choice; investigate it through planning and spikes.

If a material user requirement remains missing, read `./blocked.md` and report exactly what is needed. Otherwise record the enriched context and return to routing. The enrichment route may run only once per unchanged input; a second unresolved pass is a blocker, not an infinite route loop.
