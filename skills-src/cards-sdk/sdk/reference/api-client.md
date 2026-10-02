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
| Branches | `getBranches`, `addBranch`, `removeBranch`, `previewWorktreeCleanup`, `cleanupWorktrees` |
| Streams | `listStreams`, `getStream` |
| Workspace | `getTags`, `getEnvironments`, `getTimeline`, `executeAction` |
| Compare | `setCompare`, `getCompare`, `clearCompare` |

[Branch registration](./public/packages/sdk/src/protocol/types/branch.ts#L1) contains `name`, `parentBranch`, `addedAt` and optional absolute `worktree`; [getBranches](./public/packages/sdk/src/client/cardsClient.ts#L785) returns malformed registrations separately in `invalidEntries`. There are no revision or owner tokens.

[addBranch](./public/packages/sdk/src/client/cardsClient.ts#L800) and [removeBranch](./public/packages/sdk/src/client/cardsClient.ts#L822) manage ordinary branches. They reject every reserved `cards/<cardId>/<positive integer>` slot, including another card's slots and large decimal ordinals. An admitted action obtains `{branch, worktreePath}` from [context.assignWorktree()](./public/packages/sdk/src/config/inputs.ts#L179); use that authenticated path rather than creating a slot locally. The API owner records assignments durably and cleans eligible checkout content after terminal transitions.

[previewWorktreeCleanup](./public/packages/sdk/src/client/cardsClient.ts#L836) reports each slot's safety decision without mutation. [cleanupWorktrees](./public/packages/sdk/src/client/cardsClient.ts#L846) runs authenticated requesterless cleanup: it spares no warm or open-editor slot, but preserves running, dirty, unmerged, invalid or unusable checkouts. Inspect its returned decisions. Card deletion uses the same checks and keeps the card if any registration cannot be removed.

Non-async accessors: `updateAccessToken(token)`, `getBaseUrl()`, `hasHttpClient()`.

`listStreams(cardId)` returns `StreamMeta[]` — the same shape renderers receive; see [streams.md](streams.md).

</instructions>
