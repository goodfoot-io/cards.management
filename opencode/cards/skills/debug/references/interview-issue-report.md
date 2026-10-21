# Interview Before Filing an Issue

Scope: interview process for gathering signal before filing a Cards extension bug.

## 1. Gather Runtime Evidence First

Before engaging the user, run the debug skill's §1 fingerprint plus:

```bash
# Logs — select the most relevant subsystem (see find-logs.md for the inventory)
tail -100 ${WORKSPACE}/.cards/logs/<log-name>.log 2>/dev/null

# Discovery file — server state at time of failure
cat ~/.cards/cards-api.json 2>/dev/null | jq '{port, pid, buildTime}'

# Plugin cache — hook binary state
find ~/.claude/plugins/cache ~/.codex/plugins/cache -name 'hooks.json' -type f 2>/dev/null

# Worktree state — if the failure involves worktrees
git worktree list 2>/dev/null
cat .cards/CARD_ID 2>/dev/null || echo 'not card-bound'
```

Source code and compiled bundles are out of scope per `SKILL.md` — never grep/read them and never dispatch an agent into source, git history, or tests.

## 2. Interview and Accumulate Findings

`./issue-report-guide.md` defines the issue body structure this interview drives toward. Do NOT load the `@cards` variants; those target card creation.

Interview the user conversationally; the commander's intent is built through the conversation, not drafted as a document.

- Keep each exchange short. Reflect back what you're hearing and follow up on what matters underneath the report. Match the user's register.
- Use the `AskUserQuestion` tool for discrete classifications the user is best placed to pick:
  - Ask one question per turn. Batch only when a single scenario illustrates the whole cluster.
  - Attach several short "good" and "bad" scenarios to each option — concrete, one-line each — when picking exposes non-obvious downstream consequences.
  - Topic axes: regression vs. latent, reproducibility class, repro surface, source of expected behavior, repro-data shape.
  - Stay in chat for the reproduction narrative, observed-vs.-expected framing, and anything that risks freezing the user's hypothesis.
- Target what only the user can supply: reproduction specifics, environment, observed vs. expected, sensitivity of repro data, and workarounds — probe *how* a workaround makes the bug go away.
- Anchor in the user's frame: name the artifact, command, or moment they will see.
- Separate observation from interpretation; do not let the user's hypothesis narrow the investigation.

As the conversation settles pieces of the destination, hold findings, user answers, and rejected hypotheses in conversation state, shaped against the section structure in `./issue-report-guide.md`.

## 3. File the Issue

Compose the one-line title and check it with the user inline.

Confirm GitHub authorization before offering a channel — run the checks, fail closed on any failure:

```bash
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && echo GH_AUTHORIZED
# No gh CLI: a token integration counts once the API accepts it
[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && curl -sf -H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}" https://api.github.com/user >/dev/null && echo TOKEN_AUTHORIZED
```

- **Authorized**: offer `gh issue create` first, against the repository resolved from the workspace git remote (`git -C "${MAIN_REPO_ROOT:-$WORKSPACE}" remote get-url origin`). Verify any other GitHub integration against its API before offering it too.
- **Not authorized or declined**: file via `cards-extension issue`.

Either way the body follows `./issue-report-guide.md`.

```bash
gh issue create -R <owner/repo> --title "<title checked with the user>" --body-file <body-file>   # prints the issue URL; body file avoids JSON escaping

cards-extension issue <<'EOF'
{
  "title": "One-line summary checked with the user",
  "body": "..."
}
EOF
```

If `gh issue create` fails (permissions, issues disabled), fall back to `cards-extension issue`.

## 4. Constraints

- No fixes. No code, no remediation, no test stubs.
- Never ask the user to look something up. If it is recoverable from CLIs, runtime state, or logs, find it yourself — but not from source or compiled bundles (see §1).
- Never ask for the environment fingerprint or system info — the report auto-captures it.
- Do not ask the user how the bug currently affects them or to rate its severity — current-impact questions yield answers that are neither actionable nor relevant. Derive impact and blast radius from the reproduction and observed failure surface, ranking by consequence rather than volume: silent data corruption outranks visible crashes.
- Ask only for the expected observable behavior, never for the resolution. Do not ask the user where the fix should live, which component to change, or which mechanism resolves the defect.

## 5. Finalize

`gh issue create` prints the issue URL; `cards-extension issue` opens the pre-filled issue in the browser for the user to submit. Either way, report the title and URL/next step to the user.

**STOP** — Interview complete. Do not proceed to implementation.

## Out of Scope

- Card creation workflows → `@cards` skill
- Report structure reference → `issue-report-guide.md`
- `cards-extension` CLI reference → `inspect-cli-tools.md`
- Decisions about whether a bug is in the Cards extension vs. another component — the debug skill's routing tables answer this before reaching the interview
