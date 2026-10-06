<instructions>

Programmatic access to the Cards API from a handler, via `@cards.management/sdk/client/discovery`.

## Creating a Client

`createCardsClient(logger?, options?)` discovers the running server, then returns a configured `CardsClient` — or `null` when discovery fails. Always branch on `null`; a handler must not assume the API is reachable.

```typescript
import { createCardsClient } from '@cards.management/sdk/client/discovery';

async (input, { logger }) => {
  const client = await createCardsClient(logger);

  if (!client) {
    logger.warn('Cards API not available');
    return;
  }

  const card = await client.getCard(input.cardId);
}
```

`options` is merged over the discovered `baseUrl`/`accessToken`. Short-lived callers should pass `{ retryOnNetworkError: false }` so an unreachable server raises `NetworkError` promptly instead of retrying:

```typescript
const client = await createCardsClient(logger, { retryOnNetworkError: false });
```

`discoverApiInfo(logger?)` is exported from the same subpath when you need the raw host/port/token rather than a client.

## Client Methods

All are `async` and throw on HTTP failure.

| Group | Methods |
|-------|---------|
| Cards | `listCards`, `listCardSummaries`, `getCard`, `createCard`, `updateCard`, `deleteCard` |
| Attachments | `uploadAttachment`, `getAttachment`, `listAttachments` |
| Files & gates | `putFile`, `approveGate` (`'plan' \| 'mergeRequest'`) |
| Branches | `getBranches`, `addBranch`, `removeBranch` |
| Root commands | `runRootCommand`, `getExecutionStatus` |
| Streams | `listStreams`, `getStream` |
| Workspace | `getTags`, `getEnvironments`, `getTimeline`, `executeAction` |
| Compare | `setCompare`, `getCompare`, `clearCompare` |

[Branch registration](./public/packages/sdk/src/protocol/types/branch.ts#L1) contains `name`, `parentBranch`, `addedAt` and optional absolute `worktree`; [getBranches](./public/packages/sdk/src/client/cardsClient.ts#L868) returns malformed registrations separately in `invalidEntries`. There are no revision or owner tokens. An entry a build before slot locks committed with an owner carries [legacyExecutionOwner](./public/packages/sdk/src/protocol/types/branch.ts#L125); treat that slot as held while the execution reads `running`.

[addBranch](./public/packages/sdk/src/client/cardsClient.ts#L875) and [removeBranch](./public/packages/sdk/src/client/cardsClient.ts#L897) register and unregister any branch, worktree slots `cards/<cardId>/<n>` included. The server keeps no worktree state: the configuration owns its card's slots, takes their locks and registers them through these same calls.

## Root Commands

[runRootCommand(cardId, 'worktreeMaintenance', { mode }, options?)](./public/packages/sdk/src/client/cardsClient.ts#L927) launches the configuration's root command on a card and waits for its report. `mode` is `preview` (reads only), `cleanup` (removes eligible slots) or `prepare-delete` (removes eligible slots and requires that none remain). It posts the launch to `POST /cards/:cardId/runtime/commands`, polls the durable retrieval every 250 ms with each request capped at 10 s, and resolves `{ requestId, executionId, report }` only when the command completed with a report. `report` is opaque to the client: parse it against the command's own contract, for `worktreeMaintenance` a [WorktreeCleanupPreview](./public/packages/sdk/src/protocol/types/worktree-slots.ts#L73) of `{ cardId, canDeleteCard, decisions, unknownLocks, processesNotInspected, failure? }`, which [worktreeCleanupPreviewSchema](./public/packages/sdk/src/protocol/types/worktree-slots.ts#L160) validates.

`options.timeoutMs` (default 300 000) bounds the whole wait and `options.signal` aborts it; either one posts `.../runtime/commands/:requestId/cancel` before throwing, so an abandoned wait never leaves the command running unobserved. Every other end throws [RootCommandError](./public/packages/sdk/src/client/types/errors.ts#L216) with a `cause`:

| Cause | Meaning |
|-------|---------|
| `unconfigured` | 409 `command_unconfigured`: the configuration defines no `worktreeMaintenance` |
| `rejected` | Launch or admission refused, including 409 `card_deleting`, any other 409, and 400/401/403/503 |
| `uncertain` | The launch or its durable record cannot be confirmed |
| `unavailable` | No response, or only 5xx, for 30 s or until the deadline; the message names the server and the last failure. Attempts back off from 500 ms to 4 s |
| `card_not_found` | 404 `card_not_found`: the server has no such card |
| `workspace_not_found` | 404 `workspace_not_found`: the repository has no workspace |
| `invalid_response` | A body outside the contract, an untyped 404 included; the command was cancelled |
| `no_report` | The command completed without a report |
| `timeout` | The deadline passed; the command was cancelled |
| `cancelled` | `signal` aborted; the command was cancelled |

On the server, [`POST /cards/:cardId/runtime/commands`](./packages/cards/server/src/api/Router.ts#L2218-L2244) takes `{ requestId, messageId, command, input }`. It answers:

| Status | When |
|--------|------|
| 400 | Malformed body |
| 404 `card_not_found` / `workspace_not_found` | No such card, or no workspace for the repository |
| 401 | No runtime principal resolves for the card |
| 503 | No runtime owner has bound the command routes |
| 409 `command_unconfigured` | The configuration does not define `command`; refused before admission |
| Otherwise | The action launch route's admission result, including 409 `card_deleting` |

[`POST /cards/:cardId/runtime/commands/:requestId/cancel`](./packages/cards/server/src/api/Router.ts#L2246-L2270) answers 202 `cancel-requested`, 200 `not-running`, 404 when the card scope or the request is unknown, 401, or 503. The outcome is read under the same `requestId` through [`GET /cards/:cardId/runtime/actions/:requestId`](./packages/cards/server/src/api/Router.ts#L2196-L2216). The generic `POST /cards/:cardId/runtime/actions` route [refuses root-command params](./packages/cards/server/src/api/Router.ts#L113-L121) with 400, so `runRootCommand` is the only way to launch one.

[getExecutionStatus(executionId)](./public/packages/sdk/src/client/cardsClient.ts#L1131) reads `GET /runtime/executions/:executionId/status` and returns `running`, `terminal` or `unknown`. `unknown` means the server holds no record, which for an execution that once spawned means it settled long ago.

## Deleting a Card

The server does not clean up worktrees. [deleteCard](./public/packages/sdk/src/client/cardsClient.ts#L706) must follow a passing `prepare-delete`:

```typescript
import type { WorktreeCleanupPreview } from '@cards.management/sdk/protocol';

const { requestId, report } = await client.runRootCommand(cardId, 'worktreeMaintenance', { mode: 'prepare-delete' });
const preview = report as unknown as WorktreeCleanupPreview; // validate before trusting it
if (!preview.canDeleteCard) {
  // Show preview.decisions: each preserved or failed slot names its reason and detail.
  return;
}
await client.deleteCard(cardId, { preparedBy: requestId });
```

`canDeleteCard` is true only when every slot's outcome is `removed` or `eligible` (nothing left to remove) and the pass hit no failure. Only a process whose working directory, root or an open file is proven inside a slot keeps it as `in_use`; a process the occupant probe could not inspect, whoever owns it, never blocks removal. `processesNotInspected` is the largest such count any of the pass's probes saw, for logs and report data only: it plays no part in `canDeleteCard` and is not meant for display. [deleteCard(cardId, { preparedBy? })](./public/packages/sdk/src/client/cardsClient.ts#L706) sends `DELETE /cards/:cardId?preparedBy=<requestId>`, citing the prepare-delete run so the server can tell whether the card changed since. The server refuses with a [CardDeleteRefusedError](./public/packages/sdk/src/client/types/errors.ts#L71), an `ApiError` whose `code` and `executions` say why:

| Status | `code` | `executions` |
|--------|--------|--------------|
| 409 | `running_execution` | Executions still running on the card; stop them first |
| 409 | `card_changed` | Executions that changed the card after the cited run; run prepare-delete again |
| 400 | `invalid_prepared_by` | Empty: `preparedBy` names no prepare-delete run of this card the server accepts |

A body whose `executions` does not fit that table stays a plain `ApiError`. A 503 means runtime admission is unavailable. None of these deletes anything.

Non-async accessors: `updateAccessToken(token)`, `getBaseUrl()`, `hasHttpClient()`.

`listStreams(cardId)` returns `StreamMeta[]` — the same shape renderers receive; see [streams.md](streams.md).

</instructions>
