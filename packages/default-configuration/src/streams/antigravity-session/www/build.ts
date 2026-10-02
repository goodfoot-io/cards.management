/**
 * Bun build script for the antigravity-session stream renderer SPA.
 *
 * Materializes the `index.html` entrypoint under `dist/www-entry/`, then
 * bundles it with all referenced TypeScript/TSX/CSS assets into a single
 * self-contained HTML file using Bun's HTML bundler with Tailwind CSS v4
 * support via `bun-plugin-tailwind`. Fails closed on any build error so a
 * partial Antigravity artifact never ships alongside the sibling renderers.
 *
 * The entrypoint is GENERATED rather than committed — see
 * `scripts/generate-antigravity-entry.mjs` for why it lives under the
 * un-watched `dist/www-entry/` rather than `src/`, and for the second
 * consumer (`scripts/build.mjs`, which materializes it before the settings
 * build).
 *
 * @summary Bun HTML bundler entry point for the antigravity-session SPA
 */

import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';
import { generateAntigravityEntry } from '../../../../scripts/generate-antigravity-entry.mjs';

// www -> antigravity-session -> streams -> src -> <package root>
const pkgRoot = join(import.meta.dir, '..', '..', '..', '..');

// dist/ is un-watched output space; the entrypoint is regenerated after every
// clean, so staleness across invocations is impossible.
const indexPath = generateAntigravityEntry(pkgRoot);

const result = await Bun.build({
  entrypoints: [indexPath],
  outdir: './dist/www/antigravity-session',
  minify: true,
  // Shipping artifacts use production React and JSX regardless of the build process environment.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  jsx: { development: false },
  plugins: [tailwind],
  target: 'browser',
  compile: true
});

if (!result.success) {
  console.error('Build failed:', result.logs);
  process.exit(1);
}
