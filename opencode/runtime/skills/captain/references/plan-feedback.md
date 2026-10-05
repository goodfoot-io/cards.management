
<instructions>

## 1. Review Feedback

### 1.1 Read Card State

```bash
cd $CARD_REPO_PATH
```

Read the plan files from the `plans/` directory and the most recent `comments/*.md` files in the card repository.

### 1.2 Analyze User Feedback

From the latest user comment, identify:

- **Requested changes**: Specific modifications to the plan
- **Concerns raised**: Issues the user wants addressed
- **Questions asked**: Clarifications needed before approval
- **Scope adjustments**: Features to add, remove, or modify

## 2. Revise Plan

### 2.1 Research (If Needed)

If feedback requires additional investigation in the workspace repository:

- Read relevant files in the workspace codebase — fragment-link every named file, function, and type per `<markdown-guidelines>` in the revised plan. If the user's feedback asserts or implies a fact about the codebase ("isn't X already implemented?", "doesn't Y handle this?"), verify the assertion in the workspace before revising. A verified upstream implementation is documented in the plan's Out of Scope section as already-implemented, not added as a new phase. If the feedback asserts several such facts, a forked subagent can verify them in parallel.
- Understand implications of requested changes
  - **Feedback modifies Technical Approach** (changes data structures, shifts responsibility between components, replaces a component, simplifies a step): Re-verify the complete data-flow connections for the affected path — not only the changed sections. A design revision can disconnect wiring that was correct under the previous design. Verify that existing fragment links in plan files still point to correct locations and use workspace-relative paths (`./` = `$WORKSPACE_PATH`), not filesystem paths from the card repository.
- Identify new dependencies or risks

### 2.2 Incorporate Feedback

Update the plan to address all feedback points:

- Apply requested changes
- Address raised concerns
- Answer questions within the plan context
- Adjust scope as directed

### 2.3 Apply Markdown Guidelines

Write the plan file per `<markdown-guidelines>`.

### 2.4 Store Revised Plan

Write the updated plan to the appropriate file in the `plans/` directory in the card repository. Commit to the card repository:

```bash
cd $CARD_REPO_PATH
git add plans/
git commit -m "[single sentence summarizing what feedback was incorporated into the plan]"  # <card-repo-commit-style>
```

## 3. Assess Revised Plan

Read `./plan.md`.

## 4. Submit for Re-Approval

Post a process-oriented comment. The plan content is already in the plan files — do not summarize it.

- Explain how you incorporated the feedback, especially where interpretation was required
- Focus on what the reviewer cannot see: reasoning process, judgment calls, areas of lower certainty
- **Ambiguous feedback**: Surface your interpretation as a question with your selected answer inline
- Include surprises, new assumptions, or risks discovered during revision when useful

Write the comment to the card repository. Commit to the card repository:

```bash
cd $CARD_REPO_PATH
cat <<'EOF' > comments/plan-revised.md
[how feedback was incorporated, reasoning process and judgment calls made, interpretations of ambiguous feedback, and any surprises, new assumptions, or risks discovered during revision]
EOF
git add comments/plan-revised.md
git commit -m "[single sentence summarizing how feedback was incorporated and key judgment calls]"  # <card-repo-commit-style>
```

**STOP** — Wait for user feedback or approval. Do not modify gates in `CARD.meta.json`.

</instructions>
