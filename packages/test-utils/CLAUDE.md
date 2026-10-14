# @cards.management/test-utils

Shared test utilities for Issues V2 packages, plus the workspace's dev-loop freshness bin.

## Overview

This package provides consolidated test infrastructure:

- `TestIssueRepository` - Real Git repositories with issue layout for integration testing
- `TestWebSocketServer` - Real WebSocket server for testing event subscriptions
- Fixture factories for domain entities

It also hosts the workspace's dev-loop freshness bin (see `bin` in package.json):

- `build-unchanged` - skips a package build whose outputs are at least as new as its inputs, whose `--manifest` completion record still matches, and whose recorded source fingerprint equals the current inputs' contents (fail-closed mtime gate plus depfile-style completion manifest with input-content provenance binding)

## Usage Guidelines

### TestIssueRepository

Creates real Git repositories with proper card layout (CARD.md, comments/, attachments/).

```typescript
const repo = new TestIssueRepository();
const reposPath = await repo.create();
const issueId = await repo.createIssue({ title: 'Test Issue' });
// ... test code ...
repo.destroy(); // Always clean up
```

### TestWebSocketServer

Creates a real WebSocket server on a random port.

```typescript
const server = new TestWebSocketServer();
const port = await server.start();
// Connect clients to ws://localhost:${port}
await server.broadcast({ type: 'test', data: {} });
await server.stop();
```

### TestStreamTransformHarness

Test harness for stream transform execution. Wraps `StreamTransformWorkerPool` with a simplified API for testing transforms in isolated vm + worker_thread environments.

```typescript
const harness = new TestStreamTransformHarness();
await harness.start(`
  export function init(ctx) {
    ctx.state.set('prefix', '[INIT]');
  }

  export default function transform(line, ctx) {
    const prefix = ctx.state.get('prefix');
    return \`\${prefix} \${line}\`;
  }
`);

// Transform lines (lineNumber auto-increments)
const { result, error } = await harness.transform('test line');
expect(result).toBe('[INIT] test line');

// Capture console logs from transform execution
const logs = harness.getLogs();

// Check if harness is running
if (harness.isStarted) {
  await harness.stop();
}
```

**Key features:**
- Accepts inline transform code (no file I/O required)
- Automatic worker lifecycle management
- Console log capture via `getLogs()` / `clearLogs()`
- Auto-incrementing line numbers
- Fail-open semantics: errors return `{ result: originalLine, error: 'message' }`
- UUID-based stream isolation per harness instance

**Context factory helper:**
```typescript
import { createStreamInitContext } from '@cards.management/test-utils';

// Create context with defaults
const ctx = createStreamInitContext();

// Or with partial overrides
const ctx = createStreamInitContext({
  streamType: 'custom-stream',
  card: { id: 'my-card', metadata: { key: 'value' } }
});
```

## Test Guidelines

- Always use `afterEach` or `afterAll` to clean up test resources
- Use `os.tmpdir()` paths for cross-platform compatibility
- Prefer real implementations over mocks for accurate behavior verification
