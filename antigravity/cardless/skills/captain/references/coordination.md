# Host Coordination Adapter

Keep `developer-wave.md`'s package roster, checkpoints, reports, contracts and gates unchanged. Map its operations to the tools actually exposed by this host. Record the returned worker/session identifier with every package. Never assume another platform's tool names exist, silently replace a persistent worker with a fresh task, or claim that a prompt changed an unsupported model option.

Set the brief's **report transport** explicitly: an addressed message to the lead on messaging hosts, or the protocol envelope returned as the task result on call-return hosts. A returned CHECKPOINT is a paused assignment, not a COMPLETED report. In both cases the worker ends its turn and the host-specific continuation operation resumes that same identity. Do not require a separate child-to-lead send tool on a task-return host.

## Antigravity

Use `invoke_subagent` with the built-in `self` role and a complete brief explicitly loading the `developer` and `tdd-bootstrap`. Select inherited/shared workspace access because the lead already owns the explicit package worktrees; do not also ask the host to allocate another branch worktree. Use only model-tier and parameter names exposed by the installed tool. Save the returned conversation ID for each package.

Use `send_message` addressed to that conversation ID for `TASK:`, `PROCEED`, `REVISE:` and `HOLD`; it can wake an idle child. Use `manage_subagents` to inspect or retire the exact recorded child after its held/completed report. Require these capabilities before a wave, and do not use Claude's differently cased tool names. Children start with fresh context: always include literal paths, ownership, task intent, contracts and gates. Reconstruct a lost child on its recorded worktree from the ledger. [Subagent workspaces and context](https://www.antigravity.google/docs/subagents/).

## Recovery and Review

On a resumed lead session, compare the worker ledger to the host's live identities and actual Git tips. Never launch a replacement while the prior worker may still be writing. Reconcile any unexpected branch changes before assigning work. Lost idle workers can be recreated with current contracts and prior reports; completed work is recognized by its Git SHA and gate evidence, not memory alone. A surviving session record or summary does not prove a running process, original filesystem, or full conversation context survived.

For fresh-eyes research or review, use the same host's supported spawn operation with a bounded read-only brief. Include the task's acceptance criteria, relevant plan/diff and the exact angle to review. Reviewers report all findings with source evidence; the lead assigns fixes to the persistent package owners and reruns the review on changed HEADs.
