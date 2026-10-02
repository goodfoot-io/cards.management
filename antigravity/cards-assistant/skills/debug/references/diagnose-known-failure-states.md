# Diagnose known failure states

Scope: troubleshooting runbook for the explicit operational failures defined by Cards packages. Diagnose before fixing.

## Installation-only capability boundary

The installed extension, bundled CLIs, runtime files, logs, and this reference are sufficient to work the whole procedure below: map a code to its family, run read-only checks, apply the supported local remedies, verify, and produce a redacted escalation bundle.

Source code and source-analysis tools are not required or assumed. Report an unlisted or internal failure from runtime evidence rather than reverse-engineering it.

Some resolutions require information or authority the installation cannot supply:

| Required information or authority | Why it is needed |
| --- | --- |
| Exact nested diagnostic/log entry | User-facing messages intentionally collapse multiple underlying causes — the surface message is not enough |
| Extension version, build channel, configured environment, and safe signing key ID | Distinguishes an incompatible build or environment from an invalid license |
| Request, flow, card, session, or correlation identifier plus timestamp | Correlates local symptoms with server records without sharing secrets |
| Authoritative account, billing, entitlement, revocation, deployment, or issuance state | Only the owning service or administrator can confirm or change it |
| Repository/worktree ownership and uncommitted-state confirmation | Required before any cleanup that could remove user work |
| A named authorized actor or support destination | Issuer-, administrator-, release-, and service-owned remedies cannot be performed locally |

When any required item is unavailable, the correct result is a report that names the missing evidence or authority. Do not guess.

## Identify the state

1. Record the exact code, message, operation, lifecycle stage, timestamp, and earliest nested cause.
2. Classify the cause as input, configuration, environment, permissions, external service, stale/concurrent state, corrupted state, or product defect.
3. Distinguish transient/retryable states from terminal states. Retry only after a documented prerequisite changes.
4. Collect only safe identifiers, versions, statuses, timings, and sanitized path topology. Never collect raw JWTs, license codes, access tokens, cookies, verification codes, authorization headers, card contents, attachment payloads, mailbox contents, keychain material, or secrets embedded in configuration.

## Route and resolve

| Failure family | Identifiers and symptoms | Supported first resolution | Report when |
| --- | --- | --- | --- |
| Extension agent/configuration | `InvalidRepoRootError`, `no-writable-locations`, `parse-error`, `write-error`, malformed marketplace/TOML, symlink collision | Open the intended repository/scope; repair only the malformed configuration after backup; correct permissions or an owned collision | A valid absolute repository is rejected, packaged manifests are incomplete, or safe configuration still fails |
| Extension Git/worktrees/views | `GitNotFoundError`, missing VS Code Git API, invalid/missing commit, failed worktree command, rejected move, invalid compare state, missing webview assets | Restore repository/ref prerequisites; resolve conflicts; inspect worktree ownership before cleanup; rebuild or reinstall packaged views | Valid state remains undiscovered, internal state invariants recur, or cleanup risks user work |
| Browser registration | Registration/polling already active, start failure, `timeout`, `cancelled`, expired claim, server/protocol error | Let the active owner finish; restore connectivity; start a new claim after timeout/expiry | Normal UI creates concurrency conflicts, non-OK responses persist, or protocol state is unknown |
| License refresh | Refresh already active, HTTP 400/401/403, 5xx/network/abort, malformed response, rejected replacement | Let one refresh finish; re-register after definitive rejection; retry transient failures only after service recovery | A fresh license is rejected, revocation ownership is unclear, or persistence fails |
| License validation | `invalid_format`, `unknown_key`, `invalid_signature`, `expired`, `revoked`, `wrong_device` | Recopy/reissue without editing; match issuing and trusted environments; renew; register on the intended installation | A freshly issued license reproduces or issuer-controlled signing/schema data is implicated |
| Registration integrity | Missing/tampered usage state, clock rollback, device/SecretStorage discontinuity, invalid trusted-key/test-mode state | Restore legitimate environment continuity; correct host time; allow real time to pass the high-water mark | State was lost without modification, high-water time is implausible, or packaged trust data is invalid |
| Extension runtime/lifecycle | `Server not running`, `Store not available`, database recovery failure, action/adapter failure | Complete activation; restart once; reload once; preserve database backup and nested cause | Restart/reload fails, recovery remains incomplete, or an internal adapter invariant recurs |
| Authentication/billing | Stable access/registration/identity/JWT/billing codes, webhook or grant rejection | Correct authoritative configuration/state; use an authorized administrator or issuer; replay only idempotently | Ownership is unclear, valid authoritative state is rejected, or an unknown/internal code appears |
| Cards service/store | `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `INTERNAL_ERROR`, `ENVIRONMENT_NOT_FOUND`, `CONCURRENT_CARD_WRITE`, store/database guards | Correct input/auth; refresh identifiers; reconcile concurrent writes; rebuild incompatible derived state from source | `INTERNAL_ERROR` occurs, initialization still fails, or authoritative Git/store state disagrees |
| Demo automation | Invalid target/transport, missing artifacts/editor/display, connection/auth/mail timeout, recording/QA/download/patch failure | Correct the named preflight stage and rerun only that stage; request fresh auth codes; clean failed dedicated instances | The first failing stage remains after prerequisites are verified or selector/protocol drift is suspected |
| Tree/Git internals | Missing base ref, watcher path failure, corrupt Git object, overlay conflict, blame/URI invariant | Restore/correct refs; refresh stale overlays; run read-only Git integrity checks before owner-led repair | Object corruption or blame/URI invariants occur; do not fabricate attribution |
| Website/release | JWT/manifest/argument validation, staging-first gate, Wrangler output drift, generated-asset contract | Correct the named manifest/input; deploy the same SHA through staging; restore the documented asset contract | The fail-closed release gate rejects valid state or external tool output changed |
| Agent hooks/session state | Missing hook context/card access, attribution/nudge/transcript/cleanup/session-lock failure | Restore required hook/session context; verify card binding and lock ownership; rerun after stale owner cleanup | A live owner may exist, attribution is ambiguous, or cleanup would destroy session evidence |
| Default configuration | Agent launch/session/trust/plugin/discovery/branch-graph/owner assignment failure | Correct generated configuration and prerequisites; inspect authenticated assignment and cleanup decisions; preserve trust and checkout content guards | Generated defaults disagree with consumers or assignment/refusal outcomes contradict durable admission and Git state |
| SDK API/events | `ApiError`, `NetworkError`, HTTP/protocol failure, subscriber error, abort, timeout | Restore discovery/connectivity; correct request data; isolate subscriber faults; establish mutation outcome before retry | Unknown server codes, malformed responses, or ambiguous mutation outcomes persist |
| SDK configuration/watcher/CLI | Missing action env, watcher registration/handshake, CLI argument/schema/build/output collision, discovery failure | Correct environment/schema/output layout; restore server; require protocol-compatible `hello-ack` | Handshake remains invalid or a valid build/configuration is rejected |
| SDK worktrees | Invalid SHA/ref/branch, destination collision, `SymlinkPrivilegeError`, `WorktreeIncludeError`, rollback failure, `WorktreeScopeError`, `BranchUnregisterError` | Fix preconditions/privileges; preserve collisions; inspect partial rollback; unregister stale server state after local removal | Creation and rollback both fail, scope/integrity guards trigger, or disk/API state diverges |

## Verify and report

Verification must repeat the original operation and confirm its intended durable state, not merely the absence of an error. For mutations, check both local and server state and avoid duplicate retries when the prior outcome is unknown.

Stop retrying after one attempt made following a concrete prerequisite correction, unless the owning reference specifies otherwise. Escalate with:

- exact stable code/message and nested cause;
- operation, lifecycle stage, timestamp, and minimal reproduction;
- component, extension/client/server versions, platform, and environment name;
- sanitized IDs, path topology, HTTP status/request ID, timing, and relevant log excerpt;
- checks performed, remediation attempted, and observed durable state;
- the responsible subsystem and the actor or authority needed next.

Never bypass signature validation, revocation, expiry, device binding, authorization, path containment, worktree scope, concurrency, trust, or integrity checks. If resolution requires doing so, report the failure instead.
