---
name: sdk
description: Build Cards Extension settings and stream renderers.
---

Type-safe action handlers for the Cards Extension via `@cards.management/sdk/config`.

## Build Process

Actions and stream renderer `www` directories are processed at build time. Rebuild after every change.

```bash
cards-sdk build -c settings.config.ts -o dist
```

**Parameters:**
- `-c, --config settings.config.ts`: Configuration file (TypeScript)
- `-o, --outdir dist`: Output directory containing `settings.json` and `bin/` folder
- `--loader .ext=type`: Register an esbuild loader for non-code imports (repeatable, e.g. `--loader .md=text`)

## Action Handler Example

```typescript
// src/actions/launch-claude.ts
import { defineAction } from '@cards.management/sdk/config';

export default defineAction(
  {
    actionName: 'Launch Claude',
    description: 'Start a Claude coding session',
    icon: './icons/claude.svg',
    supportsBackgroundMode: true
  },
  async (input, context) => {
    const { logger, onCancel, onSwitchToInteractive } = context;

    logger.info('Launching Claude', { action: input.actionName, cardId: input.cardId });

    onCancel(() => {
      logger.info('Action cancelled by user');
    });

    onSwitchToInteractive(() => {
      logger.info('Switching to interactive mode');
      return { cardId: input.cardId };
    });
  }
);
```

## Cards Assistant Handler Example

The cards assistant is a single, workspace-scoped handler created with `defineCardsAssistant`. It has no card context (no `cardId`, worktree, or socket) and takes an empty `{}` config.

```typescript
// src/cards-assistant.ts
import { defineCardsAssistant } from '@cards.management/sdk/config';

export default defineCardsAssistant(
  {},
  async (input, { logger, cwd }) => {
    logger.info('Launching cards assistant', { marketplacePath: input.marketplacePath });
  }
);
```

## Configuration File Structure

Define environments, actions, streams, and the optional cards assistant in `settings.config.ts`:

```typescript
import { defineConfig } from '@cards.management/sdk/config';
import launchClaude from './src/actions/launch-claude.js';
import cardsAssistant from './src/cards-assistant.js';

export default defineConfig({
  environments: {
    default: {
      version: 1,
      description: 'Default environment',
      actions: [launchClaude],
      streams: {
        'chat-log': {
          version: 1,
          wwwRoot: './src/streams/chat-log/www',
          maxLineLength: 1_048_576
        }
      }
    }
  },
  cardsAssistant
});
```

## Factory Functions Reference

| Factory | Purpose | Config Fields |
|---------|---------|---------------|
| `defineAction` | Per-card action handler | `actionName`, `id?`, `description?`, `icon?`, `supportsBackgroundMode?`, `timeout?` |
| `defineCardsAssistant` | Workspace-scoped assistant handler | _(none — pass an empty `{}` config)_ |

## Development Checklist

Before debugging issues, verify:

- [ ] `@cards.management/sdk/config` is in `package.json` dependencies
- [ ] Build script exists: `"build": "cards-sdk build -c settings.config.ts -o dist"`
- [ ] Handlers rebuilt after last code change (`yarn build`)
- [ ] Handler files use `export default factoryFunction(...)` pattern

## Additional Resources

- **[reference/input-types.md](reference/input-types.md)**: ActionInput, CardsAssistantInput, and context types
- **[reference/environment.md](reference/environment.md)**: CARDS_ENV_VARS, getters, and exit codes
- **[reference/api-client.md](reference/api-client.md)**: Cards API access — `createCardsClient` and the `CardsClient` methods
- **[reference/logging.md](reference/logging.md)**: Logger API and configuration
- **[reference/streams.md](reference/streams.md)**: Stream renderers — `www/` layout, `wwwRoot` and stream config fields, the stream-store SDK, and the renderer template
