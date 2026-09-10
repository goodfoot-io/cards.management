# Transport dependency closure

Every producer and consumer of the local-IPC control transports that the runtime protocol replaces. This is the inventory the card's plan requires before the protocol is frozen; each row names what must be migrated, what consumes it today, and which delivery class governs it under the new contract.

The contract itself is the `runtime-*` modules beside this file, exported through [the protocol barrel](./public/packages/sdk/src/protocol/index.ts) as `@cards.management/sdk/protocol`. It lives in the SDK rather than the server because every party to it — the server, the SDK client, the CLI, and the agent hooks — must decode the same envelopes, and the server already depends on the SDK. Server code may import it through the alias at [src/runtime/protocol/index.ts](./packages/cards/server/src/runtime/protocol/index.ts).

Three channels are in scope, and keeping them apart matters because two are local IPC and one is already a WebSocket that is often mistaken for them.

| Channel | Endpoint | Listener | Dialer | Framing |
| --- | --- | --- | --- | --- |
| **A — per-action control socket** | `~/.cards/a-{pid}-{8hex}.sock`, or `\\.\pipe\cards-a-{pid}-{8hex}` on Windows | [ActionDispatcher](./packages/extension/src/runtime/ActionDispatcher.ts#L856) | [wrapper](./packages/cards/server/src/runtime/wrapper.ts#L95), [SocketClient](./public/packages/sdk/src/config/socket-client.ts#L105), [`cards shutdown`](./public/packages/sdk/src/bin/cards.ts#L1219), agent stop hooks | NDJSON |
| **B — per-watcher control socket** | `~/.cards/watchers/{sha256(watcherId)[0:16]}.sock`, remapped by [socketEndpoint()](./public/packages/sdk/src/config/watcher/socketEndpoint.ts#L32) on Windows | [WatcherRegistry](./packages/extension/src/runtime/WatcherRegistry.ts#L225) | [dialWatcherSocket()](./public/packages/sdk/src/config/watcher/createWatcher.ts#L59) from the detached [stream-sync-watcher](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L420) | NDJSON |
| **C — action execution relay** | `ws://127.0.0.1:{port}/events` | [WebSocketServer](./packages/cards/server/src/websocket/WebSocketServer.ts#L131) | [cardsApiLifecycle](./packages/extension/src/lifecycle/cardsApiLifecycle.ts#L3862) | JSON over WS |

Channel C is already a WebSocket, but it is in scope: its three control messages carry no execution identity, no ownership generation, and no durability, so they are re-specified here rather than left alone.

## Channel A — per-action control socket

### Dispatcher side

[ActionDispatcher](./packages/extension/src/runtime/ActionDispatcher.ts) is the listener and the sole authority for an action's runtime state.

| Concern | Location | Replaced by |
| --- | --- | --- |
| Socket creation, awaits `listening` before returning | [createActionSocket()](./packages/extension/src/runtime/ActionDispatcher.ts#L856) | authenticated runtime connection |
| Startup GC of orphaned socket files | [cleanupStaleSockets()](./packages/extension/src/runtime/ActionDispatcher.ts#L809), called from [cardsApiLifecycle](./packages/extension/src/lifecycle/cardsApiLifecycle.ts#L300) | removed; no filesystem endpoint to orphan |
| Outbound NDJSON write to every tracked connection | [sendSocketCommand()](./packages/extension/src/runtime/ActionDispatcher.ts#L917) | `execution.*Command` durable intents |
| Inbound message switch | [handleSocketMessage()](./packages/extension/src/runtime/ActionDispatcher.ts#L1040) | `authorizeMessage()` plus per-class evaluation |
| Agent-shutdown forwarding gated on capability | [_forwardAgentShutdown()](./packages/extension/src/runtime/ActionDispatcher.ts#L936) | `execution.agentShutdownCommand`, guarded by `fresh-strict-drain-with-barrier` |
| Socket teardown deferred 30s so a late `cleanupComplete` still lands | [ActionDispatcher.ts#L791](./packages/extension/src/runtime/ActionDispatcher.ts#L791), [cleanupSocket()](./packages/extension/src/runtime/ActionDispatcher.ts#L1615) | subsumed by durable-result retention |
| `SOCKET_PATH` injection into the action environment | [buildEnv()](./packages/extension/src/runtime/ActionDispatcher.ts#L1768) | stable identity plus credential reference, never an endpoint address |
| Socket rewritten on switch-to-interactive relaunch | [ActionDispatcher.ts#L1289](./packages/extension/src/runtime/ActionDispatcher.ts#L1289) | preallocated successor identity |

### Message catalogue and its consumers

Dispatcher to client, typed as [SocketCommand](./public/packages/sdk/src/config/socket-client.ts#L31):

| Message | Consumer | Effect | New type | Class |
| --- | --- | --- | --- | --- |
| `cancel` | [handleCancelCommand()](./public/packages/sdk/src/config/runtime.ts#L400) | invokes `onCancel`, else self-`SIGTERM` | `execution.cancelCommand` | durable intent |
| `switchToInteractive` | [handleSwitchToInteractiveCommand()](./public/packages/sdk/src/config/runtime.ts#L452) | replies, exits 42 | `execution.switchToInteractiveCommand` | durable intent |
| `agentShutdown` | [handleAgentShutdownCommand()](./public/packages/sdk/src/config/runtime.ts#L502) | invokes `onAgentShutdown` | `execution.agentShutdownCommand` | durable intent |

Client to dispatcher:

| Message | Producer | Consumer | New type | Class |
| --- | --- | --- | --- | --- |
| `log` | [logViaSocket()](./packages/cards/server/src/runtime/wrapper.ts#L118) | [ActionDispatcher.ts#L1050](./packages/extension/src/runtime/ActionDispatcher.ts#L1050); first error or fatal becomes `runtimeFailure` | `runtime.log` | disposable telemetry |
| `switchToInteractiveResponse` | [runtime.ts#L470](./public/packages/sdk/src/config/runtime.ts#L470) | [ActionDispatcher.ts#L1041](./packages/extension/src/runtime/ActionDispatcher.ts#L1041) | `execution.interactiveHandoff` | durable intent |
| `cleanupComplete` | [sendCleanupComplete()](./packages/cards/server/src/runtime/wrapper.ts#L264) | [ActionDispatcher.ts#L1043](./packages/extension/src/runtime/ActionDispatcher.ts#L1043); authoritative terminal boundary | `execution.cleanupComplete` | durable result |
| `capabilities` | [advertiseCapabilities()](./public/packages/sdk/src/config/runtime.ts#L270) | [ActionDispatcher.ts#L1089](./packages/extension/src/runtime/ActionDispatcher.ts#L1089) | `runtime.capabilities` | reconciled snapshot |
| `shutdownRequest` | [runShutdownVerb()](./public/packages/sdk/src/bin/cards.ts#L1219) | [ActionDispatcher.ts#L1111](./packages/extension/src/runtime/ActionDispatcher.ts#L1111); dedupes, arms a 30s readiness timer | `execution.shutdownRequest` | durable intent |
| `shutdownReady` | [sendShutdownReady()](./public/packages/sdk/src/config/shutdown.ts#L86) | [ActionDispatcher.ts#L1160](./packages/extension/src/runtime/ActionDispatcher.ts#L1160) | `execution.shutdownReadiness` | revocable readiness |
| `agentTermination` | [runtime.ts#L525](./public/packages/sdk/src/config/runtime.ts#L525) | [ActionDispatcher.ts#L1175](./packages/extension/src/runtime/ActionDispatcher.ts#L1175) | `execution.agentTermination` | durable result |

Two defects in this catalogue are fixed by construction in the new contract. `shutdownReady` is declared in [shutdown.ts](./public/packages/sdk/src/config/shutdown.ts#L22) but is absent from the [SocketResponse](./public/packages/sdk/src/config/socket-client.ts#L77) union, so the dispatcher handles a message its own types say cannot arrive; and the 30-second readiness timer is a force-forward path that the plan removes outright.

### Durable handoff record and its readers

[PendingShutdownRequest](./public/packages/sdk/src/config/shutdown.ts#L15) persists `{version, requestId, socketPath}` to `~/.cards/card-repo-commits/{sessionId}.shutdown-request.json` via [writePendingShutdownRequest()](./public/packages/sdk/src/config/shutdown.ts#L39), and is read back by hand-rolled checks in [readPendingShutdownRequest()](./public/packages/sdk/src/config/shutdown.ts#L54). Every agent stop hook reads it and dials the address it contains:

- [shared Claude drain](./public/packages/agent-hooks/src/shared/shutdown-drain.ts#L66)
- [Codex stop-exit-when-done](./public/packages/agent-hooks/src/codex/runtime/stop-exit-when-done.ts#L50)
- [Antigravity handlers](./public/packages/agent-hooks/src/antigravity/internal/handlers.ts#L566), injected through [deps.ts](./public/packages/agent-hooks/src/antigravity/internal/deps.ts#L134)
- [OpenCode termination](./public/packages/default-configuration/src/lib/opencode-termination.ts#L9)

The dependency-injection interface at [deps.ts#L134](./public/packages/agent-hooks/src/antigravity/internal/deps.ts#L134) is the seam a protocol client must satisfy. Persisting `socketPath` is exactly the transient endpoint address the plan forbids; the record must carry stable identity and a credential reference instead.

### Wrapper

[wrapper.ts](./packages/cards/server/src/runtime/wrapper.ts) connects fail-closed on first log ([connectLogSocket()](./packages/cards/server/src/runtime/wrapper.ts#L95)), requires `SOCKET_PATH` among its [REQUIRED_ENV_VARS](./packages/cards/server/src/runtime/wrapper.ts#L138), spawns detached cleanup from [runPostExitCleanup()](./packages/cards/server/src/runtime/wrapper.ts#L379), and sends `cleanupComplete` over a **second, separate connection** from [runDetachedCleanup()](./packages/cards/server/src/runtime/wrapper.ts#L400) after the first has closed. Any connection-scoped session model must accommodate reconnect-then-single-message; the new contract does so by scoping identity to the execution rather than the connection.

## Channel B — per-watcher control socket

Wire types live in [watcher/protocol.ts](./public/packages/sdk/src/config/watcher/protocol.ts): watcher-to-server `hello`, `event`, `log`, `stop-ack`; server-to-watcher `hello-ack`, `control`.

| Concern | Location | New type |
| --- | --- | --- |
| Registration, takeover, per-watcher `net.Server` | [WatcherRegistry.register()](./packages/extension/src/runtime/WatcherRegistry.ts#L225) | `runtime.register` |
| Stop delivery | [WatcherRegistry.send()](./packages/extension/src/runtime/WatcherRegistry.ts#L280) | `watcher.stopCommand` |
| Stop acknowledgment | [_routeMessage()](./packages/extension/src/runtime/WatcherRegistry.ts#L506) | `watcher.stopResult` |
| Takeover stop with 3s wait | [_stopForTakeover()](./packages/extension/src/runtime/WatcherRegistry.ts#L541) | ownership generation fence |
| Orphan probe and unlink | [probeAndClean()](./packages/extension/src/runtime/WatcherRegistry.ts#L629) | removed |
| HTTP registration returning a socket path | [POST /internal/watchers](./packages/cards/server/src/api/Router.ts#L2542) | removed; address never leaves the server |
| Lookup and card-scoped stop | [Router.ts#L2586](./packages/cards/server/src/api/Router.ts#L2586), [Router.ts#L2606](./packages/cards/server/src/api/Router.ts#L2606) | `watcher.stopRequest` |
| Registry-to-stream bridging | [CardsServer.ts#L503](./packages/cards/server/src/server/CardsServer.ts#L503) | unchanged consumer, new event source |
| Client dial and handshake | [dialWatcherSocket()](./public/packages/sdk/src/config/watcher/createWatcher.ts#L59) | authenticated handshake |
| Capped jittered reconnect, 1s to 60s | [reconnectingWatcher.ts#L37](./public/packages/sdk/src/config/watcher/reconnectingWatcher.ts#L37) | retained as the protocol default |

### Watcher events classified by actual consumer

Produced by [stream-sync-watcher](./public/packages/sdk/src/bin/stream-sync-watcher.ts). Every one of them terminates at [WatcherHealthTracker](./packages/extension/src/runtime/WatcherHealthTracker.ts), which drives a health indicator broadcast from [extension.ts#L1262](./packages/extension/src/extension.ts#L1262). None advances durable state, so all three are **disposable telemetry** — the "explicitly classified watcher telemetry" the plan's delivery table calls for.

| Event | Produced at | Consumer | What it does | Class |
| --- | --- | --- | --- | --- |
| `watching` | [L237](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L237), [L342](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L342) | [WatcherHealthTracker.ts#L137](./packages/extension/src/runtime/WatcherHealthTracker.ts#L137) | stamps `lastHeartbeatAt`, status `streaming` | disposable telemetry |
| `status` | [L360](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L360) | [WatcherHealthTracker.ts#L148](./packages/extension/src/runtime/WatcherHealthTracker.ts#L148) | per-file health; any failure marks `broken` | disposable telemetry |
| `error` | [L155](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L155), [L366](./public/packages/sdk/src/bin/stream-sync-watcher.ts#L366) | [WatcherHealthTracker.ts#L163](./packages/extension/src/runtime/WatcherHealthTracker.ts#L163) | status `broken` with reason | disposable telemetry |
| unknown types | — | [WatcherHealthTracker.ts#L168](./packages/extension/src/runtime/WatcherHealthTracker.ts#L168) | forward-compatible no-op | — |
| `log` frames | [reconnectingWatcher.ts#L93](./public/packages/sdk/src/config/watcher/reconnectingWatcher.ts#L93) | [WatcherRegistry.ts#L513](./packages/extension/src/runtime/WatcherRegistry.ts#L513) fires `onLog`, **which nothing subscribes to** | disposable telemetry |

Two surfaces here are dead and should be removed rather than migrated: `WatcherEvents.onLog` has no subscriber, and [DELETE /internal/cards/:cardId/watchers](./packages/cards/server/src/api/Router.ts#L2606) has no product caller, only [watchers.test.ts#L274](./packages/cards/server/test/api/watchers.test.ts#L274).

## Channel C — `action:*` over WebSocket

| Message | Producer | Consumer | New type | Class |
| --- | --- | --- | --- | --- |
| `action:executorRegister` | [cardsApiLifecycle.ts#L3862](./packages/extension/src/lifecycle/cardsApiLifecycle.ts#L3862) | [WebSocketServer.ts#L139](./packages/cards/server/src/websocket/WebSocketServer.ts#L139), settle-on-replace at [Router.ts#L570](./packages/cards/server/src/api/Router.ts#L570) | `runtime.register` | reconciled snapshot |
| `action:executeRequest` | [Router.ts#L2024](./packages/cards/server/src/api/Router.ts#L2024) | [cardsApiLifecycle.ts#L4045](./packages/extension/src/lifecycle/cardsApiLifecycle.ts#L4045) | `execution.executeRequest` | durable intent |
| `action:executeResult` | [cardsApiLifecycle.ts#L4073](./packages/extension/src/lifecycle/cardsApiLifecycle.ts#L4073) | [Router.ts#L570](./packages/cards/server/src/api/Router.ts#L570) | `execution.launchOutcome` | durable result |

The 5-minute `ACTION_TIMEOUT_MS` at [Router.ts#L2010](./packages/cards/server/src/api/Router.ts#L2010) and the settle-on-disconnect path are both force-forward behaviors: an executor disconnecting settles a pending action as failed even though the harness may still be running. Under the new contract a disconnect changes only connection state.

A same-named webview message at [CardsDetailPanelProvider.ts#L1833](./packages/extension/src/providers/CardsDetailPanelProvider.ts#L1833) is unrelated `postMessage` traffic and is **not** in scope.

## Environment contract

Declared in [CARDS_ENV_VARS](./public/packages/sdk/src/config/env.ts#L33).

| Variable | Producer | Consumers | Disposition |
| --- | --- | --- | --- |
| `SOCKET_PATH` | [buildEnv()](./packages/extension/src/runtime/ActionDispatcher.ts#L1807), rewritten at [L1289](./packages/extension/src/runtime/ActionDispatcher.ts#L1289) | [wrapper.ts#L145](./packages/cards/server/src/runtime/wrapper.ts#L145), [runtime.ts#L247](./public/packages/sdk/src/config/runtime.ts#L245), [cards.ts#L1234](./public/packages/sdk/src/bin/cards.ts#L1234) | **removed** |
| `getSocketPath()` | [env.ts#L449](./public/packages/sdk/src/config/env.ts#L449) | [cards.ts](./public/packages/sdk/src/bin/cards.ts#L1234) | **removed** |
| `SWITCH_TO_INTERACTIVE_DATA_PATH` | dispatcher relaunch | [wrapper.ts#L152](./packages/cards/server/src/runtime/wrapper.ts#L152) | replaced by the handoff continuation payload |
| `CARD_ID`, `ENVIRONMENT`, `EXECUTION_MODE`, `EXIT_WHEN_DONE`, `CARD_REPO_PATH`, `REPO_ROOT`, `WORKSPACE_PATH` | [buildEnv()](./packages/extension/src/runtime/ActionDispatcher.ts#L1798) | [REQUIRED_ENV_VARS](./packages/cards/server/src/runtime/wrapper.ts#L138) | retained; become envelope scope |
| `CARDS_SESSION_ID` and the per-agent session variables | agent runtimes | [cards.ts#L1241](./public/packages/sdk/src/bin/cards.ts#L1241) | retained for correlation |

Channel B has **no** environment contract at all: its address is discovered at runtime through `discoverApiInfo()` plus the HTTP registration call.

## Generated hook bundles

No generated bundle embeds a socket or pipe path. Both discovery mechanisms are indirect, and both are in scope:

- Channel A bundles read the address out of the durable record via [readPendingShutdownRequest()](./public/packages/sdk/src/config/shutdown.ts#L54).
- Channel B is spawned by [spawn-stream-sync-watcher](./public/packages/sdk/src/bin/spawn-stream-sync-watcher.ts) with only a serialized manifest in `argv[2]`; the watcher then discovers its address from the HTTP registration. Callers: [shared/spawn-watcher.ts#L15](./public/packages/agent-hooks/src/shared/spawn-watcher.ts#L15), [antigravity/deps.ts#L27](./public/packages/agent-hooks/src/antigravity/internal/deps.ts#L27), [opencode/deps.ts#L18](./public/packages/agent-hooks/src/opencode/internal/deps.ts#L18), [codex/session-start.ts#L29](./public/packages/agent-hooks/src/codex/runtime/session-start.ts#L29).
- Bundle plumbing that must keep working: [esm-require-bridge.mjs](./public/packages/agent-hooks/scripts/esm-require-bridge.mjs).

## Exports

- [sdk/package.json](./public/packages/sdk/package.json) exports the Channel A wire contract directly as `./config/socket-client`.
- [config/index.ts](./public/packages/sdk/src/config/index.ts#L107) re-exports the shutdown record helpers, the [ipc-endpoint](./public/packages/sdk/src/config/ipc-endpoint.ts#L39) helpers, and the entire watcher surface from [watcher/index.ts](./public/packages/sdk/src/config/watcher/index.ts).
- `SocketClient`, `SocketCommand`, and `SocketResponse` are **not** re-exported from the config barrel; consumers import the subpath directly, including [ActionDispatcher.ts#L46](./packages/extension/src/runtime/ActionDispatcher.ts#L46).
- [ipc-endpoint.ts](./public/packages/sdk/src/config/ipc-endpoint.ts) is the declared portability layer, but production bypasses it entirely: [createActionSocket()](./packages/extension/src/runtime/ActionDispatcher.ts#L862) and [socketEndpoint()](./public/packages/sdk/src/config/watcher/socketEndpoint.ts#L32) each hand-roll their own Windows branch, giving three incompatible naming schemes. It survives only in tests.

## Tests

| Area | Files |
| --- | --- |
| Wrapper over a real socket | [wrapper-log-file.test.ts](./packages/cards/server/test/runtime/wrapper-log-file.test.ts), [wrapper-detached-cleanup.test.ts](./packages/cards/server/test/runtime/wrapper-detached-cleanup.test.ts), [wrapper-sighup-cleanup.test.ts](./packages/cards/server/test/runtime/wrapper-sighup-cleanup.test.ts), [wrapper-sighup-pipe-fd.test.ts](./packages/cards/server/test/runtime/wrapper-sighup-pipe-fd.test.ts), [wrapper-sigterm-exit-code.test.ts](./packages/cards/server/test/runtime/wrapper-sigterm-exit-code.test.ts) |
| Watcher REST surface | [watchers.test.ts](./packages/cards/server/test/api/watchers.test.ts) |
| Channel C relay | [WebSocketServer.test.ts#L313](./packages/cards/server/test/websocket/WebSocketServer.test.ts#L313), [Router.test.ts#L3149](./packages/cards/server/test/api/Router.test.ts#L3149) |
| Watcher registry, real sockets | [WatcherRegistry.test.ts](./packages/extension/src/runtime/WatcherRegistry.test.ts) and its concurrent-register, listen-error, unlink, takeover, and teardown-hang siblings |
| Dispatcher | [ActionDispatcher.test.ts](./packages/extension/src/runtime/ActionDispatcher.test.ts), [test/suite/runtime/ActionDispatcher.test.ts](./packages/extension/test/suite/runtime/ActionDispatcher.test.ts) |
| SDK client and CLI | [socket-client.test.ts](./public/packages/sdk/test/configuration/socket-client.test.ts), [runtime.test.ts](./public/packages/sdk/test/configuration/runtime.test.ts), [cards-shutdown.test.ts](./public/packages/sdk/test/bin/cards-shutdown.test.ts), [reconnectingWatcher.test.ts](./public/packages/sdk/test/config/watcher/reconnectingWatcher.test.ts) |
| Agent hooks | [session-start.test.ts](./public/packages/agent-hooks/test/claude/runtime/session-start.test.ts) and the compiled-bundle suites |

Per the plan these are replaced rather than deleted: each asserts behavior that must survive the transport change.

## Documentation

`wiki/architecture/shutdown-mechanism.md` is the canonical Channel A specification and links directly into `socket-client.ts` line numbers. Also affected: `wiki/reference/cli/stream-sync-watcher.md`, `wiki/architecture/streams.md`, `wiki/reference/environment-variables.md` (the `SOCKET_PATH` row), `wiki/reference/cli/cards.md`, `wiki/reference/external-cli-interfaces.md`, and the failure-state pages for configuration watcher registration, extension runtime and lifecycle, agent hooks and session state, and default configuration.

Shipped skill and plugin documentation carries a socket-path table that exists in five generated copies which must be regenerated together: `public/skills-src/cards/debug/references/platform-reference.md` and its copies under `public/{claude,codex,antigravity,opencode}/`, plus `public/{claude,codex,antigravity}/cards-sdk/skills/sdk/reference/environment.md`.

## Metadata and status writers

The plan requires every authoritative card metadata writer to participate in one conditional mutation contract. Inventoried for the mutation-contract worker rather than migrated here:

- launch activation and user or API metadata updates
- [settleCardStatusForCleanup()](./public/packages/default-configuration/src/lib/claude-session.ts#L876) in all four launchers
- [SDK transition and failure rollback](./public/packages/sdk/src/bin/process-utils.ts#L295-L348)
- [API-independent wrapper cleanup](./packages/cards/server/src/runtime/wrapper.ts#L200)
- server recovered completion
- the held-lock and commit deadlock warning at [HybridStore.ts#L1106-L1110](./packages/cards/hybrid-store/src/store/HybridStore.ts#L1106-L1110), which constrains the mechanism

## Preserved behavior

Behavior the migration must keep, drawn from the card's integration note:

- **Strict drain**, with a barrier held against new work through termination. The transition table admits `draining` to `terminating` only under `fresh-strict-drain-with-barrier`.
- **First-turn idle readiness**, including a session that reports readiness before any turn completes.
- **Pending shutdown when `EXIT_WHEN_DONE` is false**: the intent is retained independently of readiness validity.
- **Watcher replacement semantics**, with delayed stop requests fenced rather than applied to the successor.
- **Capped jittered reconnect** from 1s to 60s, which is already the watcher default.
- Removed deliberately: the 30-second readiness force-forward at [ActionDispatcher.ts#L77](./packages/extension/src/runtime/ActionDispatcher.ts#L77) and the executor-disconnect settle at [Router.ts#L570](./packages/cards/server/src/api/Router.ts#L570). Deadlines report pending or error; they never authorize termination.
