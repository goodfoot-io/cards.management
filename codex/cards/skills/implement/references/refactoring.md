# Refactoring

Treat existing behavior and checks as the contract. Add characterization checks where behavior is unprotected; make small structural changes and validate after each. If intentional new behavior appears, [reroute](./implementation.md).

Reduce accidental complexity, not required domain behavior. Prefer a simpler implementation that satisfies the same requirements; remove unused configurability or speculative abstractions only after verifying their consumers.

Consolidate duplication only when copies encode the same knowledge, must change together, have a clear abstraction, and would not couple unrelated concepts. Keep similarity when purposes differ, copies may diverge, or abstraction obscures tests. Undo abstractions accumulating case-specific switches.

Test observable outcomes with real dependencies, not private state, internal call sequences, or a second implementation of the algorithm. Retain distinct requirements and edge cases; consolidate only genuinely redundant checks. Update callers and tests after structural changes.

Before removing unclear code, inspect requirements, decision records, git history, tests, downstream consumers, and error/edge paths. Remove only when its purpose is understood and no required behavior or dependency is lost. Otherwise preserve it and flag the uncertainty.
