# Contexts

> the token/component rules elsewhere in this skill are unified across both consumption contexts; this file documents only what differs between them.

---

## Context A — card-embedded HTML

A `.html` file in a card repository, rendered inside a sandboxed iframe that loads a real document served by the Cards server (`src`, never `srcdoc`).

**Assumed environment (fact):** the page receives the live `--vscode-*` custom-property set plus `--cards-status-todo/-active/-needs-review/-done/-archived` — baked into a `:root` style at serve time and kept live by a baked listener that replaces that style's content on theme change. `data-vscode-theme-kind` (`light|dark|high-contrast`) is set on `<html>`.

The page cannot force or preview a theme — verify light/dark/HC by switching the host theme (or a harness swapping the forwarded set), never by hardcoding a second palette. (HC-demo fallback pattern: `foundation/colors.md`.)

Forward the *full* set in any harness: vscode-elements internals read non-obvious vars (`<vscode-textfield>` uses `--vscode-settings-textInputBackground`, not `--vscode-input-background`) and fall back to dark literals when one is missing — partial forwarding breaks silently in light themes.

**Sanctioned stack** — prefer these over hand-rolled CSS/JS:

```html
<!doctype html>
<html lang="en"> <!-- data-vscode-theme-kind is set by the host — never hardcode it -->
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Card</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <script type="module" src="https://cdn.jsdelivr.net/npm/@vscode-elements/elements@2.5.1/dist/bundled.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.44/dist/codicon.css" />
  <style type="text/tailwindcss">
    @theme inline {
      --color-editor-bg: var(--vscode-editor-background);
      --color-editor-fg: var(--vscode-editor-foreground);
    }
  </style>
  <style>
    body { background: var(--vscode-editor-background); }
  </style>
</head>
<body class="bg-[var(--vscode-editor-background)] text-[var(--vscode-editor-foreground)]">
  <vscode-button>Action</vscode-button>
</body>
</html>
```

Reference vscode vars via Tailwind arbitrary values (`bg-[var(--vscode-editor-background)]`) or bridge a handful into named utilities with a small `@theme inline` block — either is fine, don't hand-roll the equivalent CSS.

**Constraints (CSP-driven, fail-closed):**
- External `https://` assets (scripts, stylesheets, fonts, images) are allowed — any `https://` origin, no allowlist. `http://`, protocol-relative `//`, and relative paths are rejected at commit time and blocked by the CSP, except relative paths that normalize into the repo-root `assets/` directory — those are served on the page's own origin (see the `$html-files` skill's *Relative `assets/` references*). Pin exact versions on CDN references; the stack above is the default baseline, not an exclusive allowlist.
- `connect-src 'self' https:` — `fetch`/XHR to the Cards server (the page's own origin, the same one its `assets/` files load from) and to any `https://` origin works; plain `ws://` and non-https endpoints are blocked.
- Inline scripts are auto-nonced by the server when it builds the document — a cached build re-serves its nonce together with its CSP header — so don't add your own `nonce` attribute. External `<script src="https://…">` runs on the `https:` scheme token, no nonce involved.
- `<base target="_blank">` is injected automatically, so links target new tabs instead of navigating the iframe — and because the sandbox withholds `allow-popups`, those navigations are blocked: a link click neither opens a tab nor navigates the page.
- Sandbox is `allow-scripts allow-same-origin` — the page has its real origin on the Cards server: relative `assets/` subresources, same-origin `fetch()`, and fonts all work. That origin is the server's, not the webview parent's (`vscode-webview://`) — cookies and parent-frame DOM access stay impossible.
- Authoring mechanics (two-file pairing, sidecar `meta.json`, `cards html check` gate) are owned by the `$html-files` skill — see it, don't duplicate it here.

**Self-contained page:** this is not a hosted webview — paint the page's own surface explicitly (`background: var(--vscode-editor-background)` on `body`/`html`) rather than relying on a transparent default. Define scrollbar CSS yourself per `foundation/layers.md`; nothing injects it for you here.

---

## Context B — extension webview development

React 19 + Tailwind v4 apps that make up the extension's own webviews.

**Token bridge:** `@cards.management/web/styles` (built with `@theme inline`) aliases ~60 vscode vars to named Tailwind classes — `bg-vscode-editor-background`, `text-vscode-descriptionForeground`, `border-vscode-panel-border`. Prefer these named classes over arbitrary values. For a var not yet bridged, use the escape hatch `bg-[var(--vscode-sideBar-background)]` rather than adding a bridge entry ad hoc.

**vscode-elements components** (`<vscode-button>`, `<vscode-textfield>`, `<vscode-textarea>`, …) render via shadow DOM, so Tailwind classes can't reach their internals. Override their look with inline `style` setting `--vscode-*` vars on the host element:

```tsx
<vscode-button style={{ '--vscode-button-border': 'transparent' }}>Save</vscode-button>
```

**Codicons:** use the bundled `codicon.css` (`<span class="codicon codicon-chevron-down" />`) — don't inline SVGs or pull a different icon set. See `components/codicons.md`.

**Scrollbars:** width comes from the host-injected `--cards-scrollbar-width` var (not a fixed px value); colors from `--vscode-scrollbarSlider-*` per `foundation/colors.md`.

**Status colors:** import the `STATUS_HEX_COLORS` helpers (and friends) from the shared web-styles package — never re-hardcode the status hexes in component code. See `foundation/colors.md` for the token → hex mapping.

---

## Delta summary

| Concern | Card HTML | Extension webview |
|---|---|---|
| CSS delivery | Tailwind v4 via CDN `<script>`, arbitrary-value or small `@theme inline` bridge | Tailwind v4 build with full `@theme inline` bridge (`tailwind.css`) → named classes |
| Component library delivery | `@vscode-elements/elements` bundled JS via CDN `<script>` | vscode-elements as npm dependency, styled via inline host `style` overrides |
| Icons | CDN `codicon.css` (sanctioned link above), `codicon codicon-*` classes | Bundled `codicon.css`, `codicon codicon-*` classes |
| Status colors source | `--cards-status-*` vars (forwarded into iframe) | `statusColors.ts` helpers (same underlying hexes) |
| Scrollbars | Self-defined CSS per `foundation/layers.md` | Host-injected `--cards-scrollbar-width` + `--vscode-scrollbarSlider-*` |
| Fetch / network | `https://` origins only (`connect-src https:`) | Normal extension messaging / APIs allowed |
| Navigation | `<base target="_blank">` auto-injected, no same-origin | Standard SPA routing within the webview |

---

## Prohibited

- Never `@vscode/webview-ui-toolkit` — deprecated in both contexts; use `@vscode-elements`.
- Never raw hex values in either context — vscode vars or `--cards-status-*` only (see `foundation/colors.md`).
- Never load an unpinned/floating CDN version in card HTML (except `@tailwindcss/browser@4`, pinned to its major).
- Never non-`https://` network references in card HTML (`http://`, `//`, relative paths, `ws://`) — rejected at commit time and blocked by the CSP.
- Never re-hardcode the status hexes outside `statusColors.ts` (webview) or the `--cards-status-*` values (card HTML) — both trace to `foundation/colors.md`.
- Never assume same-origin access (cookies, parent DOM, storage) inside a card HTML iframe.
