---
name: tdd-bootstrap
description: Three-phase bootstrap for new behavior — define the contract, write skipped checks against it, then implement and unskip.
---

<tdd-bootstrap>

Bootstrap new behavior in three phases when the contract is worth validating ahead of implementation. Each phase produces an artifact the next consumes.

The phases apply in any environment with types, lint, and tests — whether the target is code, a schema, a config artifact, or another domain with an analogous validation stack.

## When to Apply

Good fits:

- **New pure function, transformer, parser, validator, or formatter** — inputs and outputs are enumerable; the contract is the whole design
- **New public API surface** (module export, endpoint, RPC handler, CLI command) — signature and error shape are load-bearing
- **New data type with derived operations** — constructor, serializer, state machine; the type and its standard derives are half the design
- **New algorithm with assertable properties** — round-trip, identity, idempotence, ordering
- **New schema-shaped artifact** (JSON schema, protobuf, migration shape, config file format) — the types generalization is strong

Bad fits — skip the bootstrap and use the default workflow:

- **Bug fixes** — reproduction-first is the correct order
- **Pure refactors** — no new behavior; existing checks are the contract
- **Exploratory spikes** — the contract itself is the unknown
- **UI or visual work** — the contract is a visual experience, not a signature
- **Glue or integration code composing existing pieces** — the stub would prove nothing new
- **Framework-determined shapes** (another handler, reducer, route in an existing pattern) — Phase 1 is a no-op
- **One-shot scripts and migrations** — success is observed end-to-end
- **Config, documentation, and copy changes** — no executable contract to stub
- **Small, localized edits inside existing functions** — ceremony exceeds the signal
- **Performance or observability changes** — the contract is deliberately unchanged
- **Heavy-IO or non-deterministic domains where fixtures dominate** — the real environment must come first

## Phase 1: Contract and Stubs

Declare the shape first. Create the type, interface, schema, or signature for every new surface, then create stubs that typecheck but do no work.

- Declare input and output types explicitly — do not infer from implementation
- Export stubs with the final signature
- Return a not-implemented sentinel from every stub body — `throw new Error('Not Implemented')`, `todo!()`, `raise NotImplementedError`, a handler that returns `501`, a schema that rejects everything, whichever the domain provides
- Add the standard derives or annotations the type needs (equality, debug/display, serialization) — the checks in Phase 2 will force the rest
- Run lint and typecheck before moving on — the stub file must be clean

## Phase 2: Skipped Checks

Write acceptance checks against the stubs. Mark every check skipped with the framework's skip primitive (`it.skip`, `#[ignore]`, `@pytest.mark.skip`, `xit`, or the equivalent).

- Cover expected behavior, error paths, and edge cases — skipped checks are the executable form of the specification
- Run lint and typecheck against the check file — a skipped check that does not compile is still broken
- Run the new check file — every new check must appear as pending, not failing or erroring
- Commit once the check file is clean against the stubs

This is the payoff phase. The check code exercises the stubs as a consumer would, so contract ergonomics — awkward lifetimes, missing derives, impossible bounds, clumsy argument order — surface here, before implementation effort is sunk into the wrong shape.

## Phase 3: Implement and Unskip

Unskip one check, run it, watch it fail against the stub, then implement the minimum to pass. Repeat until no skipped checks remain.

- Unskip in small batches — one concern at a time
- Follow the captain-supplied validation conventions. Re-run the single check just unskipped until it passes; once green, run the file's unskipped checks together before moving to the next
- Refactor only after the check passes
- New behavior discovered mid-implementation goes back to Phase 1 for its own contract — do not broaden scope inline

Bootstrap is complete when every check is unskipped and passing and lint and typecheck are clean.

</tdd-bootstrap>
