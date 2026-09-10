# Color Tokens

> Every color is a CSS custom property injected by VS Code (`--vscode-*`) or by the Cards host (`--cards-status-*`). No token here has a fixed hex the way a normal design system would — the runtime theme sets the value, light/dark/high-contrast alike. Components reference variable names, never literal colors.

---

## Token naming

| Pattern | Rule |
|---|---|
| `--vscode-<component>-<property>` | ColorId dot-path with dots → dashes, camelCase preserved: `button.hoverBackground` → `--vscode-button-hoverBackground` |
| `--vscode-<component>-border` | Almost always paired with a `transparent` fallback for the HC pattern (see below) |
| `--cards-status-<status>` | Cards-injected status palette; not part of VS Code's registry |

---

## Variable groups

- **Base**: `--vscode-foreground`, `--vscode-disabledForeground`, `--vscode-descriptionForeground`, `--vscode-errorForeground`, `--vscode-icon-foreground`, `--vscode-focusBorder`, `--vscode-contrastBorder`, `--vscode-contrastActiveBorder`, `--vscode-widget-shadow`, `--vscode-widget-border`, `--vscode-selection-background`
- **Text**: `--vscode-textLink-foreground/-activeForeground`, `--vscode-textSeparator-foreground`, `--vscode-textPreformat-foreground/-background`, `--vscode-textBlockQuote-background/-border`, `--vscode-textCodeBlock-background`
- **Editor**: `--vscode-editor-background/-foreground`, `--vscode-editorWidget-background/-foreground/-border`, `--vscode-editorHoverWidget-background/-foreground/-border`, `--vscode-editorError-foreground`, `--vscode-editorWarning-foreground`, `--vscode-editorInfo-foreground`
- **Button**: `--vscode-button-foreground/-background/-hoverBackground/-border/-separator`, `--vscode-button-secondaryForeground/-secondaryBackground/-secondaryHoverBackground`
- **Input**: `--vscode-input-background/-foreground/-border/-placeholderForeground`, `--vscode-inputOption-activeBorder/-activeBackground/-activeForeground/-hoverBackground`, `--vscode-inputValidation-{info,warning,error}{Background,Foreground,Border}`
- **Dropdown**: `--vscode-dropdown-background/-listBackground/-foreground/-border`
- **Checkbox/radio**: `--vscode-checkbox-background/-foreground/-border/-selectBackground/-selectBorder`; `--vscode-radio-active*/-inactive*`
- **List/tree**: `--vscode-list-hoverBackground/-hoverForeground/-activeSelectionBackground/-activeSelectionForeground/-inactiveSelectionBackground/-focusBackground/-focusOutline/-highlightForeground/-errorForeground/-warningForeground/-deemphasizedForeground/-dropBackground`, `--vscode-tree-indentGuidesStroke`, `--vscode-tree-tableColumnsBorder`, `--vscode-tree-tableOddRowsBackground`
- **Badge/progress/scrollbar**: `--vscode-badge-background/-foreground`, `--vscode-progressBar-background`, `--vscode-scrollbarSlider-background/-hoverBackground/-activeBackground`
- **Chrome**: `--vscode-panel-background/-border`, `--vscode-panelSectionHeader-*`, `--vscode-sideBar-background/-foreground/-border`, `--vscode-sideBarSectionHeader-*`, `--vscode-tab-active*/-inactive*`, `--vscode-toolbar-hoverBackground/-activeBackground`, `--vscode-banner-*`
- **Menu/quick input**: `--vscode-menu-background/-foreground/-border/-selectionBackground/-selectionForeground/-separatorBackground`, `--vscode-quickInput-background/-foreground`, `--vscode-quickInputList-focusBackground/-focusForeground`
- **Keybinding**: `--vscode-keybindingLabel-background/-foreground/-border/-bottomBorder`
- **Charts**: `--vscode-charts-red/-blue/-yellow/-orange/-green/-purple`, `--vscode-charts-foreground/-lines`

---

## `--cards-status-*` registry

Source of truth: the `STATUS_HEX_COLORS` export from the shared web-styles package. Theme-invariant — same hex in light and dark. Never re-hardcode these hexes in a component; only this file may state them.

| Variable | Current hex | Label |
|---|---|---|
| `--cards-status-todo` | `#2563eb` (blue-600) | To Do |
| `--cards-status-active` | `#9333ea` (purple-600) | Active |
| `--cards-status-needs-review` | `#f59e0b` (amber-500) | Needs Review |
| `--cards-status-done` | `#16a34a` (green-600) | Done |
| `--cards-status-archived` | `#475569` (slate-600) | Archived |

**Usage rules:**
- Status buttons: `background: transparent`; `border` and text both use the status variable.
- Selected/highlighted row or chip: status variable at **10% opacity** as background fill — `background: color-mix(in srgb, var(--cards-status-<x>) 10%, transparent)`. The tint *reduces* contrast of status-colored text over it, so a selected status state always adds a visual non-color cue — default to a leading `codicon-check` (per `components/buttons.md`); border thickening or weight change only where an icon won't fit — plus the role-correct ARIA state: `aria-pressed` on toggle buttons/chips, `aria-selected` on list/option rows — never `aria-pressed` on a role-less element.
- Text on a filled status background is a theme-invariant literal, never a theme variable — `#ffffff` on `todo`/`active`/`archived`, `#000000` on `needs-review`/`done` (see `components/badges.md`).

---

## Flat registry

```
--vscode-foreground
--vscode-disabledForeground
--vscode-descriptionForeground
--vscode-errorForeground
--vscode-icon-foreground
--vscode-focusBorder
--vscode-contrastBorder
--vscode-contrastActiveBorder
--vscode-widget-shadow
--vscode-widget-border
--vscode-selection-background
--vscode-textLink-foreground
--vscode-textLink-activeForeground
--vscode-textPreformat-foreground
--vscode-textPreformat-background
--vscode-textBlockQuote-background
--vscode-textBlockQuote-border
--vscode-textCodeBlock-background
--vscode-editor-background
--vscode-editor-foreground
--vscode-editorWidget-background
--vscode-editorWidget-foreground
--vscode-editorWidget-border
--vscode-button-foreground
--vscode-button-background
--vscode-button-hoverBackground
--vscode-button-border
--vscode-button-secondaryForeground
--vscode-button-secondaryBackground
--vscode-button-secondaryHoverBackground
--vscode-input-background
--vscode-input-foreground
--vscode-input-border
--vscode-input-placeholderForeground
--vscode-dropdown-background
--vscode-dropdown-listBackground
--vscode-dropdown-foreground
--vscode-dropdown-border
--vscode-checkbox-background
--vscode-checkbox-foreground
--vscode-checkbox-border
--vscode-list-hoverBackground
--vscode-list-activeSelectionBackground
--vscode-list-activeSelectionForeground
--vscode-list-focusOutline
--vscode-badge-background
--vscode-badge-foreground
--vscode-progressBar-background
--vscode-scrollbarSlider-background
--vscode-scrollbarSlider-hoverBackground
--vscode-scrollbarSlider-activeBackground
--vscode-panel-background
--vscode-panel-border
--vscode-sideBar-background
--vscode-menu-background
--vscode-menu-foreground
--vscode-menu-border
--vscode-menu-selectionBackground
--vscode-quickInput-background
--vscode-quickInput-foreground
--vscode-quickInputTitle-background
--vscode-quickInputList-focusBackground
--vscode-quickInputList-focusForeground
--vscode-keybindingLabel-background
--vscode-keybindingLabel-foreground
--cards-status-todo        #2563eb
--cards-status-active      #9333ea
--cards-status-needs-review #f59e0b
--cards-status-done        #16a34a
--cards-status-archived    #475569
```

---

## Theme classes and attributes

`<body>` in every VS Code webview carries theme-state classes: `vscode-light`, `vscode-dark`, `vscode-high-contrast` (both HC variants), `vscode-high-contrast-light`, plus `vscode-reduce-motion`, `vscode-using-screen-reader`. Card-HTML iframes additionally receive `data-vscode-theme-kind` (`light|dark|high-contrast`) on `<html>`, host-set and updating live on theme change.

## HC (high contrast) pattern

Every bordered surface declares its border as `border: 1px solid var(--vscode-<x>-border, transparent)` — invisible on light/dark, visible in HC where the theme supplies a real color. Do not write `border: none` on a surface that needs an HC-visible edge; write the var-with-fallback instead. HC additionally: suppresses hover backgrounds (rely on the border pattern for interactive feedback instead of background swap); marks the active/focused element with `--vscode-contrastActiveBorder`; underlines links.

**Behavioral HC rules** (hover suppression, dashed hover outlines, shimmer removal) gate on the forwarded theme-kind attribute, not on color sniffing:

```css
:root[data-vscode-theme-kind="high-contrast"] .row:hover { background: transparent; outline: 1px dashed var(--vscode-contrastActiveBorder); }
```

**Demoing HC treatments in a non-HC page**: give the contrast var a themed fallback — `var(--vscode-contrastActiveBorder, var(--vscode-focusBorder))`; the genuine value wins under real HC. Never *redefine* `--vscode-contrast*` properties — that shadows the forwarded values. For *behavioral* HC rules (hover suppression, dashed outlines), share the rule block between the real gate and a demo class: `:root[data-vscode-theme-kind="high-contrast"] .row:hover, .demo-hc .row { … }`.

## Usage by surface type

| Surface | Variables |
|---|---|
| Page/body | `--vscode-editor-background` (transparent in practice), `--vscode-editor-foreground` |
| Buttons | `--vscode-button-*`, HC border pattern |
| Inputs | `--vscode-input-*`, `--vscode-inputValidation-*` on error/warning |
| Lists/trees | `--vscode-list-*`, `--vscode-tree-*` |
| Menus/quick input | `--vscode-menu-*`, `--vscode-quickInput-*` |
| Status UI (Cards) | `--cards-status-*` |
| Charts | `--vscode-charts-*` |

## Prohibited

- No literal hex/rgb colors in components — every color is a `--vscode-*` or `--cards-status-*` variable.
- No re-hardcoding the `STATUS_HEX_COLORS` values outside this file.
- No bordered surface without the `var(--x-border, transparent)` HC fallback pattern.
- No hover-background-only feedback that disappears under HC without a border fallback.
- No `@vscode/webview-ui-toolkit` color tokens — deprecated, do not reference.
