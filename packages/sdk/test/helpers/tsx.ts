/**
 * The `tsx` loader flag for child processes that run TypeScript test scripts.
 * A bare `--import=tsx` resolves against the child's working directory, which
 * for a script in a temp directory finds no `node_modules`; the flag here names
 * the loader by absolute URL instead.
 * @summary Absolute tsx loader flag for spawned TypeScript scripts
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** `--import=<file URL of the tsx loader>`, valid from any working directory. */
export const TSX_IMPORT = `--import=${pathToFileURL(createRequire(__filename).resolve('tsx')).href}`;
