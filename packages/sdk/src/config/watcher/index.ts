/**
 * Public API for the watcher primitive.
 *
 * @summary Watcher primitive exports
 * @module
 */

export type { WatcherContext } from './context.js';
export { WatcherRegistrationError } from './errors.js';
export {
  createReconnectingWatcher,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  type ReconnectingWatcherHandle,
  type WatcherRegistration
} from './reconnectingWatcher.js';
