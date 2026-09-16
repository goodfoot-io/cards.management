/**
 * Authenticated watcher channel over the shared runtime client.
 * @summary Reconnecting runtime watcher producer
 * @module
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGlobalCardsConfigDir } from '../../cards-config.js';
import { discoverApiInfo } from '../../client/api-discovery.js';
import {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential,
  type RuntimeClient
} from '../../client/runtime/index.js';
import { createFileClientOutbox, resolveOutboxRoot } from '../../client/runtime/outbox/index.js';
import type { RuntimeEnvelope, RuntimePayload } from '../../protocol/index.js';
import type { ILogger, LogLevel } from '../logger.js';
import { Logger } from '../logger.js';
import type { WatcherContext } from './context.js';
import { WatcherRegistrationError } from './errors.js';

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;

export interface ReconnectingWatcherHandle {
  ctx: WatcherContext;
  waitForStop(): Promise<void>;
  shutdown(): void;
}

/** Identity and diagnostic metadata for one admitted watcher producer. */
export interface WatcherRegistration {
  readonly watcherId: string;
  readonly cardId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

type StopClaim = 'claimed' | 'in-doubt' | 'completed' | 'conflict' | 'unavailable';

function stopCommandJournal(root: string, claimantId: string) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(root);
  if (status.isSymbolicLink() || (process.platform !== 'win32' && (status.mode & 0o077) !== 0))
    throw new Error('Watcher command journal must be owner-only');
  const fileFor = (id: string) => path.join(root, `${createHash('sha256').update(id).digest('hex')}.json`);
  const identity = (envelope: RuntimeEnvelope) => createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  const write = (file: string, value: unknown) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
    const directory = fs.openSync(root, 'r');
    fs.fsyncSync(directory);
    fs.closeSync(directory);
  };
  return {
    claim(envelope: RuntimeEnvelope): StopClaim {
      try {
        const file = fileFor(envelope.messageId);
        const fingerprint = identity(envelope);
        if (fs.existsSync(file)) {
          const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            fingerprint: string;
            state: 'claimed' | 'completed';
          };
          if (existing.fingerprint !== fingerprint) return 'conflict';
          return existing.state === 'completed' ? 'completed' : 'in-doubt';
        }
        write(file, { version: 1, fingerprint, envelope, state: 'claimed', claimantId });
        return 'claimed';
      } catch {
        return 'unavailable';
      }
    },
    complete(messageId: string): void {
      const file = fileFor(messageId);
      const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      write(file, { ...existing, state: 'completed' });
    }
  };
}

function telemetryPayload(
  watcherId: string,
  event: { type: string; data: unknown }
): RuntimePayload<'watcher.telemetry'> | null {
  if (event.type === 'watching') return { watcherId, event: { type: 'watching' } };
  if (event.type === 'status') {
    const data = event.data as { files?: unknown };
    if (!Array.isArray(data?.files)) return null;
    return { watcherId, event: { type: 'status', files: data.files as never } };
  }
  if (event.type === 'error') {
    const data = event.data as { message?: unknown; relPath?: unknown };
    if (typeof data?.message !== 'string') return null;
    return {
      watcherId,
      event: {
        type: 'error',
        message: data.message,
        ...(typeof data.relPath === 'string' ? { relPath: data.relPath } : {})
      }
    };
  }
  return null;
}

/**
 * Opens an authenticated watcher producer and keeps its runtime connection alive.
 * @param registration - Watcher identity whose card must match the protected credential.
 * @returns Stable context and lifecycle controls for the watcher process.
 */
export async function createReconnectingWatcher(registration: WatcherRegistration): Promise<ReconnectingWatcherHandle> {
  const loaded = loadRuntimeCredential('watcher');
  if (loaded.scope.cardId !== registration.cardId) {
    throw new WatcherRegistrationError('Watcher registration card does not match its admitted credential');
  }
  const outbox = createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) });
  const journal = stopCommandJournal(
    path.join(resolveGlobalCardsConfigDir(), 'runtime', 'watcher-commands', loaded.credential.producerId),
    loaded.credential.producerId
  );
  const logger = new Logger();
  let stopHandler: (() => Promise<void> | void) | undefined;
  let stopped = false;
  let resolveStop!: () => void;
  let rejectStop!: (error: unknown) => void;
  const stopPromise = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  let client: RuntimeClient;

  const send = async <T extends 'execution.commandCustody' | 'watcher.stopResult'>(
    type: T,
    payload: RuntimePayload<T>,
    messageId: string,
    causationId: string
  ): Promise<boolean> => {
    const result = await client.send({
      type,
      payload,
      messageId,
      requestId: loaded.credential.requestId,
      causationId,
      execution: type === 'watcher.stopResult' ? null : loaded.execution,
      deadlineMs: 5_000
    });
    return result.status === 'accepted';
  };

  const onMessage = async (message: RuntimeEnvelope): Promise<void> => {
    if (
      message.type !== 'watcher.stopCommand' ||
      !('watcherId' in message.payload) ||
      message.payload.watcherId !== registration.watcherId ||
      stopped
    )
      return;
    const claim = journal.claim(message);
    if (claim === 'conflict' || claim === 'unavailable') return;
    const custodyId = `${message.messageId}:watcher:custody`;
    if (
      !(await send('execution.commandCustody', { commandMessageId: message.messageId }, custodyId, message.messageId))
    )
      return;
    try {
      if (claim === 'claimed') await stopHandler?.();
      const resultId = `${message.messageId}:watcher:stop-result`;
      if (
        !(await send(
          'watcher.stopResult',
          { watcherId: registration.watcherId, disposition: 'stopped' },
          resultId,
          message.messageId
        ))
      )
        return;
      stopped = true;
      if (claim === 'claimed') journal.complete(message.messageId);
      await client.stop();
      resolveStop();
    } catch (error) {
      rejectStop(error);
    }
  };

  client = createRuntimeClientFromCredentialFile({
    role: 'watcher',
    capabilities: { switchToInteractive: false },
    outbox,
    discover: async () => {
      const info = await discoverApiInfo();
      return info ? { host: info.host, port: info.port, accessToken: info.accessToken } : null;
    },
    onMessage
  });
  const connected = await client.start();
  if (connected.status !== 'connected') {
    await client.stop();
    throw new WatcherRegistrationError(`Watcher runtime registration ${connected.status}`);
  }

  const sendTelemetry = (type: 'runtime.log' | 'watcher.telemetry', payload: unknown): void => {
    void client.send({
      type,
      payload: payload as never,
      messageId: randomUUID(),
      execution: type === 'watcher.telemetry' ? null : loaded.execution
    });
  };
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  for (const level of levels) {
    logger.on(level, (event) => sendTelemetry('runtime.log', { level: event.level, message: event.message }));
  }
  const ctx: WatcherContext = {
    logger: logger as ILogger,
    cwd: process.cwd(),
    emit(event) {
      const payload = telemetryPayload(registration.watcherId, event);
      if (payload) sendTelemetry('watcher.telemetry', payload);
    },
    onControl(_type, handler) {
      stopHandler = handler;
    }
  };
  return {
    ctx,
    waitForStop: () => stopPromise,
    shutdown() {
      stopped = true;
      void client.stop();
    }
  };
}
