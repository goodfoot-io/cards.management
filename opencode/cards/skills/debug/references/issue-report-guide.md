# Issue Report Structure

Scope: the issue body template and section structure for filing a Cards extension bug.

## Report Sections

| Section | Content |
|---------|---------|
| Commander's Intent | Opening paragraph — the fixed-state world, not "the bug is fixed". Becomes the `title` field as a one-line summary |
| What happened | Narrative description of the failure |
| Steps to reproduce | Numbered and specific, noting prerequisites and consistency (reproducible vs. intermittent) |
| Expected behavior | What should have happened |
| Actual behavior | What happened instead, with error messages copy-pasted exact |
| Investigation | What you explored and found, and which channels (logs, APIs, UIs, monitoring) you checked with what each showed |
| Hypothesis (optional) | Theory about the cause, framed as exploration — "This suggests...", not "The bug is caused by..." |
| Environment | Auto-populated by `generateCardUrl()`: extension version, VS Code version, platform, node version. Supplement with reproduction-specific environment |
| Relevant logs | Tail of the most relevant log file(s) — include the log name and why it was selected |

## Writing Rules

- **Document observable facts**: exact error messages, file paths, line numbers, git state. Fragment-link every named file, function, and type.
- **Name what you cannot see** as well as what you can.
- **Check system health independently of error reports** — an error state is not the same as a crash.
- **Note missing observability** as concrete gaps: what visibility would have made this investigation easier.

## Template

```bash
cards-extension issue <<'EOF'
{
  "title": "One-line summary of the fixed-state destination",
  "body": "## What happened\n\n<narrative description of the failure>\n\n## Steps to reproduce\n\n1. ...\n2. ...\n3. ...\n\n**Reproducibility**: <always | intermittent — N of M attempts>\n\n## Expected behavior\n\n<what should have happened>\n\n## Actual behavior\n\n<what happened instead, with exact error messages>\n\n```\n<copy-pasted error output>\n```\n\n## Investigation\n\n<what you explored, what you found>\n\n- Checked <channel>: <finding>\n- Checked <channel>: <finding>\n\n## Hypothesis\n\n<theory about the cause, framed as speculation — optional, remove if none>\n\n## Environment\n\n```\n$(echo \"HOME=$HOME\" && echo \"CARDS_HOME=${CARDS_HOME:-unset}\" && echo \"WORKSPACE=$(git rev-parse --show-toplevel 2>/dev/null || echo 'not in repo')\" && echo \"HOOKS_LOG_ANCHOR=${HOOKS_LOG_ANCHOR:-unset}\" && cat ~/.cards/cards-api.json 2>/dev/null | jq '{port, pid, buildTime}' || echo 'discovery file not found')\n```\n\n## Relevant logs\n\n$(tail -50 ${HOOKS_LOG_ANCHOR}/.cards/logs/<log-name>.log 2>/dev/null || echo 'no log output at that path')\n\nSelected because: <reason this log file is the relevant one>"
}
EOF
```

### Template Notes

- The anchor variable must be set in the shell running the heredoc — §1 of `SKILL.md` sets all three. `${HOOKS_LOG_ANCHOR}` is correct for `claude-code-cards-api-hooks`; use `${MAIN_REPO_ROOT}` for `cards-default-configuration-hooks`. Do not substitute `$(git rev-parse --show-toplevel)` for either. `claude-code-cards-runtime-hooks` follows neither variable; find its path with the Quick Discovery block in `find-logs.md` and paste it literally.
- Replace `<log-name>` with the actual log filename (e.g., `claude-code-cards-api-hooks`, `claude-code-cards-runtime-hooks`, `cards-default-configuration-hooks`). Inventory in `find-logs.md`.
- Via `cards-extension issue`, do not restate extension version, VS Code version, platform, or node version — `generateCardUrl()` adds them. Via `gh issue create`, add extension and VS Code versions to Environment yourself.
- The body is a single JSON string. Multi-line content uses `\n` escaping within the heredoc — the shell expands `$(...)` before passing to `cards-extension issue`.
- Only `title` and `body` are accepted; unknown fields are rejected, and missing or empty values exit 1 with an error to stderr.

## Out of Scope

- Card creation workflows → `@cards` skill
- Interview process for gathering signal → `interview-issue-report.md`
- `cards-extension` CLI reference → `inspect-cli-tools.md`
