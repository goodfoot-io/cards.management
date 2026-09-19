# TDD bootstrap

Use for new pure functions, public APIs, data types with operations, algorithms with assertable properties, or schemas whose contract can be settled before implementation.

Skip for bugs, refactors, spikes, UI/visual work, glue, framework-determined shapes, one-shot scripts/migrations, configuration/docs/copy, localized edits, performance/observability work, or heavy-IO/non-deterministic work dominated by environment fixtures. [Reroute](./implementation.md).

## 1. Contract and stubs

Declare explicit inputs, outputs, errors, signatures/types/schemas, and required derives or annotations. Export final-shaped stubs that signal not implemented rather than silently succeed. Pass lint and typecheck before proceeding.

## 2. Skipped checks

Write consumer-facing acceptance checks for expected behavior, errors, and edge cases. Temporarily skip them with the test framework's skip primitive. They must compile, pass lint/typecheck, and register as pending when run—not fail during discovery. Correct awkward contracts now. Commit this checkpoint if repository gates permit; never bypass them.

## 3. Implement and unskip

Unskip one concern, observe it fail against the stub, implement the minimum to pass, then run the file's enabled checks together. Repeat; refactor only when green. Follow repository validation conventions. New behavior discovered here starts its own unit and contract phase.

Finish with no skipped checks or stubs remaining and all required validation passing.
