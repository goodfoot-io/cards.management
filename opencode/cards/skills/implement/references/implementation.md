# Implementation

Read the repository's AGENTS.md and the card's `CARD.md`, `CARD.meta.json`, and plans. Honor plan gates before editing and merge gates before merging; never change gates. Follow the card's goals, constraints, and approved plan. Keep changes within scope; card only unfixed discoveries.

For each logical unit, select the first matching primary route:

| Condition | Route |
|---|---|
| Observed expected-versus-actual mismatch | [Bug](./bug.md) |
| Behavior-preserving structural change | [Refactoring](./refactoring.md) |
| New behavior with a meaningful up-front contract; meets the technique's applicability rules | [TDD bootstrap](./tdd-bootstrap.md) |
| Otherwise: UI, glue, framework-shaped code, configuration, or localized edits | **Direct**: implement with outcome-level checks |

Before or during any route, resolve a blocking fact that requires execution with a [spike](./spike.md), then reroute. For a failed assumption, design fork, or scope change, [reconsider the approach](./reconsider-approach.md).

Before editing, classify tracked, staged, and untracked paths against the card; inspect untracked symlinks without following them and snapshot generated, provisioned, or unrelated paths. Preserve that set. Read affected code and consumers, apply the route, then validate. Stage only intentional card-owned paths, review the staged diff, and commit each validated unit. If off-card state could affect a check, validate an isolated candidate containing only the exact owned staged/working diff and created files; certify the final result at the exact committed card HEAD.

Fix required-check warnings and failures. Diagnose ambiguous failures with [pre-existing validation](./pre-existing-validation.md); do not dismiss them. Never weaken assertions, disable checks, or bypass hooks. TDD's temporary skipped checks must all be enabled before completion.

After all units, inspect `git diff "$BASELINE"..HEAD` and any remaining edits against the card. Run all required completion checks. For behavioral or risk-bearing diffs—new logic/APIs, cross-file behavior, async/shared-state/error paths, or user-visible changes—run [quality review](./quality-review.md). A mechanical, behavior-neutral diff may skip review. Commit remaining validated artifacts before returning to the lifecycle.

Before deferring work to a prerequisite card or recording blocked state, load `$blocker-contract`. Repair, isolate, re-plan, or delegate unless every criterion holds; only then commit the required record, add the tag without changing gates, and stop. Do not merge or clean up unfinished work.
