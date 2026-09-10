# Host Coordination Adapter

Keep `developer-wave.md`'s package roster, checkpoints, reports, contracts and gates unchanged. Map its operations to the tools actually exposed by this host. Record the returned worker/session identifier with every package. Never assume another platform's tool names exist, silently replace a persistent worker with a fresh task, or claim that a prompt changed an unsupported model option.

Set the brief's **report transport** explicitly: an addressed message to the lead on messaging hosts, or the protocol envelope returned as the task result on call-return hosts. A returned CHECKPOINT is a paused assignment, not a COMPLETED report. In both cases the worker ends its turn and the host-specific continuation operation resumes that same identity. Do not require a separate child-to-lead send tool on a task-return host.

## OpenCode

Use the installed host's native `task` tool with required `description`, `prompt` and `subagent_type`. Dispatch the registered `general` agent with a complete brief explicitly loading `$developer` and `$tdd-bootstrap`. Save the returned task ID per package. Continue the same worker with another `task` call carrying that `task_id`, the same agent type and the next protocol message in `prompt`. Do not use Codex's spawn/message tool names. This adapter targets the verified 1.18 native Task API; require that schema before a developer wave.

Use foreground turns by default: at `CHECKPOINT:` or `REPORT:` the worker returns, then a new call with its saved `task_id` sends `PROCEED`, `REVISE:` or `TASK:`. Independent calls may be dispatched together. `background: true` requires the host's experimental background-subagent capability to be enabled; completion is delivered automatically, without polling. A same-ID task call can add context to an active background task, but it is not a guaranteed cancellation primitive.

For `HOLD`/drain, wait until every outstanding call reaches a checkpoint or report, then leave those task sessions idle and retire them in the ledger. Never reset or remove a worktree while its task is outstanding. If it cannot settle, report blocked and retain its worktree. Skill installation does not grant permissions for worktrees outside the project; those directories must be allowed by the host before dispatch.

## Recovery and Review

On a resumed lead session, compare the worker ledger to the host's live identities and actual Git tips. Never launch a replacement while the prior worker may still be writing. Reconcile any unexpected branch changes before assigning work. Lost idle workers can be recreated with current contracts and prior reports; completed work is recognized by its Git SHA and gate evidence, not memory alone. A surviving session record or summary does not prove a running process, original filesystem, or full conversation context survived.

For fresh-eyes research or review, use the same host's supported spawn operation with a bounded read-only brief. Include the task's acceptance criteria, relevant plan/diff and the exact angle to review. Reviewers report all findings with source evidence; the lead assigns fixes to the persistent package owners and reruns the review on changed HEADs.
