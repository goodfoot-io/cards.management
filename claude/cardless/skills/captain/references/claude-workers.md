
# Claude Worker Transport

Use native `Agent` workers in the lead's container. A cloud lead does not imply that each worker needs a separate cloud session. Inspect the live schemas and available agent definitions before dispatch; the deployed tool contract takes precedence over examples here. Require `cardless:developer` and its declared `cardless:developer` / `cardless:tdd-bootstrap` preloads to resolve. See `./cloud.md` for installation and team settings.

## Native Agent Dispatch

The audited cloud `Agent` requires `description` and `prompt`; `subagent_type`, `name`, `model` and `run_in_background` are optional. Dispatch a package worker with:

```json
{
  "description": "Implement assigned package task",
  "subagent_type": "cardless:developer",
  "name": "developer-package",
  "run_in_background": true,
  "prompt": "[Complete developer-wave brief, including literal worktree, branch, skill paths and lead messaging identity]"
}
```

Choose a unique stable name matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Save both that name and the exact returned identity in `workers.md`, along with `transport: native Agent`; do not manufacture a `session_*` ID. Omit `model` to inherit the configured agent/default model. When selecting an override, use the live enum: the audited schema allows `sonnet`, `opus`, `haiku`, `fable`, not full model IDs. A `fork` inherits the parent model regardless of an override, so it is not the package developer type. Do not pass `mode` (deprecated and ignored), remote-session fields, or unsupported effort options.

Omit `isolation`: the captain has already allocated this worker's branch/worktree through `./worktrees.md`. `isolation: "worktree"` would allocate a second checkout; `isolation: "remote"` changes the filesystem and delivery model. There is no `cwd` argument in the audited schema; the prompt must direct the worker to its literal checkout and the worker must verify it before editing.

Before the first implementation assignment on an unverified host, use a read-only two-turn probe on the named package worker. Have it load both required skill entrypoints and the repository instructions, report their resolved paths, verify the assigned branch, and read a task-specific non-secret marker from the lead's state directory. Compare its resolved common Git directory and visible worktree/HEAD with the lead's. Have it remember a nonce, send a checkpoint to the lead and end its turn; resume the same returned identity without repeating the nonce and require it to report it. Record the observed continuation and access evidence. A fresh clone of the same repository, a path merely echoed from the brief, or a remote-session reuse test does not prove these native-worker capabilities. Failure is a blocker; do not start code edits on an unproven transport.

## Messages and Checkpoints

Use the live `SendMessage` schema: in the audited host, `to` selects the worker's recorded name/identity and `message` carries the full protocol envelope. Supply the lead's actual messaging identity in every brief; never assume `main` resolves without evidence. User-facing prose is not a worker message.

`CHECKPOINT`, `PROCEED`, `REVISE`, `TASK`, `HOLD` and `HELD` are this skill's application protocol, not tool operations. At a checkpoint the worker sends its evidence through `SendMessage`, stops editing and **ends its turn**. It remains idle until a new addressed message starts its next turn. Send `PROCEED` or `REVISE:` to that same identity; confirm actual resumption before assigning dependent work. Do not spin, sleep indefinitely, or declare a task complete just to pause.

`HOLD` is cooperative: a message accepted or queued while a worker runs is not proof it stopped. Wait for `HELD:` or a completed report plus an idle state before integrating, inspecting a stable diff, resetting, or cleaning its worktree. An interrupt is not a clean checkpoint; inspect any partial state before reuse. If the live host exposes neither reliable idle continuation nor a way to confirm quiescence, retain the worktree and report blocked.

For on-this-machine workers, use `notify_when_idle: true` only when the live `SendMessage` schema advertises it. It is a one-shot notice, not a cross-machine subscription. Use completion notifications/the host's supported event wait and process every message; an idle notification without a protocol report is not success. Do not infer unlimited concurrency from one successful dispatch: respect declared limits, keep the roster reviewable, and queue work when capacity is unknown or exhausted. Do not busy-poll session listings.

At drain, obtain held/completed evidence first. Use a shutdown/retirement operation only if exposed for this exact worker transport, and verify the worker cannot still write. If native workers have no explicit retirement primitive, confirmed idle workers can be retired in the ledger with no further messages; preserve their worktrees if late execution cannot be ruled out. Do not invent `TeamCreate`, `TeamDelete`, or a shutdown protocol absent from the live tools.

## Remote Sessions Are Separate

`mcp__Claude_Code_Remote__create_session` and `Agent` with remote isolation are not replacements for the native shared-container worker. Their model IDs, clone configuration, session IDs, interrupt/archive operations, inheritance and messaging semantics must not be mixed with this adapter. A remote session can retain its ID while its VM and unpushed files disappear; archiving may release its container. Never archive a native worker by guessing a corresponding remote session ID.

This workflow integrates local worker refs and grants remote publication only to the lead. Separate-VM workers would need an explicitly designed, verified commit-transfer and permission contract; merely passing a local path or `source_url` does not provide one. If only remote-session creation is available, record the missing native-worker capability and stop before dispatch. Do not silently introduce worker pushes, extra task branches on the remote, credential forwarding, or copying scratchpads between containers.
