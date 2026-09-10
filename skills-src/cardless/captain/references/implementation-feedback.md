# Triage Implementation Feedback

Read new conversation input, the brief, current/prior plans, progress and source commits. Feedback must name an actionable change or an inferable outcome. Research ambiguity; if the requirement remains indeterminate, read `./blocked.md`.

Use the same triage as a code review:

- A trivial correction affects one or two lines, has an obvious solution, and introduces no new interface or broader behavior: save it as a pending follow-up unit in `session.md`, including the requested change, acceptance condition and relevant validation. Then read `./implementation.md`; a fully completed prior plan does not consume this new unit.
- A different approach, added scope, structural concern, cross-file change or uncertain solution: read `./plan.md` and create a follow-on plan.

Record which pending unit or follow-on plan owns the processed feedback and preserve prior completed work. Mark the unit completed only after its change and validation are committed. A delivered branch may already be pushed: do not reset or rewrite published commits when addressing follow-up work. Review and validate the resulting HEAD before updating the same open PR.
