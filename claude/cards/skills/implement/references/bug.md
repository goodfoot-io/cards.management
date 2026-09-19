# Bug

State expected versus actual behavior. Trace plausible hypotheses through the affected code. If every hypothesis is missing behavior rather than broken behavior, record the reclassification and [reroute](./implementation.md).

Describe a minimal witness and require all three properties:

- **Discriminating:** fails because the defect exists, not because it restates the proposed edit.
- **Observable:** asserts the outcome, not an internal call or configuration choice.
- **Faithful:** exercises the real failure safely in this environment.

When uncertain, reproduce. Difficulty or confidence in the fix is not an exemption. If every viable hypothesis lacks a safe, faithful outcome-level witness, record why. An obvious mechanism may use the direct route with the strongest meaningful outcome guard; executable uncertainty needs a [spike](./spike.md), and an unclear approach needs [reconsideration](./reconsider-approach.md). Do not manufacture a tautological test.

Write the minimal witness without fixing product code. Run it against the pinned baseline using [isolated baseline testing](./pre-existing-validation.md#isolate-the-baseline); copy only the witness and necessary test fixtures. Keep it only after observing the expected behavioral failure; a setup or compilation failure is not reproduction. Record the command and failure. Preserve existing tests.

Trace source → state/data flow → symptom, distinguishing evidence from hypotheses. Fix the smallest root cause. Verify production writers feed new reads, readers consume new writes, callers pass new parameters, and production paths reach new branches.

Run every retained witness and affected checks until green. Any changed reproduction witness must be red again on the unfixed baseline and green on the fix. Re-run validation after corrections; never alter a witness merely to accept the implementation. When repeated attempts yield no new evidence, record the obstacle and stop.
