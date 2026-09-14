# Validate and Deliver the Pull Request

## 1. Establish the Delivery Diff

Read `session.md`; reverify the checkout, assigned branch, selected remote URL, repository and PR base. Confirm the required publication authorization and GitHub capabilities using `./github.md`. Drain all workers and account for each branch before publication. Inspect and commit remaining task-owned changes under the repository's conventions. The source tree must be clean.

Fetch the named PR base from the selected remote. Prefer the local base branch if it exists, but verify it contains the fetched base and has no unpublished base commits; if it does not, use the fetched base ref for delivery. Do not modify another checkout's base branch. Record the exact base SHA used.

Check whether this task branch is already published. Before its first push, rebase onto the verified base; resolve conflicts by listing them, inspecting each resolution, staging resolved files by name and continuing the rebase. Once published, preserve its history: integrate a newly advanced base with a regular merge on the task branch, never a rebase requiring force-push. On unresolved conflicts, preserve the evidence, abort the in-progress operation to its prior state and read `blocked.md`.

Count commits and inspect the complete PR diff against the selected base, including any supplied commits preceding this session's baseline. If no requested change remains because it is already present on the base, verify the acceptance criteria and report that evidence. Do not fabricate an empty PR or claim a PR was opened; record a no-change outcome separately from successful PR delivery.

## 2. Validation Gate

Run the validation gates the project's AGENTS.md declares. Commands must actually execute and pass. Resolve every warning and failure, including prior failures. An infrastructure error is blocking, not a pass.

Fix and rerun the failed checks; when fixes change dependencies or cross-package behavior, repeat the affected integration checks. Bound repeated attempts that produce no new evidence at three; save exact output and route to `blocked.md` if no safe remedy remains. No branch publication or PR creation follows a failed required check.

Review the final HEAD and complete PR diff against acceptance criteria, failure modes and delivered experience. Reuse recorded review evidence only for unchanged reviewed content; a rebase, conflict resolution, base merge or validation fix requires rechecking its affected behavior. Use fresh reviewers for substantial or uncertain changes. Fix findings, validate them and re-review until none remain. Record final base SHA, HEAD and gate/review evidence.

## 3. Push Only the Task Branch

Immediately before pushing, recheck authorization, clean status, unchanged HEAD and the selected remote URL. Push explicitly:

```bash
git push --set-upstream "$TASK_REMOTE" "HEAD:refs/heads/$TASK_BRANCH"
```

Never push all branches, tags, the base branch, or use force. If a host proxy rejects the assigned branch or authentication, record the exact blocker. If another writer advanced the remote task branch, fetch and inspect it; integrate only verified same-task work, then repeat validation/review before retrying. Unfamiliar changes block publication.

Verify the remote branch SHA equals the validated HEAD using `git ls-remote --heads` for that exact ref. Record the pushed SHA. A successful local commit alone is not delivery.

## 4. Create or Verify the PR

Write `TASK_STATE/reports/pr-body.md` with the concrete problem and resulting behavior, the task's intent and constraints, the implemented plan and major decisions, relevant spike evidence, validation commands/results, reviewed HEAD and review outcome, and material limitations. Include enough evidence to survive loss of the local task state. Keep temporary absolute paths and secrets out of the published body. Scale detail to the change and follow any repository PR template and host-required attribution footer.

Use the selected interface in `./github.md` to query existing open PRs for the exact repository, head branch and base. Reuse only the matching same-repository PR; multiple matches or an unexpected cross-repository head require investigation. Update its description when this task's new commits changed the result. Otherwise create it with the explicit head and base. A host tool needs the body text, whereas a CLI's `--body-file` reads the local file; do not send the path as a PR description.

If creation times out or its outcome is uncertain, query for the exact existing PR before retrying, to avoid duplicates. Read authoritative PR metadata and verify it is open, both head and base repositories match the recorded repository, its refs match the recorded branch/base, and its head SHA equals the pushed, validated HEAD. CI or mergeability claims require their own observed evidence; local validation is not proof of either. If post-push PR creation fails, preserve the branch and report delivery as blocked with the pushed SHA; do not call the task complete.

## 5. Finalize

Only after verified delivery, record this task's exact baseline/reproduction/step tag names and SHAs as cleaned, then remove those tags. Do not push or broadly delete tags. Preserve the session evidence and save `phase: complete`, repository, base, branch, final SHA and PR URL. Report the PR link, result, validation and any material limitation in the final response. Stop without merging, enabling auto-merge, closing the PR or publishing a release. Do not depend on automatic host commits, pushes, PR creation or cleanup after ending the turn.
