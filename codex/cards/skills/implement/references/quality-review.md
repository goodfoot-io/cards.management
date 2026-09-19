# Quality review

Review the baseline-to-final diff, pending edits, and card acceptance criteria yourself after required checks pass.

**Failure modes:** trace consumers, data flow, boundaries, async/shared state, and error paths. Identify mechanisms the checks could miss and concrete witness configurations.

**Delivered outcome:** exercise the user-facing entry points against the card. Verify behavior and usability, not merely file changes or passing internal checks.

Fix each finding at its mechanism, covering affected configurations with meaningful checks. Keep changes scoped; [reconsider](./reconsider-approach.md) when a finding invalidates the approach. Commit, revalidate, and review again until no findings remain. [Return to implementation](./implementation.md); never modify approval gates.
