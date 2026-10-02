/**
 * Bun build script for the claude-code-session stream renderer SPA.
 *
 * Bundles `index.html` and all referenced TypeScript/TSX/CSS assets into a
 * single self-contained HTML file using Bun's HTML bundler with Tailwind CSS
 * v4 support via `bun-plugin-tailwind`. Fails closed on any build error.
 *
 * @summary Bun HTML bundler entry point for the claude-code-session SPA
 */

import tailwind from 'bun-plugin-tailwind';

const result = await Bun.build({
  entrypoints: ['./src/streams/claude-code-session/www/index.html'],
  outdir: './dist/www/claude-code-session',
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
