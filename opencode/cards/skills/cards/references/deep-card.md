<how-to-create-a-deep-card>

A deep card structures one card as a self-contained documentation corpus — a routing-hub `CARD.md` plus typed tiers — instead of a single-file description. Depth is measured by whether each reader can act after loading exactly one file.

Everything in the skill body still applies: run the matched card type's interview, open `CARD.md` with a commander's intent per `commanders-intent.md`, and keep `plans/` empty at creation time. This reference replaces the writing guide's CARD.md body structure; §3 maps where each writing-guide section goes instead.

**Intra-card references are backtick paths, never markdown links.** Card markdown links resolve against the *workspace* root, not the card repository — `[…](explanation/foundations.md)` opens a nonexistent workspace path when clicked. Write `` `explanation/foundations.md` `` for card-internal references; markdown fragment links are only for workspace code paths per the `@markdown` skill.

## 1. Research Before Authorship

Surveys run after the interview establishes scope (on the no-interview path, after the request is read) and before any file is authored. Dispatch parallel read-only surveys — one per plane the card touches (docs/wiki corpus, each service or package plane, public surfaces) — each returning `file:line` citations and an explicit exists/does-not-exist verdict for every concept the source material presumes; where subagents are unavailable, run the same surveys serially.

Condense each survey the same session into the card's `notes/` tier. Deep cards extend the `@notes` skill: subdirectories replace flat slugs, the tier is committed once (§5) instead of note-by-note, and sidecars gain a `title` (§5) — the note content format is otherwise `@notes`'s.

- `notes/codebase/` — same-day surveys of the current system, one file per plane.
- `notes/evidence/` — findings about the source documentation package itself: what is normative, what is stale, what must not be copied. Omit this directory when there is no source package — never fake it.
- `notes/history/` — related-card fit tests and git archaeology of the substrate being extended.
- `notes/README.md` — a `| Question | Note |` routing table over the surveys.

Open every `notes/` and `reference/` file with a `Verified YYYY-MM-DD` line (ISO date); add "re-verify line numbers before editing" wherever authority rests on line citations.

## 2. Fix the Semantics

Three decisions precede any file:

- **Intent** — the commander's intent per `commanders-intent.md`, extended to name the near-miss source material: when the card is derived from an example or specification, state explicitly where that example stops being in scope.
- **Vocabulary** — `explanation/glossary.md`, one table: `| Concept | Meaning in this card | Not to be confused with |`. The glossary fixes what each concept means; where the source leaves a user-facing name open, record the meaning and mark the name as *decided at plan time*.
- **Invariants** — `explanation/invariants.md`, one table: `| Invariant | Checkable claim | Enforcement point |`. Every enforcement point cites a `file:line`. An invariant without an enforcement point is unfinished.

## 3. Lay Out the Hierarchy

Route by reader job. No fact lives in two tiers — pick one owner and cross-reference.

| Tier | Question it answers | Contains | Forbidden |
|---|---|---|---|
| `CARD.md` | What done looks like; where do I go | Intent paragraphs, then a "Read by job" routing table — one row per reader task naming the downstream file that answers it | Mechanisms, `file:line` evidence, rationale |
| `explanation/` | Why this shape | Foundations (what changes, what stays fixed), invariants, glossary, execution/architecture rationale | Procedures, API sketches |
| `how-to/` | How to build it, per workstream | Numbered files `01-…` ordered by dependency: a lead paragraph naming prerequisites, numbered steps, a closing **Done when** list of observable signals | Background theory |
| `reference/` | Exact facts while editing | Dated code-seam inventory (`file:line`), contract/field sketches, phase or event catalogs, persistence shape, failure matrix, observability, dependencies-and-exclusions, traceability table | Narrative |
| `notes/` | Where did this come from | The condensed surveys from §1 | Anything a tier above owns |

The matched writing guide's sections map onto the tiers — do not reproduce them in `CARD.md`:

| Writing-guide section family | Owner |
|---|---|
| Intent / summary | `CARD.md` opening |
| Historical context, rationale | `explanation/` |
| Current behavior with `file:line` evidence | `reference/` (seam inventory) and `notes/codebase/` |
| Desired behavior, acceptance signals | `explanation/` foundations + `how-to/` **Done when** lists |

The traceability table (`reference/traceability.md`) is the completeness gate: every section of the source material appears as a row naming its covering file, or under deliberate exclusions. With no source package, the rows are the interview's enumerated requirements instead. A gap there is a gap in the card.

Each file is single-topic and independently loadable; siblings cross-reference instead of recapping. Name the highest-risk workstream explicitly and sequence it after its prerequisites. Because a plan is later written from this card, the routing table must name `explanation/`, `how-to/`, and `reference/` reading for the planner job explicitly.

## 4. Author the Hero Page

When the model has shape worth rendering — lifecycle, trust boundary, phase authority — author one static HTML page per skill-body step 2 (`@html-files` owns the mechanics and sidecar schema, `@design` the styling) and commit it **before** `CARD.md` so it opens the card. The page restates content the tiers own — a visual index, no new facts, no author scripts (`"scripts": false`).

## 5. Assemble in Narrative Order

Commit order is reading order, and every committed `.md` becomes a row in the card's timeline — sequence within a tier deliberately. Steps 1–3 keep the skill body's commit-message forms; tier commits (step 4 onward) use `Added <tier>: [single sentence naming every topic added].` This ordering replaces the skill body's "same initial commit" — the hero page lands first.

1. `cards create` with tags across every touched plane, `"gates": {"planRequired": true}`, and `relations` to precedent cards.
2. Hero page pair (skill-body step 2).
3. `CARD.md` — intent first, routing table second.
4. `explanation/`, then `how-to/`, then `reference/`, then `notes/` surveys — one commit each.
5. Final commit: `notes/README.md` plus hub alignment — verify every routing-table row names an existing file and every file is named from `CARD.md` or `notes/README.md`.

Every committed `.md` carries a same-basename `.md.meta.json` sidecar in the same commit: `{"title": …, "summary": …}` — `title` is the short label shown in the card timeline; `summary` is a link-dense digest per the `@markdown` guidelines.

## 6. Validate the Depth

Before handoff, all must hold:

- The intent passes `commanders-intent.md`'s two-echelon and coherence tests unaided.
- Routing resolves both ways: every named file exists; every file is named from a hub. No intra-card markdown links anywhere — backtick paths only.
- Every factual claim outside `CARD.md` and `notes/` carries a same-day-verified `file:line`.
- Each `how-to` ends in observable **Done when** signals; each invariant names its enforcement point; traceability covers 100% of source sections (or interview requirements) or their exclusions.
- Every `.md` has a `.md.meta.json` with `title` and `summary`.
- Glossary terms match usage card-wide — one concept, one name.
- Rationale lives in `explanation/` or nowhere.

</how-to-create-a-deep-card>
