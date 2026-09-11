/**
 * Protected runtime credential-file persistence and role-specific loading.
 * @summary Runtime credential-file handoff
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { getRuntimeCredentialFilePath } from '../../config/env.js';
import {
  type ChildRuntimeCredentialRole,
  type IssuedRoleCredential,
  type RuntimeCredentialFile,
  runtimeCredentialFileSchema
} from '../../protocol/types/index.js';
import { createRuntimeClient } from './client.js';
import { PRESERVE_FOR_SERVER_STARTUP_AUTHORITIES } from './preservation-authorities.js';
import type { RuntimeClient, RuntimeClientOptions } from './types.js';

function assertProtectedDirectory(path: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`Runtime credential directory is a symbolic link: ${path}`);
  if (!status.isDirectory()) throw new Error(`Runtime credential parent is not a directory: ${path}`);
  if (process.platform !== 'win32') {
    if ((status.mode & 0o077) !== 0)
      throw new Error(`Runtime credential directory permissions must be owner-only: ${path}`);
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error(`Runtime credential directory is not owned by the current user: ${path}`);
    }
  }
}

function assertProtectedFile(path: string, status: Stats): void {
  if (!status.isFile()) throw new Error(`Runtime credential path is not a regular file: ${path}`);
  if (process.platform !== 'win32') {
    if ((status.mode & 0o077) !== 0) throw new Error(`Runtime credential file permissions must be owner-only: ${path}`);
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error(`Runtime credential file is not owned by the current user: ${path}`);
    }
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupOwnedTemporary(path: string, identity: { readonly dev: number; readonly ino: number }): void {
  try {
    const current = lstatSync(path);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Credential and bound identity loaded for one explicit runtime producer role. */
export interface LoadedRuntimeCredential {
  readonly execution: RuntimeCredentialFile['execution'];
  readonly scope: RuntimeCredentialFile['scope'];
  readonly ownership: RuntimeCredentialFile['ownership'];
  readonly credential: IssuedRoleCredential;
}

/** Inputs retained from the caller when bootstrapping a runtime client from protected credentials. */
export interface RuntimeClientBootstrapOptions
  extends Omit<RuntimeClientOptions, 'identity' | 'credential' | 'authorities'> {
  readonly role: ChildRuntimeCredentialRole;
  /** Defaults to fail-closed preservation for later server-startup reconciliation. */
  readonly authorities?: RuntimeClientOptions['authorities'];
  /** Explicit handoff path; defaults to CARDS_RUNTIME_CREDENTIAL_FILE. */
  readonly credentialFilePath?: string;
}

/**
 * Atomically writes a credential handoff without following an existing destination link.
 * The parent must itself be an owner-only, non-symlink directory.
 * @param path - Destination path passed to the child through one environment variable.
 * @param value - Strictly bound execution, scope, request, and role credentials.
 * @throws When validation, protection checks, persistence, or durability synchronization fails.
 */
export function writeRuntimeCredentialFile(path: string, value: RuntimeCredentialFile): void {
  const validated = runtimeCredentialFileSchema.parse(value);
  const parent = dirname(path);
  assertProtectedDirectory(parent);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Runtime credential destination is a symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  const identity = fstatSync(descriptor);
  let closed = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(validated)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    renameSync(temporary, path);
    fsyncDirectory(parent);
  } catch (error) {
    if (!closed) closeSync(descriptor);
    cleanupOwnedTemporary(temporary, identity);
    throw error;
  }
}

/**
 * Reads and validates an owner-protected credential handoff without following links.
 * The containing directory must itself be owner-only and non-symlink.
 * @param path - Credential-file path, defaulting to CARDS_RUNTIME_CREDENTIAL_FILE.
 * @returns The strictly validated credential handoff.
 * @throws When the path is unsafe, unreadable, or contains an invalid handoff.
 */
export function readRuntimeCredentialFile(path = getRuntimeCredentialFilePath()): RuntimeCredentialFile {
  const parent = dirname(path);
  assertProtectedDirectory(parent);
  const linkStatus = lstatSync(path);
  if (linkStatus.isSymbolicLink()) throw new Error(`Runtime credential file is a symbolic link: ${path}`);

  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    assertProtectedFile(path, fstatSync(descriptor));
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(descriptor, 'utf8'));
    } catch {
      throw new Error(`Invalid runtime credential file: ${path}`);
    }
    const parsed = runtimeCredentialFileSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid runtime credential file: ${path}`);
    return parsed.data;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Loads the one credential matching an explicitly selected producer role.
 * @param role - Role the runtime client will authenticate as.
 * @param path - Credential-file path, defaulting to CARDS_RUNTIME_CREDENTIAL_FILE.
 * @returns The credential together with its bound execution and scope.
 * @throws When the handoff is invalid or does not contain the requested role.
 */
export function loadRuntimeCredential(role: ChildRuntimeCredentialRole, path?: string): LoadedRuntimeCredential {
  const value = readRuntimeCredentialFile(path);
  const credential = value.credentials.find((candidate) => candidate.role === role);
  if (credential === undefined) throw new Error(`Runtime credential file has no credential for role ${role}`);
  return { execution: value.execution, scope: value.scope, ownership: value.ownership, credential };
}

/**
 * Builds a runtime client wholly from one protected role handoff plus caller-owned services.
 * @param options - Explicit role, optional file path, and caller-owned transport dependencies.
 * @returns A disconnected runtime client ready to start.
 */
export function createRuntimeClientFromCredentialFile(options: RuntimeClientBootstrapOptions): RuntimeClient {
  const { role, credentialFilePath, authorities = PRESERVE_FOR_SERVER_STARTUP_AUTHORITIES, ...services } = options;
  const loaded = loadRuntimeCredential(role, credentialFilePath);
  return createRuntimeClient({
    ...services,
    authorities,
    identity: {
      subject:
        role === 'watcher'
          ? { kind: 'card', cardId: loaded.scope.cardId }
          : { kind: 'execution', executionId: loaded.execution.executionId },
      scope: loaded.scope,
      producer: { role, producerId: loaded.credential.producerId },
      ownership: loaded.ownership
    },
    credential: {
      requestId: loaded.credential.requestId,
      credentialId: loaded.credential.credentialId,
      secret: loaded.credential.secret
    }
  });
}
