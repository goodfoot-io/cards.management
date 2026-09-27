/**
 * Pure classifier for attachment payloads.
 *
 * Converts a parsed `AttachmentPayload` into an `AttachmentDescriptor` that
 * encodes the render-or-hide decision, scope, tier, glyph, summary, and
 * linkPath without any React dependency. Presenters consume the descriptor
 * and apply styling — all meaning is derived here.
 *
 * @summary Pure render-or-hide classifier for attachment payloads
 * @module lib/classify-attachment
 */

import type {
  AgentListingDeltaAttachment,
  AttachmentPayload,
  CommandPermissionsAttachment,
  CompactFileReferenceAttachment,
  DateChangeAttachment,
  DeferredToolsDeltaAttachment,
  DynamicSkillAttachment,
  EditedTextFileAttachment,
  FileAttachment,
  HookAdditionalContextAttachment,
  HookBlockingErrorAttachment,
  HookCancelledAttachment,
  HookNonBlockingErrorAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment,
  InvokedSkillsAttachment,
  McpInstructionsDeltaAttachment,
  NestedMemoryAttachment,
  OpenedFileInIdeAttachment,
  QueuedCommandAttachment,
  SelectedLinesInIdeAttachment,
  SkillListingAttachment,
  TaskReminderAttachment,
  TeamContextAttachment
} from './parse-session.js';

// ============================================================================
// Descriptor types — the load-bearing classifier contract
// ============================================================================

/**
 * Placement scope for an attachment row.
 *
 * - `'tool'`    — associated with the native tool call identified by toolUseID.
 * - `'turn'`    — belongs to the active turn; ambient entries may be grouped.
 * - `'session'` — belongs to the session-level timeline.
 */
export type AttachmentScope = 'tool' | 'turn' | 'session';

/**
 * Visual weight tier within the expanded transcript.
 *
 * - `'content'`  — full-content presentation weight.
 * - `'ambient'`  — quieter context weight; consecutive entries can be grouped.
 */
export type AttachmentTier = 'content' | 'ambient';

/**
 * Severity level for the row's left-edge glyph.
 *
 * - `'neutral'`  — informational; no color.
 * - `'warning'`  — non-blocking problem; uses `warningForeground`.
 * - `'error'`    — blocking or fatal problem; uses `errorForeground`.
 */
export type AttachmentGlyphSeverity = 'neutral' | 'warning' | 'error';

/**
 * The output of `classifyAttachment` — everything the native projector and
 * presenter need to retain attachment meaning without re-deriving it.
 *
 * @summary Classifier output consumed by the native projector and presenter
 */
export interface AttachmentDescriptor {
  /**
   * Discriminator copied from `attachment.type`; used by the native presenter.
   * Unknown types produce `'__unknown__'` and keep their original payload for
   * the raw-details disclosure.
   */
  kind: string;
  /** Placement scope for this row. */
  scope: AttachmentScope;
  /** Visual weight tier within the turn timeline. */
  tier: AttachmentTier;
  /**
   * Collapsed one-line summary, already interpolated
   * (e.g. `"Memory · CLAUDE.md"`).
   */
  summary: string;
  /**
   * Left-edge glyph character or short text-tag
   * (e.g. `'✓'`, `'!'`, `'✗'`, `'○'`, `'·'`, `'context'`).
   * Absent when the type has no designated glyph.
   */
  glyph?: string;
  /** Severity driving the glyph color token. */
  glyphSeverity: AttachmentGlyphSeverity;
  /**
   * When `true`, render nothing for this attachment.
   * The fail-closed hide decision lives here — a hide fires only when its
   * emptiness condition is provably met; any populated payload renders.
   */
  hidden: boolean;
  /**
   * For `scope === 'tool'`: the `toolUseID` to nest this row under.
   * Undefined for all other scopes.
   */
  toolUseID?: string;
  /**
   * Workspace-relative path to linkify in the summary
   * (`displayPath ?? filename`).  Absent when no path is available or
   * relevant.
   */
  linkPath?: string;
  /**
   * `true` when the row has an expandable body (e.g. hook stdout, file
   * snippet, memory content).  `false` for leaf rows with no body.
   */
  expandable: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Returns the last path segment of a POSIX-style path string.
 * Used to produce short human-readable filenames in summaries.
 *
 * @param path - An absolute or relative file path.
 * @returns The basename (final segment after the last `/`).
 */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Truncates a string to at most `maxLen` characters, appending `…` if cut.
 *
 * @param s - Input string.
 * @param maxLen - Maximum character count before truncation.
 * @returns Possibly-truncated string.
 */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

// ============================================================================
// Classifier implementation
// ============================================================================

/**
 * Classifies a parsed attachment payload into an `AttachmentDescriptor`.
 *
 * Decides: scope, tier, glyph/severity, one-line summary, hide predicate,
 * toolUseID, linkPath, and expandability. Unknown `attachment.type` values
 * return a descriptor with `kind: '__unknown__'`; the native projection keeps
 * the source payload inspectable.
 *
 * @param attachment - Parsed attachment payload from a JSONL line.
 * @returns Descriptor encoding the render-or-hide decision and all metadata.
 *
 * @summary Pure render-or-hide classifier for attachment payloads
 */
export function classifyAttachment(attachment: AttachmentPayload): AttachmentDescriptor {
  switch (attachment.type) {
    // -------------------------------------------------------------------------
    // Hook types — scope: tool, tier: content
    // -------------------------------------------------------------------------

    case 'hook_success': {
      const a = attachment as HookSuccessAttachment;
      return {
        kind: 'hook_success',
        scope: 'tool',
        tier: 'content',
        glyph: '✓',
        glyphSeverity: 'neutral',
        summary: `${a.hookName} (${a.hookEvent})`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: true
      };
    }

    case 'hook_additional_context': {
      const a = attachment as HookAdditionalContextAttachment;
      return {
        kind: 'hook_additional_context',
        scope: 'tool',
        tier: 'content',
        glyph: 'context',
        glyphSeverity: 'neutral',
        summary: `context · ${a.hookName}`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: true
      };
    }

    case 'hook_system_message': {
      const a = attachment as HookSystemMessageAttachment;
      return {
        kind: 'hook_system_message',
        scope: 'tool',
        tier: 'content',
        glyph: 'message',
        glyphSeverity: 'neutral',
        summary: `message · ${a.hookName}`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: true
      };
    }

    case 'hook_non_blocking_error': {
      const a = attachment as HookNonBlockingErrorAttachment;
      return {
        kind: 'hook_non_blocking_error',
        scope: 'tool',
        tier: 'content',
        glyph: '!',
        glyphSeverity: 'warning',
        summary: `${a.hookName} (non-blocking)`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: true
      };
    }

    case 'hook_blocking_error': {
      const a = attachment as HookBlockingErrorAttachment;
      return {
        kind: 'hook_blocking_error',
        scope: 'tool',
        tier: 'content',
        glyph: '✗',
        glyphSeverity: 'error',
        summary: `${a.hookName} blocked`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: true
      };
    }

    case 'hook_cancelled': {
      const a = attachment as HookCancelledAttachment;
      return {
        kind: 'hook_cancelled',
        scope: 'tool',
        tier: 'content',
        glyph: '○',
        glyphSeverity: 'neutral',
        summary: `${a.hookName} cancelled`,
        hidden: false,
        toolUseID: a.toolUseID,
        expandable: false
      };
    }

    // -------------------------------------------------------------------------
    // Ambient turn-scoped types
    // -------------------------------------------------------------------------

    case 'team_context': {
      const a = attachment as TeamContextAttachment;
      const teamName = a.teamName ?? '';
      const agentName = a.agentName ?? '';
      return {
        kind: 'team_context',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `Team ${teamName} · ${agentName}`,
        hidden: false,
        expandable: false
      };
    }

    case 'command_permissions': {
      const a = attachment as CommandPermissionsAttachment;
      const count = a.allowedTools.length;
      const hidden = count === 0;
      return {
        kind: 'command_permissions',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `Permissions: ${count} tools allowed`,
        hidden,
        expandable: true
      };
    }

    case 'deferred_tools_delta': {
      const a = attachment as DeferredToolsDeltaAttachment;
      const added = a.addedNames ?? [];
      const readded = a.readdedNames ?? [];
      const removed = a.removedNames ?? [];
      const hidden = added.length === 0 && readded.length === 0 && removed.length === 0;
      const addedCount = added.length + readded.length;
      const removedCount = removed.length;
      return {
        kind: 'deferred_tools_delta',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `Tools available +${addedCount} −${removedCount}`,
        hidden,
        expandable: true
      };
    }

    case 'mcp_instructions_delta': {
      const a = attachment as McpInstructionsDeltaAttachment;
      const names = a.addedNames ?? [];
      return {
        kind: 'mcp_instructions_delta',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `MCP instructions +${names.join(', ')}`,
        hidden: false,
        expandable: true
      };
    }

    case 'agent_listing_delta': {
      const a = attachment as AgentListingDeltaAttachment;
      const added = a.addedTypes ?? [];
      const removed = a.removedTypes ?? [];
      const hidden = added.length === 0 && removed.length === 0;
      return {
        kind: 'agent_listing_delta',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `Agents available +${added.length} −${removed.length}`,
        hidden,
        expandable: true
      };
    }

    case 'task_reminder': {
      const a = attachment as TaskReminderAttachment;
      const itemCount = a.itemCount ?? 0;
      const hidden = itemCount === 0;
      return {
        kind: 'task_reminder',
        scope: 'turn',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: `Tasks pending · ${itemCount}`,
        hidden,
        expandable: true
      };
    }

    case 'compact_file_reference': {
      const a = attachment as CompactFileReferenceAttachment;
      const linkPath = a.displayPath ?? a.filename;
      const displayName = linkPath ?? '';
      return {
        kind: 'compact_file_reference',
        scope: 'turn',
        tier: 'ambient',
        glyph: '·',
        glyphSeverity: 'neutral',
        summary: displayName,
        hidden: false,
        linkPath,
        expandable: false
      };
    }

    case 'opened_file_in_ide': {
      const a = attachment as OpenedFileInIdeAttachment;
      return {
        kind: 'opened_file_in_ide',
        scope: 'turn',
        tier: 'ambient',
        glyph: '·',
        glyphSeverity: 'neutral',
        summary: `opened ${basename(a.filename ?? '')}`,
        hidden: false,
        expandable: false
      };
    }

    case 'selected_lines_in_ide': {
      const a = attachment as SelectedLinesInIdeAttachment;
      const linkPath = a.displayPath ?? a.filename;
      const name = basename(a.filename ?? '');
      const lineStart = a.lineStart ?? 0;
      const lineEnd = a.lineEnd ?? 0;
      return {
        kind: 'selected_lines_in_ide',
        scope: 'turn',
        tier: 'ambient',
        glyph: '·',
        glyphSeverity: 'neutral',
        summary: `${name} :${lineStart}–${lineEnd}`,
        hidden: false,
        linkPath,
        // The payload carries the selected source text in `content`; the leaf
        // header stays a `·` reference, but it opens to that content on click.
        expandable: true
      };
    }

    // -------------------------------------------------------------------------
    // Content turn-scoped types
    // -------------------------------------------------------------------------

    case 'nested_memory': {
      const a = attachment as NestedMemoryAttachment;
      const linkPath = a.displayPath ?? a.path;
      const name = basename(linkPath ?? a.path ?? '');
      return {
        kind: 'nested_memory',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `Memory · ${name}`,
        hidden: false,
        linkPath,
        expandable: true
      };
    }

    case 'skill_listing': {
      const a = attachment as SkillListingAttachment;
      const skillCount = a.skillCount ?? 0;
      return {
        kind: 'skill_listing',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `Skills available · ${skillCount}`,
        hidden: false,
        expandable: true
      };
    }

    case 'invoked_skills': {
      const a = attachment as InvokedSkillsAttachment;
      const count = a.skills?.length ?? 0;
      return {
        kind: 'invoked_skills',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `Skills loaded · ${count}`,
        hidden: false,
        expandable: true
      };
    }

    case 'dynamic_skill': {
      const a = attachment as DynamicSkillAttachment;
      return {
        kind: 'dynamic_skill',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `Dynamic skills · ${a.displayPath ?? a.skillDir ?? ''}`,
        hidden: false,
        expandable: false
      };
    }

    case 'file': {
      const a = attachment as FileAttachment;
      const linkPath = a.displayPath ?? a.filename;
      const name = basename(linkPath ?? a.filename ?? '');
      return {
        kind: 'file',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: name,
        hidden: false,
        linkPath,
        expandable: true
      };
    }

    case 'edited_text_file': {
      const a = attachment as EditedTextFileAttachment;
      const name = basename(a.filename ?? '');
      return {
        kind: 'edited_text_file',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `${name} edited`,
        hidden: false,
        expandable: true
      };
    }

    case 'queued_command': {
      const a = attachment as QueuedCommandAttachment;
      const prompt = truncate(a.prompt ?? '', 60);
      return {
        kind: 'queued_command',
        scope: 'turn',
        tier: 'content',
        glyph: '⏎',
        glyphSeverity: 'neutral',
        summary: `queued: "${prompt}"`,
        hidden: false,
        expandable: false
      };
    }

    // -------------------------------------------------------------------------
    // Session-scoped types
    // -------------------------------------------------------------------------

    case 'date_change': {
      const a = attachment as DateChangeAttachment;
      return {
        kind: 'date_change',
        scope: 'session',
        tier: 'ambient',
        glyphSeverity: 'neutral',
        summary: a.newDate ?? '',
        hidden: false,
        expandable: false
      };
    }

    // -------------------------------------------------------------------------
    // Unknown / future type sentinel
    // -------------------------------------------------------------------------

    default:
      return {
        kind: '__unknown__',
        scope: 'turn',
        tier: 'content',
        glyphSeverity: 'neutral',
        summary: `unknown attachment: ${(attachment as { type: string }).type}`,
        hidden: false,
        expandable: false
      };
  }
}
