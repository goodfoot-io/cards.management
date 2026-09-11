/**
 * Protected runtime credential-file persistence and role-specific loading.
 * @summary Runtime credential-file handoff
 * @module
 */

import type { IssuedRoleCredential, ProducerRole, RuntimeCredentialFile } from '../../protocol/types/index.js';

/** Credential and bound identity loaded for one explicit runtime producer role. */
export interface LoadedRuntimeCredential {
  readonly execution: RuntimeCredentialFile['execution'];
  readonly scope: RuntimeCredentialFile['scope'];
  readonly credential: IssuedRoleCredential;
}

/**
 * Atomically writes a credential handoff with owner-only permissions.
 * @param _path - Destination path passed to the child through one environment variable.
 * @param _value - Strictly bound execution, scope, request, and role credentials.
 * @throws Until the implementation phase.
 */
export function writeRuntimeCredentialFile(_path: string, _value: RuntimeCredentialFile): void {
  throw new Error('Not Implemented');
}

/**
 * Reads and validates an owner-protected credential handoff.
 * @param _path - Credential-file path, defaulting to CARDS_RUNTIME_CREDENTIAL_FILE.
 * @returns The strictly validated credential handoff.
 * @throws Until the implementation phase.
 */
export function readRuntimeCredentialFile(_path?: string): RuntimeCredentialFile {
  throw new Error('Not Implemented');
}

/**
 * Loads the one credential matching an explicitly selected producer role.
 * @param _role - Role the runtime client will authenticate as.
 * @param _path - Credential-file path, defaulting to CARDS_RUNTIME_CREDENTIAL_FILE.
 * @returns The credential together with its bound execution and scope.
 * @throws Until the implementation phase.
 */
export function loadRuntimeCredential(_role: ProducerRole, _path?: string): LoadedRuntimeCredential {
  throw new Error('Not Implemented');
}
