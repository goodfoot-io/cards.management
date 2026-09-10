# Recover and Validate Existing Work

This route handles interrupted implementation, a stale review, or work whose readiness is uncertain. It may route backward to planning or implementation on evidence; it may advance to delivery only after review.

## 1. Prepare

Read `session.md`, the brief, current plan and worker ledger. Verify the pinned baseline; do not reconstruct it from the latest task commit or current HEAD. If host resumption lost worker sessions, follow `coordination.md` to recreate identities from recorded branches and reports.

Classify dirty changes through `bug-dirty-tree.md`. Commit only coherent task-owned recovery work when hooks permit it. Keep the baseline fixed so recovered commits remain inside the review diff.

## 2. Validate

Run repository lint/typecheck and the package suites touched by the baseline diff, plus current-plan requirements. The full integration gate is in `deliver.md`. Resolve every warning and failure. For uncertain ownership, use `implementation.md`'s `<pre-existing-diagnosis>`; a check blocked by infrastructure blocks this route.

If the saved phase was bug reproduction, preserve its reproduction-first invariant: a deliberately red reproducer returns to `bug.md`'s resolve step rather than being treated as completed implementation.

## 3. Assess Readiness

Compare the brief, plan tasks, recorded commits, baseline diff and validation evidence. If work is unfinished, read `implementation.md` when a current plan exists or `plan.md` otherwise. If the recorded plan assumption proved false, return to planning with the new evidence. Do not route forward merely because the tree is clean.

## 4. Review

Review completeness against acceptance criteria alongside runtime failure modes and delivered experience. Use fresh-eyes subagents for substantial diffs. Findings require fixes followed by validation and re-review of the new HEAD; a changed approach returns to planning, and a structural obstacle routes to `blocked.md`.

Once no findings remain, save the reviewed HEAD and evidence, drain any remaining workers and read `deliver.md`. Preserve baseline refs until delivery succeeds.
