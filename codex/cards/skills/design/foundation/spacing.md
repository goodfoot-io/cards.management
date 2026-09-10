# Spacing Tokens

> VS Code's `spacing.size*` scale, plus Cards' own webview-body conventions layered on top. Values below are literal px and the single source of truth; components reference token names.

---

## Token naming

| Pattern | Rule |
|---|---|
| `--vscode-spacing-size<N>` | `N` is a step name, not a raw px value — `size20` = 2px, `size40` = 4px, … |
| `--cards-*` | Cards-specific layout constants not in VS Code's registry |

---

## Spacing scale

| Token | px |
|---|---|
| size20 | 2 |
| size40 | 4 |
| size60 | 6 |
| size80 | 8 |
| size100 | 10 |
| size120 | 12 |
| size160 | 16 |
| size200 | 20 |
| size240 | 24 |
| size320 | 32 |
| size400 | 40 |

---

## Flat registry

```
--vscode-spacing-size20   2px
--vscode-spacing-size40   4px
--vscode-spacing-size60   6px
--vscode-spacing-size80   8px
--vscode-spacing-size100  10px
--vscode-spacing-size120  12px
--vscode-spacing-size160  16px
--vscode-spacing-size200  20px
--vscode-spacing-size240  24px
--vscode-spacing-size320  32px
--vscode-spacing-size400  40px
webview body padding      0 20px (size200 horizontal, 0 vertical)
Cards container padding   12px (size120)
Cards row gap              12px (size120)
Cards item gap               6px (size60)
Cards icon-button group gap  0
```

---

## Webview body

Every extension webview receives `padding: 0 20px` on `body` from VS Code's default injected stylesheet — horizontal `size200`, no vertical padding. Do not re-add horizontal page padding inside your own root container. Card-HTML iframes do **not** receive that stylesheet (see `contexts.md`) — set `padding: 0 20px` on `body` yourself to match.

## Cards conventions

Source: the shared web-styles package's spacing reference.

| Context | Value |
|---|---|
| Container padding (panels, cards) | 12px (`size120`) |
| Row gap (stacked rows/sections) | 12px (`size120`) |
| Item gap (inline elements within a row) | 6px (`size60`) |
| Icon-button group gap | 0 — icon buttons in a toolbar cluster sit flush |

## Usage by surface type

| Surface | Spacing |
|---|---|
| Webview page body | 0 20px (inherited in webviews; self-set in card HTML) |
| Panel/card container | 12px padding all sides |
| Stacked rows (form fields, list sections) | 12px gap |
| Inline items (label + value, icon + text) | 6px gap |
| Icon-button toolbar cluster | 0 gap between buttons |

## Prohibited

- No raw px spacing outside the `size*` scale.
- No horizontal body padding beyond the inherited `0 20px` — don't double it.
- No gap value for Cards containers/rows/items other than 12/12/6 respectively.
- No gap between icon buttons in a toolbar group — must be 0.
