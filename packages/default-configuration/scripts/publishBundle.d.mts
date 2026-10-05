/**
 * Type surface for `publishBundle.mjs`, so its TypeScript test consumer
 * (`test/publish-bundle-atomic.test.ts`) imports it type-safely.
 *
 * @summary Types for the atomic `.cards/` bundle publisher
 * @module
 */

/** Entries under `.cards/` that the build owns and republishes. */
export const MANAGED_ENTRIES: string[];

/**
 * Publishes the built bundle into `.cards/` without ever exposing a torn state.
 *
 * @param dist - Absolute path to the freshly built `dist/` directory.
 * @param cardsDir - Absolute path to the live `<workspaceRoot>/.cards/` directory.
 */
export function publishBundle(dist: string, cardsDir: string): void;
