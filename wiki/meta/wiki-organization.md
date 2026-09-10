---
title: Wiki Organization
summary: First-principles reasoning behind how wiki documents are organized in this repository — mode separation, embed vs. centralize, and signals for reorganization.
tags:
  - meta
  - wiki
---

This page explains *why* the wiki is organized the way it is. For the CLI tools that enforce them, see [Wiki CLI](/wiki/architecture/wiki-cli.md).

## Why Documentation Modes Must Be Separated

The most important insight from documentation research — codified in the [Diátaxis framework](https://diataxis.fr/) — is that different kinds of documentation serve fundamentally different reader needs, and mixing them in the same page or section makes every reader worse off.

Diátaxis identifies four modes:

- **Reference** — technical description of what something is; a reader looks something up and leaves
- **Explanation** — understanding-oriented; a reader wants to know why something works the way it does
- **How-to guides** — goal-oriented procedures for a reader who needs to accomplish a specific task
- **Tutorials** — learning-oriented; a reader is guided through an experience to build understanding

A reader consulting reference material is interrupted by rationale. A reader trying to understand a system is distracted by step-by-step instructions. These modes require different writing styles and serve readers in different states of mind.

This repository's wiki maps cleanly onto three of these modes: architecture pages are explanation, guide pages are how-to, and meta pages are reference. The wiki deliberately does not contain tutorials — learning is better served by the code itself, JSDoc, and package READMEs adjacent to what is being learned.

Mixing modes is the most common source of documentation rot. When a page tries to be both a reference and a guide, it is optimized for neither. Over time, the reference sections and the procedural sections go stale at different rates and for different reasons, and neither reader is well served.

## Embed vs. Centralize

This repository uses two parallel systems for wiki content: a central `wiki/` directory and `*.wiki.md` files embedded alongside components. This is a deliberate organizational decision, not an accident of the tooling.

**Centralize in `wiki/`** when the content is cross-cutting — when it synthesizes across packages, describes how components interact, or would be needed by someone who doesn't know which package to look in. Cross-cutting content has no natural home in the source tree, and burying it in one package would make it hard to find from another.

**Embed as `*.wiki.md`** when the content is primarily about a single component — its design decisions, internal constraints, or rebuild logic. Co-locating documentation with code has well-established benefits: it is found by whoever is working on the component, it is maintained by the same person who maintains the code, and it signals ownership clearly. A `DESIGN.wiki.md` file next to the component it documents is less likely to drift than the same content in `wiki/architecture/` because the person changing that component will encounter it directly.

The `*.wiki.md` extension is what allows embedded pages to participate in the same wiki index, default `wiki [query]` lookup, and `wiki stale` infrastructure as centralized pages. Co-location does not mean isolation.

When writing embedded pages for single components, it is critical to maintain the Diátaxis separation of modes. Do not mix rationale, setup steps, and API typings in unstructured prose. For small components, use strict H2 headers corresponding to the modes (e.g., `## Explanation`, `## Guide`, `## Reference`). For larger components, split the embedded files by mode (e.g., `logging-design.wiki.md` for Explanation and `logging-api.wiki.md` for Reference).

## What Belongs in the Wiki vs. Elsewhere

The wiki is not a better documentation system — it is a *different* kind of artifact. Its defining property is that fragment links structurally anchor prose to source code, making drift automatically detectable. This property determines what belongs.

Content belongs in the wiki when it:
- Can be anchored to specific source files with fragment links
- Synthesizes across files, packages, or subsystems rather than describing a single thing in isolation
- Answers "why" or "how it connects" rather than "what" — the code itself answers "what"
- Will remain relevant across multiple commits

Content belongs elsewhere when it:
- Cannot be anchored to source code (conceptual essays, external references, product philosophy)
- Describes a single function or file (this belongs in JSDoc or a package README, adjacent to the code)
- Is ephemeral — a completion checklist, a session report, a one-time runbook, an exploration that did not ship

This is a narrower inclusion criterion than most wikis apply. The narrowness is intentional: a wiki that includes everything becomes a documentation graveyard, where outdated pages outnumber current ones and search returns noise. The fragment link requirement is a forcing function that keeps the wiki bounded to content that can be actively maintained.


## Reorganization Signals

Structure should follow content patterns, not precede them. The right time to reorganize is when a concrete failure mode can be named — not preemptively, and not for aesthetic reasons.

[Nielsen Norman Group's research on information architecture](https://www.nngroup.com/articles/top-10-ia-mistakes/) identifies the most reliable reorganization signals as: orphaned pages (nothing links to them), duplicate or near-duplicate content (the structure failed to make the right home obvious), and navigation breakdown when content grows (the organizing principle was about quantity, not kind).

Translated to this wiki's tooling:

- `wiki [query]` for a concept returns partial matches across disconnected pages — the concept is fragmented; merge or add a hub
- A new page's correct location is genuinely ambiguous between two existing sections — the section boundaries are unclear; add a hub or sharpen the distinction
- A page has grown to cover two topics that would each be searched for independently — split it
- A subdirectory accumulates three or more pages with no overview — add a hub page

The test for reorganization is always the same: is a reader failing to find something, or finding the wrong thing? If yes, reorganize. If the structure merely looks untidy but readers can find what they need, leave it alone.

## The Role of Hub Pages

Hub pages are the primary navigation mechanism within `wiki/`. A hub page covers a domain broadly and links to leaf pages with wikilinks. It does not contain deep implementation detail.

Hub pages earn their place when a subdirectory has accumulated enough leaf pages that a reader needs orientation before choosing which page to read. Before that threshold, a subdirectory's implicit identity — `wiki/architecture/` contains architecture pages — is sufficient. Creating a hub page too early adds a page that says little and must be kept current for little benefit.

When a hub page does exist, it should be the canonical entry point for the domain. Other pages in the wiki that reference the domain should link to the hub, not directly to leaf pages, unless they need a specific leaf page.

## References

- [Diátaxis framework](https://diataxis.fr/) — the four-mode documentation model this wiki's category structure is built on
- [NN/G: Top 10 Information Architecture Mistakes](https://www.nngroup.com/articles/top-10-ia-mistakes/) — canonical reference for reorganization signals
- [NN/G: 6 Ways to Fix a Confused Information Architecture](https://www.nngroup.com/articles/fixing-information-architecture/) — repair strategies that map to the merge/split/hub actions in the wiki skill
- [GitBook: How to structure technical documentation](https://gitbook.com/docs/guides/docs-best-practices/documentation-structure-tips) — practical information architecture guidance
