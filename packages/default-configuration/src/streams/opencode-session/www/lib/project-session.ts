/**
 * OpenCode native transcript projection contract.
 * @summary OpenCode-owned semantic rows before Cards rendering
 * @module streams/opencode-session/www/lib/project-session
 */

import type { NativeTranscriptProjector } from '../../../lib/session/projection';
import type { SessionPart, SessionRow } from '../../../lib/session/types';
import type { OpencodeLine } from './parser';

/** Native session identity and exporter facts kept outside conversation prose. */
export interface OpencodeSessionData {
  readonly sessionId?: string;
  readonly runtime?: string;
  readonly version?: string;
}

/** Message info retained for model, path, timing, token, agent, and mode details. */
export interface OpencodeMessageDetailsData {
  readonly messageId: string;
  readonly model?: string;
  readonly provider?: string;
  readonly agent?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly created?: number;
  readonly completed?: number;
  readonly tokens?: { readonly input?: number; readonly output?: number };
  readonly raw: string;
}

/** OpenCode `file` part summary; its native URL is retained but never activated. */
export interface OpencodeAttachmentData {
  readonly filename: string;
  readonly mime?: string;
  readonly url?: string;
}

/** OpenCode `patch` part summary; full native details remain inspectable separately. */
export interface OpencodeEditedFilesData {
  readonly files: readonly string[];
  readonly hash?: string;
}

/** Visible boundary marker for OpenCode model steps. */
export interface OpencodeStepData {
  readonly type: 'step-start' | 'step-finish';
  readonly label: string;
  readonly raw: string;
}

/** Inspectable native event or part that this renderer does not yet interpret. */
export interface OpencodeEventData {
  readonly label: string;
  readonly tone: 'info' | 'error';
  readonly nativeType?: string;
  readonly raw: string;
}

/** Typed OpenCode presentation payloads; no assistant-ui or vendor message types. */
export interface OpencodePayloads {
  readonly session: OpencodeSessionData;
  readonly messageDetails: OpencodeMessageDetailsData;
  readonly attachment: OpencodeAttachmentData;
  readonly editedFiles: OpencodeEditedFilesData;
  readonly step: OpencodeStepData;
  readonly event: OpencodeEventData;
}

/** Cards-owned OpenCode rows and shared/provider parts. */
export type OpencodeRow = SessionRow<OpencodePayloads>;

/** Cards-owned OpenCode semantic leaves. */
export type OpencodePart = SessionPart<OpencodePayloads>;

type OpencodeState = Record<string, never>;

/**
 * Reducer contract for native OpenCode envelopes; implementation follows the fixture assertions.
 */
export const opencodeSessionProjector: NativeTranscriptProjector<OpencodeState, OpencodeLine, OpencodePayloads> = {
  providerId: 'opencode',
  createState: () => ({}),
  parseRecord: () => {
    throw new Error('Not Implemented');
  },
  reduce: () => {
    throw new Error('Not Implemented');
  },
  project: () => {
    throw new Error('Not Implemented');
  }
};
