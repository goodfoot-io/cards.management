/**
 * Error types for the watcher primitive lifecycle.
 *
 * @summary Watcher error classes
 * @module
 */

export class WatcherRegistrationError extends Error {
  override readonly name = 'WatcherRegistrationError';
}
