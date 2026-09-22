
<instructions>

## 1. Research the Answer

Read the exact unanswered user comment paths or IDs supplied by the caller. Without an explicit set, identify every unanswered user question since the last agent response; do not substitute a newer non-question comment.

Investigate the workspace to find information relevant to the question. If the question opens several lines of inquiry, fork a subagent per line.

## 2. Write Comment and Commit

Write a comment to the card repository with the answer. Fragment-link every named file, function, and type per `<markdown-guidelines>`.

Commit to the card repository:

```bash
cd $CARD_REPO_PATH
cat <<'EOF' > comments/question-response.md
[answer naming the source comment paths or IDs, with fragment links for code references per <markdown-guidelines>]
EOF
git add comments/question-response.md
git commit -m "[single sentence summarizing the answer to the question]"  # <card-repo-commit-style>
```

Question answered. If the card still has `blocked`, re-run routing so reconciliation decides whether work resumes; otherwise **STOP**.

</instructions>
