/**
 * Lightweight runtime bootstrap surface for bundled short-lived producers.
 * @summary Runtime client bootstrap without the HTTP action-client dependency graph
 * @module
 */
export {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential
} from './credential-file.js';
