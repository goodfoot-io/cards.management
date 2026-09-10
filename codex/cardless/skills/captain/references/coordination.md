# Host Coordination Adapter

Keep `developer-wave.md`'s package roster, checkpoints, reports, contracts and gates unchanged. Map its operations to the tools actually exposed by this host. Record the returned worker/session identifier with every package. Never assume another platform's tool names exist, silently replace a persistent worker with a fresh task, or claim that a prompt changed an unsupported model option.

Set the brief's **report transport** explicitly: an addressed message to the lead on messaging hosts, or the protocol envelope returned as the task result on call-return hosts. A returned CHECKPOINT is a paused assignment, not a COMPLETED report. In both cases the worker ends its turn and the host-specific continuation operation resumes that same identity. Do not require a separate child-to-lead send tool on a task-return host.

## Codex

Use the current collaboration tools: `spawn_agent` once per package, `send_message` for context or protocol messages while a worker is running, and `followup_task` to reengage an idle worker. A queued message to an idle worker does not start a turn. Pass a descriptive `task_name` and the complete brief in `message`, explicitly requesting `$cardless:developer` and `$cardless:tdd-bootstrap`. Use only model/reasoning and context-fork options exposed by this host; inherit its defaults where no override is needed.

At a checkpoint the child reports and ends its turn; `followup_task` with `PROCEED` or `REVISE:` resumes the same identity. Concurrent independent spawns form a wave; inspect completions with the host's agent-list/wait operations and process every report. At drain, message running children with `HOLD`, wait for their held/completed reports, then mark the idle roster entries retired. Do not start further turns on retired workers; interrupt only to stop a stuck worker, then inspect its files before cleanup. Recreate lost identities from the ledger on the same worktree rather than pretending a dead session resumed.

## Recovery and Review

On a resumed lead session, compare the worker ledger to the host's live identities and actual Git tips. Never launch a replacement while the prior worker may still be writing. Reconcile any unexpected branch changes before assigning work. Lost idle workers can be recreated with current contracts and prior reports; completed work is recognized by its Git SHA and gate evidence, not memory alone. A surviving session record or summary does not prove a running process, original filesystem, or full conversation context survived.

For fresh-eyes research or review, use the same host's supported spawn operation with a bounded read-only brief. Include the task's acceptance criteria, relevant plan/diff and the exact angle to review. Reviewers report all findings with source evidence; the lead assigns fixes to the persistent package owners and reruns the review on changed HEADs.
