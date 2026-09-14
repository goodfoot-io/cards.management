
<placeholder-variables>
[BUG_DESCRIPTION] — One-sentence summary extracted in Step 1.2: "[Expected behavior] but [actual behavior]"
[SCOPE_HINT] — Files, packages, or functions mentioned in the card, extracted in Step 1.2
[TEST_FAILURE_OUTPUT] — Combined failure output from the reproduction tests, captured in Step 1.6
</placeholder-variables>

<test-first-invariant>
1. Every reproduction test MUST fail before the fix.
2. Any test modification during resolution requires re-validation.
3. Every reproduction test MUST pass after the fix.
</test-first-invariant>

<instructions>

## 1. Prepare and Reproduce

### 1.1 Validate Workspace State

Run `git status --porcelain`:
- **Clean**: proceed.
- **Dirty**: Read `./bug-dirty-tree.md`. Return here when its flow returns control (the **off-card** branch ends in **STOP**).

Create the baseline tag if one does not already exist. The baseline is pinned — it does not advance during bug resolution.

```bash
if git rev-parse "bug/$CARD_ID/baseline" >/dev/null 2>&1; then
  echo "Baseline tag already exists — resuming from prior checkpoint."
else
  git tag "bug/$CARD_ID/baseline" HEAD
fi
```

### 1.2 Read Card and Extract Context

Read `CARD.md` from the card repository. Read CARD.meta.json for current `title`, `gates`, and `tags`. Extract `[BUG_DESCRIPTION]`, `[SCOPE_HINT]`, and any verbatim error messages or stack traces.

Based on the card's shape:
- **Describes a capability gap** (language like "add", "implement", "support", or an inability to fill in "[Expected] but [Actual]" because no actual behavior exists): This is a feature request, not a bug. Write a comment explaining the triage, commit, and Read `./plan.md` to continue.
- **Describes an observed-vs-expected mismatch**: Proceed to Step 1.3: Identify Root Cause Hypotheses.

### 1.3 Identify Root Cause Hypotheses

Enumerate all plausible root causes based on card content, error messages, and stack traces. For each hypothesis, state:
- What could cause this behavior.
- Which code paths or data-flow segments are implicated.
- What evidence supports or contradicts it.

If every hypothesis reduces to "the described behavior is not implemented anywhere," the card is a missing-feature request rather than a bug. Write a comment explaining the finding, commit, and Read `./plan.md` to continue.

### 1.4 Assess Reproduction Suitability

Reproduction is the default; fail closed — when in doubt, reproduce.

**First principle — reproduce only if a discriminating test can exist.** Before writing any reproduction, state, in one sentence, the test you would write and confirm all three properties hold for it:

1. **Discriminates** — it fails *because* the bug is present and passes *only* when the fix is applied. A test that would pass on the unfixed code, or that restates the fix rather than observing its effect, discriminates nothing.
2. **Observes behavior** — it asserts an observable outcome, not which API/config/internal was used. If the fix and the assertion are the same edit phrased twice, it observes nothing.
3. **Runs faithfully here** — it exercises the real failure in this environment without an unsafe or irreversible act. A test that can only pass/fail based on *where* it runs, or that must crash the machinery to be faithful, runs nothing.

If you cannot write that one sentence — if every candidate test drops at least one property — then no reproduction exists to write, and you divert to `./plan.md`. This is the general rule; the disqualifiers below are just the three recurring ways a property fails. Divert only when the failure holds **for every viable hypothesis** and no **outcome-level** test (asserting observable behavior, not which API was called) survives all three properties either:

- **Tautological** (fails property 1–2) — the fix *is* the mechanism or config change, so any test only restates the implementation. Fix is "stop calling `fs.watch`" → test asserts `fs.watch` uncalled. Fix is a config/build/CI setting → test asserts the setting; there is no behavioral layer between the setting and the result.
- **Dangerous** (fails property 3) — a faithful reproduction must perform an unsafe or irreversible act: resource exhaustion (fork/watch/fd/memory storms, OOM, DoS load), data loss, or mutating an external or credentialed system.
- **Cost-prohibitive or environment-bound** (fails property 3) — faithful reproduction needs infeasible fixtures or scale, or the symptom is platform/kernel/hardware/CI-specific so the test probes *where* it runs, not whether the bug is present.

These three are the common ways a property fails; they are examples, not an exhaustive whitelist — apply the first principle when a bug fits none of them by name. "Hard", "slow", "obvious", and "I'm confident" are not disqualifiers — reproduce anyway. But confidence that reproduction is *feasible* never overrides a missing property: a tautological or environment-probing test you *can* write is still not a reproduction.

On divert: write a comment naming the disqualifier and why no outcome-level test fits, commit, and Read `./plan.md` (the planning path picks an outcome guard where one is meaningful). Otherwise proceed to Step 1.5.

### 1.5 Write Reproduction Tests

With several viable hypotheses, consider a subagent per hypothesis, each returning its trace verdict and any committed failing test.

For each viable hypothesis, in turn:
1. Trace code and data-flow paths in the workspace to assess whether the hypothesis is viable.
2. If viable: write a minimal reproduction test that MUST FAIL against the current unfixed code. Do not modify existing tests. Follow existing test patterns. Do not fix the bug yet.
3. If not viable: discard the hypothesis and note why.
4. Run the new test file. Discard it if it passes — only tests that actually fail are kept.

### 1.6 Commit Reproduction

**Every commit below follows the `<workspace-commit-style>` and `<markdown-guidelines>` conventions.**

Based on the reproduction results:
- **One or more tests fail**: Commit all failing tests in one commit, tag the state, capture `[TEST_FAILURE_OUTPUT]`, write a progress comment to the card repository listing each viable pathway and its test, commit the card repository, and proceed to Step 2: Resolve Bug.
- **No tests fail, new evidence expanded the hypothesis set** (max 3 rounds total across Step 1.3–1.6): Return to Step 1.3: Identify Root Cause Hypotheses.
- **No tests fail, hypotheses exhausted**: Write a comment explaining what was tried and why reproduction failed, and **STOP** — awaiting user direction.

```bash
git add [test files]
git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines>]
COMMITMSG
)"
git tag -f "bug/$CARD_ID/reproduction" HEAD
```

## 2. Resolve Bug

Resolve is a retry loop, bounded at 3 attempts. Each attempt runs Step 2.1: Trace Data Flow, Step 2.2: Fix, and Step 2.3: Validate and Commit.

### 2.1 Trace Data Flow

<scope-rules>
**Non-deterministic bugs**: If `[TEST_FAILURE_OUTPUT]` lacks `file:line` location information (for example, timeout or race condition), data-flow tracing may not be possible. Document what is known and treat the data-flow path as a hypothesis rather than a trace.
</scope-rules>

For each failing reproduction test, map how bad data flows from origin to symptom:

1. **Symptom** — where the bug manifests, taken from `[TEST_FAILURE_OUTPUT]`.
2. **Source** — trace backward: what data or state causes the symptom, and where is that set.
3. **Path** — the chain `source → [intermediates] → symptom`.

**Verification rule:** Any fix must modify the data-flow path such that correct data flows from source to symptom.
- **Fix adds a new read**: verify something writes the data.
- **Fix adds a new write**: verify something reads the data.
- **Fix adds a new parameter**: verify callers pass it.
- **Fix adds a new branch**: verify production code triggers it.

Fixes that fail this check create dead code — new capabilities never exercised.

### 2.2 Fix

Fix the source code so every failing reproduction test passes, guided by the data flow from Step 2.1. The fix must modify the data-flow path so correct data reaches every symptom. Do not break existing functionality.

If a reproduction test itself is wrong (asserts the wrong thing, or the scenario it encodes doesn't match the bug), fix the test instead and proceed to Step 2.4: Test Correction Flow rather than continuing here.

### 2.3 Validate and Commit

Run every reproduction test. Then lint and typecheck per the project's CLAUDE.md validation conventions, and re-run only the failing test or suite until it passes; broaden to the changed package's suite once green, and defer cross-package runs to Step 3: Validate.

Based on the combined result:
- **All reproduction tests pass and all validations pass**: Commit the fix and proceed to Step 3: Validate.
- **Reproduction test still fails, or validation fails on implementation grounds**: Treat as NEEDS_REVISION. Discard your uncommitted work and retry per Step 2. If retries are exhausted (3 attempts), write a comment explaining attempts and the specific technical obstacle, commit, and **STOP**.
- **Cannot proceed** (structural obstacle): Write a comment with the reasoning, add `blocked` to `tags` in `CARD.meta.json`, commit, and **STOP**.

Commit on success:

```bash
git add -A
git commit -m "$(cat <<'COMMITMSG'
[commit message per <workspace-commit-style>; fragment-link every named file, function, and type per <markdown-guidelines>]
COMMITMSG
)"
```

NEEDS_REVISION rollback:

```bash
git restore .
git clean -fd
```

### 2.4 Test Correction Flow

A reproduction test needs correction. Validate the correction before accepting it. This flow is bounded at 2 corrections across the whole resolve loop.

1. Revert any non-test source changes made since `bug/$CARD_ID/reproduction`.
2. Run the corrected test.

Based on the corrected test's result:
- **Fails (valid correction)**: Commit the corrected test, update the tag (`git tag -f "bug/$CARD_ID/reproduction" HEAD`), capture new `[TEST_FAILURE_OUTPUT]`, and return to Step 2.2: Fix.
- **Passes (invalid correction)**: Revert the test. If resolve attempts remain, return to Step 2.2: Fix. Otherwise write a comment explaining test-validation failure and **STOP**.
- **Corrections exhausted (2 already applied)**: Write a comment reporting that the reproduction test became unreliable during the fix process, describing what went wrong and why it cannot be trusted to verify the fix, commit, and **STOP**.

## 3. Validate

Run workspace lint and typecheck, plus each package suite the fix touches.

<validation-gate>
**Gate requirement:** ALL validation commands must pass.

| Rationalization | Why it is wrong |
|-----------------|----------------|
| "Pre-existing issue" | You must fix it or block |
| "Unrelated to my changes" | Prove it by fixing it, or block |
| "Infrastructure failure" | Infrastructure IS the product |
| "Only linting/types pass" | Tests are required, not optional |
| "Change is purely cosmetic" | Cosmetic changes can still break tests |
| "Tests are flaky" | Flaky = race condition = production bug |
| "Works in other environments" | Must work HERE |

Validation is binary — there is no "probably fine" state.
</validation-gate>

Based on the result:
- **All validations pass**: Proceed to Step 4: Finalize.
- **Resolvable error**: Fix it and re-run validation.
- **Unresolvable error**: Write a comment with the exact failure output, add `blocked` to `tags` in `CARD.meta.json`, commit, and **STOP** — do not retry hoping it resolves itself.

## 4. Finalize

### 4.1 Tag Cleanup

Remove the baseline and reproduction tags — the rollback window is closed once the fix is finalized.

```bash
git tag -d "bug/$CARD_ID/baseline" "bug/$CARD_ID/reproduction" 2>/dev/null
```

### 4.2 Complete or Await Review

Based on `gates.mergeRequestRequired`:
- **false or unset**: Read `./merge.md`.
- **true**: **STOP** — Merge occurs after user approval.

</instructions>

<baseline-worktree-testing>

The `create-worktree` command is a plugin-provided executable on `PATH`. Use it when you need an isolated Git worktree.

To test against the baseline, create a temporary worktree — never switch branches or stash in the current workspace:

```bash
create-worktree "bug/$CARD_ID/baseline"
```

Run tests in the worktree, then delete the worktree and branch.

</baseline-worktree-testing>
