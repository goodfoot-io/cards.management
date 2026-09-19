# Spike

Frame one concrete, executable question and a stopping condition. Questions settled by reading do not need a spike.

Create `$CARD_REPO_PATH/spike/<slug>/`. Keep scratch scripts, fixtures, and captured output there, never in product code. Run the smallest safe experiment that answers the question; do not polish it or broaden to a second question.

Write `notes/<slug>.md` in the card repository with the question, answer, command/environment, concrete output, artifact path, and implementation impact. Add a `notes/<slug>.md.meta.json` sidecar with a one-sentence `summary`. Commit the note and repeatable, non-secret artifacts.

[Reroute](./implementation.md) using the evidence. If the result invalidates the approach, [reconsider](./reconsider-approach.md); if inconclusive, record what remains unknown instead of treating it as proof.
