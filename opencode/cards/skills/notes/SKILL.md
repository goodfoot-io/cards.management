---
name: notes
description: Reusable notes in a card's notes/ directory.
---

<placeholder-variables>
[CARD_REPO_PATH] — Absolute path to the card's git repository (the `repositoryPath` field from `card` output, or the `$CARD_REPO_PATH` environment variable)
</placeholder-variables>

<take-notes>

While working on this card, write a note whenever you encounter any of the following:

- **Entry points** — a file that serves as the main entry point, state manager, or lifecycle root for the domain; include the 2–4 files to read first and the data flow between them
- **Test coverage** — a test file that acts as a specification or best illustration of intended behavior for this domain
- **Integration pattern** — how this code hooks into the larger system: initialization order, registration calls, lifecycle methods, or dependency injection
- **Similar implementations** — an existing module in the codebase that follows the same pattern and can serve as a model
- **Key types** — the 2–4 most important type definitions, interfaces, or enums and how they flow through the system
- **Configuration** — where config constants, environment variables, feature flags, or settings are defined for this area
- **Dev context** — how to run, watch, or observe this code locally; which build scripts or commands to use

## Note Format

Write two files per note. Load the `@markdown` skill if not already loaded — both the note content and its sidecar summary follow the `<markdown-guidelines>`.

Use a kebab-case slug that matches the trigger category (e.g. `entry-points`, `key-types`).

**`[CARD_REPO_PATH]/notes/[slug].md`** — full note content, factual and specific: file paths, function names, line numbers, call sequences. Omit general advice.

**`[CARD_REPO_PATH]/notes/[slug].md.meta.json`** — 1–2 sentences capturing the most important facts an agent needs before reading the full note:

```json
{
  "summary": "[1–2 sentences with the most important facts; fragment-link every named file, function, and type per <markdown-guidelines>]"
}
```

## Committing Notes

Commit each note as you create it:

```bash
cd "[CARD_REPO_PATH]" && git add notes/ && git commit -m "[Single sentence summarizing what the note covers.]"
```

</take-notes>
