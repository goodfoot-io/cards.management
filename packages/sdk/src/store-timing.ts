/**
 * Store timing that the Cards API server and its synchronous clients must agree on.
 *
 * The server owns the SQLite connection, but a client that waits for a write's
 * acknowledgement has to wait at least as long as that write may legitimately
 * spend retrying a lock, or it reports a failure for a write that commits.
 *
 * @summary Store lock-wait bound shared by the API server and acknowledgement clients
 * @module store-timing
 */

/**
 * SQLite `busy_timeout` for every Cards store connection: how long a statement
 * retries a locked database before failing. A transactional API write can
 * therefore spend this long waiting on contention and still commit, so a
 * client's acknowledgement deadline must exceed it.
 */
export const STORE_BUSY_TIMEOUT_MS = 3000;
