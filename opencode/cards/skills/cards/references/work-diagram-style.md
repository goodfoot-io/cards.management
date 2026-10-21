# Work Diagrams — Visual Language

Stylized-2.5D grammar for work diagrams rendered as inline SVG in a card HTML page. What to represent: `work-diagram-concepts.md`. Which notation: `work-diagram-notations.md`. Page mechanics belong to the `@html-files` skill; the design system and its color/shadow tokens to `@design` — this file only specializes them for diagram artwork.

The diagram is a designed exhibit: a title block states its thesis, a legend decodes every mark, generous margins frame a dense center. Depth is permitted inside the diagram frame — a named exception in the design skill's §5 — where elevation encodes hierarchy; the page chrome around it stays flat.

## SVG mechanics

- Set fill, stroke, and filters through CSS — a `<style>` block, or `style=` on the element. Never presentation attributes: `var()` does not resolve in `fill="…"`/`stroke="…"`.
- Depth is `filter: drop-shadow(…)` or `<feDropShadow>`; `box-shadow` does not apply to SVG shapes.
- Under `:root[data-vscode-theme-kind="high-contrast"]`, null out **every** filter the diagram declares — nothing removes shadows or glows automatically — and widen strokes per state class, preserving the weight ladder rather than setting one width for all shapes — an HC rule outranks the plain state classes, so every state with a distinct weight needs its own HC rule. The CSS `border` fallback pattern has no SVG equivalent.
- Scale with `viewBox` plus `width: 100%; height: auto` on the `<svg>`; no fixed height.
- Type and stroke widths are in user units, not screen pixels: a 1440-wide `viewBox` rendered in an ~800px card scales ~0.55×, so a 13px label lands at ~7px. Size labels at ~24 user units in a 1440 viewBox, or keep the viewBox near the render width.
- An SVG `<style>` block is document-scoped — prefix class names per diagram when a page holds more than one.

Worked node example:

```html
<svg viewBox="0 0 1440 900" style="width:100%;height:auto">
  <style>
    .wd1-node { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); filter: drop-shadow(0 2px 6px rgba(0,0,0,0.25)); }
    .wd1-node--active { stroke: var(--vscode-charts-blue); stroke-width: 3; filter: drop-shadow(0 0 6px var(--vscode-charts-blue)); }
    .wd1-label { fill: var(--vscode-foreground); font-size: 24px; } /* user units ≈ 13px on screen at ~800px render width */
    :root[data-vscode-theme-kind="high-contrast"] svg * { filter: none; }
    :root[data-vscode-theme-kind="high-contrast"] .wd1-node { stroke-width: 2; }
    :root[data-vscode-theme-kind="high-contrast"] .wd1-node--active { stroke-width: 3; }
  </style>
  <rect class="wd1-node wd1-node--active" x="40" y="40" width="220" height="72" rx="7"/>
  <text class="wd1-label" x="60" y="84">Validate migration</text>
</svg>
```

## Color — tokens only

Every color is a theme variable; the registry is the design skill's `foundation/colors.md`.

| Role | Token |
|---|---|
| Stage / field | `var(--vscode-editor-background)` |
| Node faces, cards, panels | `var(--vscode-editorWidget-background)`; recessed planes `var(--vscode-sideBar-background)` |
| Hairlines, grid rules, connectors | `var(--vscode-panel-border)` |
| Primary text | `var(--vscode-foreground)` |
| Secondary text, axis labels, captions | `var(--vscode-descriptionForeground)` |
| Accent (spines, title rules, emphasis) | `var(--vscode-textLink-foreground)` |
| Categorical hues (lanes, groups) | `var(--vscode-charts-blue/-green/-yellow/-orange/-purple/-red)`, excluding any hue already bound to a state mark; a diagram needing more lanes than remain should group or lane by position, not hue |
| Problem / attention states | `var(--vscode-editorError-foreground)`, `var(--vscode-editorWarning-foreground)` |

One hue = one meaning, held constant across the diagram and stated in the legend. State colors attach to *nodes*, so topology stays legible at any zoom.

## State marks

Color is never the only carrier — each state also differs by stroke or fill style. Use only the states the record supports (`work-diagram-concepts.md`).

| State | Mark |
|---|---|
| pending / not started | Hollow face, hairline stroke |
| active | Heavier `--vscode-charts-blue` stroke + glow — the only glow in the diagram; the stroke weight survives HC when the glow doesn't |
| completed | Matte face, solid `--vscode-charts-green` stroke, no glow |
| blocked | Heavy `--vscode-editorWarning-foreground` stroke |
| failed | `--vscode-editorError-foreground` stroke + cross mark |
| skipped | Dashed stroke, `--vscode-descriptionForeground` |
| uncertain (node or edge) | Dashed hairline, hollow — never a confident solid mark |

## Depth — restrained 2.5D

- Depth is the `shadow-diagram` token (`drop-shadow(0 2px 6px rgba(0,0,0,0.25))`, registered in the design skill's `foundation/shadows.md`), one consistent light direction for the whole piece — no skew, isometric distortion, or perspective.
- Elevation encodes hierarchy: ground plane = grid/axes; mid planes = work items; topmost plane = decision points. Elevation is always a second cue, never the only one — each plane is also distinguishable by stroke weight or fill style, because HC themes flatten shadow and glow to nothing.
- **Light marks live work.** Glow — a `drop-shadow` in the mark's own state hue — is reserved for active/turning-point elements, at most one or two per diagram. Everything else stays matte.

## Typography and framing

- Small, precise type: uppercase letter-spaced kicker labels for lane/group headers, quiet captions in `descriptionForeground`. No decorative fonts.
- Title block (thesis line) top-left or as a masthead; legend anchored in a corner panel; both on their own plane.
- Dense center, breathing margins.

## Prohibited

- Literal palette hexes lifted from any reference artwork — tokens only (the `shadow-diagram` rgba is the sanctioned literal).
- Depth on the surrounding page chrome; 2.5D lives inside the diagram frame.
- Glow on completed or idle elements.
- Depth or color as the only carrier of a distinction — pair with stroke weight, fill style, or shape.
- `--cards-status-*` on a diagram node — those tokens mean the card's own lifecycle state, not a task's; use `--vscode-charts-*` and the error/warning tokens for node state.
- Raster embeds for the diagram itself — pure vector SVG.
