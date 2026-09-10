# GitHub Access and Publication

Select an interface from the tools actually available in this session, not the platform name. Prefer the host's authenticated GitHub tools when exposed; use the GitHub CLI only when installed and authorized. Record the selection in `session.md`. Missing `gh` is not a blocker when the host supplies the needed operations. Do not install a second client, extract proxy credentials, or switch identities to bypass a denied operation.

## Preflight

1. Establish the canonical repository from the task/host assignment and verified Git remote configuration. Do not parse an internal proxy URL as a GitHub repository. Confirm read access through the selected interface to that exact repository; ambiguous identity or access is a blocker.
2. Use the supplied PR base when explicit. Otherwise obtain the default from repository metadata if the interface exposes it, or inspect `git ls-remote --symref "$TASK_REMOTE" HEAD`: the advertised `ref: refs/heads/<name> HEAD` identifies the remote default. A stale local `origin/HEAD` or a guessed `main` is not evidence. If the remote does not advertise a default, ask for the base.
3. Inspect live schemas for listing, reading, creating and updating PRs. Record missing capabilities before implementation; a read succeeding does not prove write authorization. Do not create a test PR or push a test ref to probe access.
4. Check the task and host's publication permissions. A skill cannot override a requirement for an explicit user request. Include any required attribution footer on every authorized GitHub post, including the PR description. Use the exact footer required by the host, never an invented attribution.

## Host GitHub Tools

Use the actual exposed tool names and argument casing. The following mapping applies when the host exposes the official GitHub MCP operations; a server prefix such as `mcp__github__` alone does not prove its schema:

| Operation | Inputs and required evidence |
|---|---|
| `list_pull_requests` | `owner`, `repo`, `state: "open"`, `head` (repository owner, colon, exact task branch), `base`; consume pagination and inspect matches |
| `create_pull_request` | `owner`, `repo`, `title`, `head` (task branch), `base`, `body` (the full prepared text, not a local filename) |
| `update_pull_request` | `owner`, `repo`, `pullNumber`, `body`; do not change base/state or add reviewers as a side effect |
| `pull_request_read` | `method: "get"`, `owner`, `repo`, `pullNumber`; obtain current state, URL, head/base repository identity and refs, and head commit SHA |

If only search is available for discovery, use a repository/head/base-scoped PR search and read every candidate's authoritative metadata; search results alone do not prove an exact match or the current head. An empty or incomplete search after an uncertain create is not proof that creation failed. Do not blindly repeat the write.

For an existing PR, require the head and base repositories to equal `TASK_REPOSITORY`, the head ref to equal `TASK_BRANCH`, and the base ref to equal `TASK_PR_BASE`. Multiple exact matches or an unexpected fork require investigation. Reuse the one matching open PR. Read the result after every create/update and verify its current head SHA equals the pushed, validated SHA. In GitHub PR metadata this is `head.sha`; when a tool returns another representation, require the equivalent explicit evidence rather than assuming field presence. A PR number, push message, or commit found somewhere in history is insufficient.

These are capability mappings, not permission grants or a requirement to add an MCP server. [GitHub's official MCP tool definitions](https://github.com/github/github-mcp-server#pull-requests)

## GitHub CLI

When the selected interface is an available, authenticated `gh`, verify repository identity and default with `gh repo view <verified-repository-url> --json nameWithOwner,defaultBranchRef` (the URL is positional). Never trigger interactive authentication during an unattended task.

List candidates:

```bash
gh pr list --repo "$TASK_REPOSITORY" --head "$TASK_BRANCH" --base "$TASK_PR_BASE" --state open --json number,url,headRefName,baseRefName,headRefOid,isCrossRepository
```

Create only after the exact-match check and authorized publication:

```bash
gh pr create --repo "$TASK_REPOSITORY" --head "$TASK_BRANCH" --base "$TASK_PR_BASE" --title "[Concrete change]" --body-file "$TASK_STATE/reports/pr-body.md"
```

For an existing matching PR, use `gh pr edit <number> --repo "$TASK_REPOSITORY" --body-file "$TASK_STATE/reports/pr-body.md"`. Read authoritative metadata with `gh api "repos/$TASK_REPOSITORY/pulls/<number>"` and apply the same repository/ref/state/SHA checks as the host-tool interface.

## Failure and Completion

An uncertain create/update outcome requires a read before any retry. If the write was denied, do not try a different tool to evade the denial. If PR delivery is blocked after a successful push, preserve the branch, report the verified pushed SHA and exact missing capability/authorization, and do not mark the workflow complete. Never merge, enable auto-merge, resolve unrelated review threads, or assume that the host performs publication after the final response.
