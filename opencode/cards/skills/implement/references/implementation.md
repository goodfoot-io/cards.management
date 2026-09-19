# Implementation

Read the repository's AGENTS.md and the card's `CARD.md`, `CARD.meta.json`, and plans. Honor plan gates before editing and merge gates before merging; never change gates. Follow the card's goals, constraints, and approved plan. Keep changes within scope; record unrelated discoveries separately.

For each logical unit, select the first matching primary route:

| Condition | Route |
|---|---|
| Observed expected-versus-actual mismatch | [Bug](./bug.md) |
| Behavior-preserving structural change | [Refactoring](./refactoring.md) |
| New behavior with a meaningful up-front contract; meets the technique's applicability rules | [TDD bootstrap](./tdd-bootstrap.md) |
| Otherwise: UI, glue, framework-shaped code, configuration, or localized edits | **Direct**: implement with outcome-level checks |

Before or during any route, resolve a blocking fact that requires execution with a [spike](./spike.md), then reroute. For a failed assumption, design fork, or scope change, [reconsider the approach](./reconsider-approach.md).

Read the affected code and consumers, apply the route, then validate. Follow repository commands: start with focused checks, expand across affected dependency boundaries, and run required integration gates before completion. Use real implementations and observable outcomes rather than mocks of internals. Commit each validated unit.

Fix required-check warnings and failures. Diagnose ambiguous failures with [pre-existing validation](./pre-existing-validation.md); do not dismiss them. Never weaken assertions, disable checks, or bypass hooks. TDD's temporary skipped checks must all be enabled before completion.

After all units, inspect `git diff "$BASELINE"..HEAD` and any remaining edits against the card. Run all required completion checks. For behavioral or risk-bearing diffs—new logic/APIs, cross-file behavior, async/shared-state/error paths, or user-visible changes—run [quality review](./quality-review.md). A mechanical, behavior-neutral diff may skip review. Commit remaining validated artifacts before returning to the lifecycle.

On an unresolved blocker, commit the evidence and next step to a card comment, add `blocked` to its tags without changing gates, and stop. Do not merge or clean up unfinished work.
