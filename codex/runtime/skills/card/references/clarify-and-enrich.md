
<instructions>

## 1. Triage Prior Clarification

Read the card description and comments in the card repository to understand the requirements and comment history.

Based on comments and prior clarification requests:

- **No existing "## Clarification Needed" comment**: Proceed to Step 2: Research and Enrich.

- **Existing clarification request AND later comment from non-agent author**: Write a comment acknowledging the new information and how it affects requirements analysis. Commit. Proceed to Step 4: Re-route After Enrichment.

  ```bash
  cd $CARD_REPO_PATH
  cat <<'EOF' > comments/clarification-received.md
  [acknowledge the new information and explain how it affects requirements analysis]
  EOF
  git add comments/clarification-received.md
  git commit -m "[single sentence summarizing the new information and how it affects requirements]"  # <card-repo-commit-style>
  ```

- **Existing clarification request AND no new user response**: **STOP**.

## 2. Research and Enrich

### 2.1 Research Workspace

Investigate the workspace to gather file paths, component names, and patterns relevant to the card. Fork subagents if the card touches areas you would otherwise sweep serially.

### 2.2 Enrich Card

Evaluate whether the title and description are clear enough and enrich them with context discovered during exploration.

**Clarify the title when** it is truncated, incomplete, or references the wrong component, file, or feature — plus, per type:

- **Implementation cards** — a good title completes: *"To finish this card, I need to [TITLE]"*. Clarify when it describes a symptom rather than the work (e.g., "Page is slow" -> "Optimize database queries") or does not start with an action verb.
- **Bug cards** — a good title describes behavior: *"[Component] fails when [action]"* or *"[Expected] but [actual]"*. Clarify when it describes implementation detail rather than observable behavior.

**Clarify the description when** it contains factual errors (wrong paths, incorrect component names), lacks context needed to begin work, or (bug cards) omits error messages or stack traces that are available.

**Enrich descriptions** with context discovered during exploration. Fragment-link every named file, function, and type per `<markdown-guidelines>`; use mermaid diagrams for multi-component interactions and data flows:
- Relevant file paths and component names
- Technical constraints or dependencies
- Acceptance criteria (if inferable from user intent)
- Bug cards: error messages, stack traces, and environment or configuration details (if relevant)

#### Principles

**Leave unchanged when:** Only minor phrasing or style preferences would change.

**When clarifying:**
- Preserve all user-provided details, requirements, constraints, error messages, and reproduction steps
- Maintain user intent — the clarified version must request the same outcome or describe the same bug
- Correct factual errors in the main text
- Do not expand scope beyond user intent

If changes are needed, update `CARD.meta.json` (for title) and/or `CARD.md` (for description) in the card repository per `<markdown-guidelines>`. Commit to the card repository:

```bash
cd $CARD_REPO_PATH
git add CARD.meta.json CARD.md
git commit -m "[single sentence summarizing what was corrected or enriched in the card]"  # <card-repo-commit-style>
```

Skip the commit entirely if no enrichment or clarification is needed.

## 3. Evaluate Readiness

### 3.1 Check Definition of Ready

Mark as MISSING if not present or inferable from card description, comments, and exploration:

- **Commander's intent**: What this change should achieve and why
- **Acceptance criteria**: Testable completion conditions
- **Dependencies**: Blockers or prerequisites
- **Technical feasibility**: Enough detail to determine approach
- **Unanswered questions**: All comment questions answered

**All met (DOR satisfied)**: Proceed to Step 4: Re-route After Enrichment.

### 3.2 Research Context

Research the workspace:
1. Look for similar implementations
2. Check tests for expected behavior
3. Identify relevant file paths for code references

- **Research resolves all gaps**: Enrich `CARD.md` with the resolved requirements per Step 2.2 and commit. Proceed to Step 4: Re-route After Enrichment.

### 3.3 Request Clarification

Write a comment presenting specific questions needed to proceed. Prioritize by what is most blocking, explain why each is needed, and reference relevant workspace code.

```bash
cd $CARD_REPO_PATH
cat <<'EOF' > comments/clarification-request.md
[specific questions needed to proceed, prioritized by what is most blocking, with explanation of why each is needed and references to relevant workspace code]
EOF
git add comments/clarification-request.md
git commit -m "[single sentence summarizing which requirements are missing and what is needed to proceed]"  # <card-repo-commit-style>
```

**STOP** — awaiting user response.

## 4. Re-route After Enrichment

Use the `$runtime:card` skill to re-evaluate the card's state and route to the appropriate next reference. On this second pass, skip the NOT DOR_MET route — enrichment has already been attempted this session.

</instructions>
