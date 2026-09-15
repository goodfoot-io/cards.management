/**
 * Standalone fake runtime server for the compiled-bundle lifecycle tests.
 *
 * It runs as its own process (not inside the vitest worker): the tests drive
 * the bundle with `spawnSync`, which blocks the calling thread's event loop,
 * and a server living on that same thread could never `accept()` the bundle's
 * connection — the test would deadlock against itself.
 *
 * The server echoes the registering client's scope, ownership, and execution
 * back into every acknowledgment envelope so the client's own authorization
 * accepts the frames, and it grants every work admission: the flow under test
 * is "admission succeeded, then what does the process do".
 *
 * @summary Standalone loopback runtime-protocol server for bundle tests
 */

import { WebSocketServer } from 'ws';

const requestedPort = Number(process.argv[2] ?? 0);
const server = new WebSocketServer({ port: requestedPort, host: '127.0.0.1' });
const registered = new Map();

server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (envelope.type === 'runtime.register' || envelope.type === 'runtime.resume') {
      registered.set(socket, envelope);
      socket.send(JSON.stringify({ status: 'registered', generation: 1, fencedGeneration: null }));
      return;
    }
    const opening = registered.get(socket);
    if (opening === undefined) return;
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: `server-ack-${envelope.messageId}`,
        causationId: `caused-by-${envelope.messageId}`,
        sentAt: new Date().toISOString(),
        execution: envelope.execution,
        scope: envelope.scope,
        producer: { producerId: 'fake-runtime-server', role: 'server' },
        ownership: envelope.ownership,
        type: 'runtime.accepted',
        payload: {
          acknowledgedMessageId: envelope.messageId,
          acknowledgedAt: new Date().toISOString(),
          workAdmission: { status: 'admitted', workRevision: 1 }
        }
      })
    );
  });
});

server.on('listening', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
