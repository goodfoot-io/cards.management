---
title: "Wiki Organization"
summary: "Reader-job separation and authoritative ownership of Cards documentation."
doc-kind: reference
owner: Cards maintainers
review-status: verified
reviewed-on: 2026-09-17
reviewed-source: fe52e80a2ca8958af557d7e147ed6ea37fc0f367
---

# Wiki organization

The central [Cards Wiki](/wiki/README.md) separates implementation reference, architecture, operating guides, planning, marketing, and historical archives. Component-local `*.wiki.md` pages remain beside their implementation; cross-package questions belong in the central wiki.

Current facts have one owner. Marketing may interpret them but links to their reference rather than maintaining another technical contract. Proposed designs and dated research remain useful only when their status is visible in summaries and navigation. A source fragment becoming healthy does not certify the surrounding prose.

[Wiki maintenance](/wiki/meta/wiki-maintenance.md) defines semantic review metadata, generated inventories, page moves, and validation. [Wiki CLI](/wiki/meta/wiki-cli.md) documents the installed tool's actual interface. There is no local `packages/wiki` implementation and no requirement to invoke retired pin or stale commands.
