---
name: design
description: The single, authoritative design system for themable VSCode UI in this project — VS Code's own webview conventions fused with the Cards extension's concrete tokens and component specs. Use whenever building, styling, or reviewing UI in a Cards extension webview or HTML embedded in a card; every component follows the modules bundled here rather than ad-hoc values or generic best-practice guesses.
---

# VSCode / Cards Design System

> **READ FIRST — NON-NEGOTIABLE.** Every color in this system is a CSS custom property supplied by the live VS Code theme (`--vscode-*`) or the Cards host (`--cards-status-*`). There are no brand hexes to memorize and none may be invented. A page authored against these variables matches the user's theme — light, dark, or high contrast — without per-theme CSS.

## 1. What this design is

Flat, compact, theme-transparent UI that reads as native VS Code chrome. Separation comes from hairline borders and background steps, never elevation; type is small and quiet; motion is nearly absent. Two contexts consume the same rules — HTML embedded in cards (documents served by the Cards server, loaded by `src` in sandboxed iframes) and the extension's own webviews — differing only in delivery mechanics (`contexts.md`).

### Signature traits — non-negotiable

- **Theme variables only.** Every color is `var(--vscode-*)` or `var(--cards-status-*)`; literal hex/rgb in a component is a bug. See `foundation/colors.md`.
- **Flat by default.** Shadows exist solely for floating layers (popovers, dialogs); resting controls are shadowless and separated by 1px borders. See `foundation/shadows.md`.
- **Compact scale.** 13px base type, ~26px controls, 22px list rows, radius 4px on controls. See `foundation/typography.md`, `foundation/radius.md`.
- **High contrast is built in.** Every bordered surface uses `border: 1px solid var(--x-border, transparent)` so HC themes materialize edges automatically. See `foundation/colors.md`.
- **Focus is an outline.** `outline: 1px solid var(--vscode-focusBorder)` — never a box-shadow ring. See `principles/accessibility.md` §3.

## 2. Module index

### `contexts.md` — read for every task

| File | Covers |
|---|---|
| [contexts.md](contexts.md) | The two consumption contexts and their deltas: card HTML (CDN Tailwind + vscode-elements, CSP limits, self-painted surface) vs extension webviews (built Tailwind bridge, npm vscode-elements, codicon.css) |

### `foundation/` — read first

| File | Covers |
|---|---|
| [foundation/colors.md](foundation/colors.md) | `--vscode-*` variable groups, `--cards-status-*` registry, theme classes, HC pattern |
| [foundation/typography.md](foundation/typography.md) | Font variables, 13px base, size ramp, weights 400/600, code/kbd/links |
| [foundation/spacing.md](foundation/spacing.md) | `spacing.size*` scale, webview body padding, Cards 12/12/6/0 conventions |
| [foundation/radius.md](foundation/radius.md) | `cornerRadius.*` scale (2/4/6/8/12/circle), `strokeThickness` 1px |
| [foundation/shadows.md](foundation/shadows.md) | shadow-popover / shadow-dialog / shadow-legacy; flat-by-default |
| [foundation/motion.md](foundation/motion.md) | ≤150ms durations, hover = background swap only, `vscode-reduce-motion` |
| [foundation/layers.md](foundation/layers.md) | Page-local z scale, thumb-only scrollbars, `--cards-scrollbar-width` |

### `principles/` — read per task

| File | Covers |
|---|---|
| [principles/accessibility.md](principles/accessibility.md) | Variable-pair contrast model, focus contract, WCAG rules for webviews |
| [principles/interaction-and-ux-laws.md](principles/interaction-and-ux-laws.md) | UX laws, control-state contract, sanctioned hover/active treatments |
| [principles/layout-and-hierarchy.md](principles/layout-and-hierarchy.md) | Hierarchy, panel-first adaptive sizing, composition rules |
| [principles/implementation-hygiene.md](principles/implementation-hygiene.md) | Cross-cutting technique rules (CSS safety, margins, icons, borders) |

### `components/` — read per element on the page

| File | Covers |
|---|---|
| [components/buttons.md](components/buttons.md) | Primary/secondary/icon buttons, Cards status buttons, `<vscode-button>` |
| [components/inputs.md](components/inputs.md) | Text fields, textareas, validation states |
| [components/select.md](components/select.md) | Native select + custom dropdown triggers |
| [components/checkbox-radio.md](components/checkbox-radio.md) | Checkboxes and radios |
| [components/menus.md](components/menus.md) | Context/dropdown menu panels |
| [components/list-rows.md](components/list-rows.md) | 22px list/tree rows, selection/focus/hover states |
| [components/tabs.md](components/tabs.md) | Editor-style and panel-underline tab strips |
| [components/tables.md](components/tables.md) | Data tables, striping, sortable headers |
| [components/panels.md](components/panels.md) | Containers, section headers, card surfaces |
| [components/dialogs.md](components/dialogs.md) | Modal dialogs, quick-input overlays |
| [components/badges.md](components/badges.md) | Counter badges, Cards status badges/dots |
| [components/tooltips.md](components/tooltips.md) | Hover tooltips |
| [components/progress.md](components/progress.md) | Progress bars, skeleton shimmer, spinners |
| [components/codicons.md](components/codicons.md) | Icon usage, per-context delivery, fallbacks |

## 3. How to use this skill

1. Read `contexts.md` first and identify which context you're in; it changes delivery, not design.
2. Read all of `foundation/` before writing any styles.
3. Add the `components/` module for each element on the page; follow its tables, don't improvise.
4. Add `principles/` modules per the task table below.
5. Every numeric fact lives in exactly one file. If two files disagree, that's a bug — flag it, don't pick one silently.

### Suggested reading by task

| Task | Read at minimum |
|---|---|
| Card-embedded HTML page | contexts.md, foundation/ (all), components per element |
| New webview view/panel | contexts.md, foundation/ (all), layout-and-hierarchy, components per element |
| Form UI | inputs, select, checkbox-radio, buttons, accessibility |
| List/tree or picker UI | list-rows, menus, dialogs (quick-input), interaction-and-ux-laws |
| Status UI (badges, boards) | colors (status registry), badges, buttons, list-rows |
| Overlay (menu/tooltip/dialog) | layers, shadows, menus/tooltips/dialogs, accessibility |
| A11y review | accessibility, interaction-and-ux-laws, every component in the view |
| CSS cleanup | implementation-hygiene, contexts.md |

## 4. Operating rules

Domain-specific decisions live here; generic engineering rules live in `principles/implementation-hygiene.md`.

- **Never hardcode a color.** `--vscode-*` and `--cards-status-*` variables only; the status hexes are stated once in `foundation/colors.md` and nowhere else.
- **Trust the theme's pairs.** Use matched foreground/background variable pairs; never cross-pair (see `principles/accessibility.md` §1).
- **HC border fallback everywhere.** `border: 1px solid var(--x-border, transparent)` on every bordered control.
- **Hover is a background swap.** No transforms, no shadows, no scale — in any state.
- **Prefer the sanctioned stacks.** Card HTML: CDN `@tailwindcss/browser@4` + `@vscode-elements/elements`; webviews: the `@cards.management/web/styles` Tailwind bridge + npm vscode-elements. Hand-rolled CSS is the fallback, not the default.
- **`@vscode/webview-ui-toolkit` is deprecated.** Never reference or emulate it.
- **Status colors trace to one source.** `statusColors.ts` in code, `--cards-status-*` in pages, both documented in `foundation/colors.md`.
- **Respect host-injected context.** Webviews inherit body padding, font, and scrollbar width from the host; don't re-declare them. Card HTML gets none of that and must self-paint (see `contexts.md`).
- **Theme changes are live.** Never cache a resolved color in JS without re-reading on `data-vscode-theme-kind` / theme-class change.
- **Card-HTML authoring mechanics** (sidecar meta, `cards html check`, two-file pairing) belong to the `@html-files` skill — this skill owns design only.

## 5. Named exceptions

Documented departures from the general rules; anything not listed here follows the rule.

- **`--cards-status-*` are literal hexes** behind variables, theme-invariant by design (same value in light/dark). See `foundation/colors.md`.
- **kbd radius is 3px**, off the `cornerRadius` scale. See `foundation/radius.md`.
- **Filled status badge text is a literal**: `#ffffff` on `todo`/`active`/`archived`, `#000000` on `needs-review`/`done` — theme-invariant text paired with the theme-invariant fills, a sanctioned exception to the no-literal-hex rule (a theme variable here fails contrast in one polarity). See `components/badges.md`, `principles/accessibility.md` §1.2.
- **22px list rows** sit below the WCAG 24px target floor — accepted platform convention; compensate with full-row hit areas. See `principles/accessibility.md`.
- **Inline SVG icons are allowed in card HTML only**, as the fallback when the CDN codicon stylesheet can't be used. See `components/codicons.md`.
- **Icon-button toolbar clusters use 0 gap**, unlike the 6px inline-item default. See `foundation/spacing.md`.
- **Shadows are self-defined literals** (not theme variables) because workbench shadow vars don't reach webviews. See `foundation/shadows.md`.
- **The dialog backdrop scrim is a literal `rgba(0,0,0,0.5)`** — an alpha overlay, not a themeable surface. See `components/dialogs.md`.
- **Depth is permitted inside a work-diagram SVG** — elevation encodes hierarchy within the diagram frame, using the `shadow-diagram` token; the surrounding page chrome stays flat. See `foundation/shadows.md` and the cards skill's `work-diagram-style.md` reference.
- **External `https://` assets are allowed in card HTML** (any origin; `http://`/`//`/relative rejected). The sanctioned CDN stack (Tailwind browser build, vscode-elements module, codicon stylesheet) is the default baseline; other external assets are permitted with pinned versions. See `contexts.md`.
