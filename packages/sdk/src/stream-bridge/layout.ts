/**
 * Host-side layout negotiation for one embedded session renderer, written as
 * DOM-free logic over an injected clock so hosts supply only the iframe,
 * visibility, and timeline container. Each load gets a new handshake token;
 * ready/size/scroll/anchor messages must carry it. A first measurement must
 * arrive within an accumulated visible-time budget, measurements are coalesced
 * to one application per animation frame while visible and applied at once
 * while hidden, and persistent growth/shrink oscillation stops with a visible
 * unstable-layout state instead of a feedback loop.
 * @summary Host layout handshake, deadline, coalescing, and oscillation logic
 * @module stream-bridge/layout
 */

import type { LayoutHandshakeMessage, LayoutRendererMessage, LayoutScrollCommand } from '../stream-store/types.js';

/** Accumulated visible milliseconds allowed before the first valid measurement. */
export const LAYOUT_FIRST_MEASURE_MS = 10_000;

/** Alternating growth/shrink applications tolerated without a quiet interval. */
export const LAYOUT_OSCILLATION_LIMIT = 120;

/** Gap between applications that resets oscillation counting. */
export const LAYOUT_QUIET_MS = 500;

/** Bound on anchors retained for revisions not yet applied. */
const MAX_PENDING_ANCHORS = 256;

/** Injectable time source and schedulers. */
export interface LayoutScheduler {
  /** Monotonic milliseconds. */
  now(): number;
  /** Schedules a one-shot timer and returns its cancellation. */
  timeout(callback: () => void, milliseconds: number): () => void;
  /** Schedules an animation frame and returns its cancellation. */
  frame(callback: () => void): () => void;
}

/** Layout negotiation progress for the current load. */
export type LayoutHostStatus = 'idle' | 'waiting' | 'measured' | 'timed-out' | 'unstable' | 'disposed';

/** Observable layout state; hosts render placeholder, measured height, or a visible error from it. */
export interface LayoutHostState {
  /** Negotiation progress. */
  status: LayoutHostStatus;
  /** View generation of the current load, or null before the first load. */
  generation: string | null;
  /** Current handshake token, or null when no load is active. */
  token: string | null;
  /** Whether the renderer acknowledged the handshake. */
  ready: boolean;
  /** Last applied height, or null before the first application. */
  height: number | null;
  /** Layout revision of the last applied height; 0 before any. */
  revision: number;
}

/** Host capabilities for one embedded renderer. */
export interface LayoutHostOptions {
  /** Injected clock and frame scheduler. */
  scheduler: LayoutScheduler;
  /** Creates an unguessable handshake token. */
  createToken(): string;
  /** Initial document visibility. */
  visible: boolean;
  /** Sends the handshake to the renderer of the current load. */
  post(message: LayoutHandshakeMessage): void;
  /** Applies a validated measured height to the iframe. */
  apply(height: number): void;
  /** Applies a validated scroll command to the outer timeline container. */
  scroll(command: LayoutScrollCommand): void;
  /** Compensates outer scroll so the renderer's anchored row stays in place. */
  adjust?(deltaY: number): void;
  /** Observes state transitions. */
  change?(state: LayoutHostState): void;
}

/** Layout negotiation for one embedded renderer across loads. */
export interface LayoutHost {
  /** Starts a new load generation: cancels all prior work, issues a new token, and posts the handshake. */
  load(generation: string): void;
  /** Accepts a validated renderer layout message; returns whether it matched the current load. */
  receive(message: LayoutRendererMessage): boolean;
  /** Pauses or resumes the first-measurement deadline and flushes a pending hidden measurement. */
  setVisible(visible: boolean): void;
  /** Current state snapshot. */
  getState(): LayoutHostState;
  /** Cancels every deadline and frame and rejects all later messages. */
  dispose(): void;
}

/**
 * Creates host layout negotiation over injected scheduling.
 * @param options - Scheduler, token source, and host capabilities.
 * @returns A layout host that is idle until its first load.
 */
export function createLayoutHost(options: LayoutHostOptions): LayoutHost {
  const { scheduler } = options;
  let state: LayoutHostState = {
    status: 'idle',
    generation: null,
    token: null,
    ready: false,
    height: null,
    revision: 0
  };
  let visible = options.visible;
  let remaining = LAYOUT_FIRST_MEASURE_MS;
  let armedAt: number | null = null;
  let cancelDeadline: (() => void) | null = null;
  let cancelFrame: (() => void) | null = null;
  let pending: { revision: number; height: number } | null = null;
  let received = 0;
  let anchors = new Map<number, number>();
  let direction = 0;
  let alternations = 0;
  let appliedAt: number | null = null;

  /**
   * Publishes a state transition.
   * @param patch - Changed fields.
   */
  function update(patch: Partial<LayoutHostState>): void {
    state = { ...state, ...patch };
    options.change?.({ ...state });
  }

  /** Stops the deadline, retaining unspent visible budget. */
  function disarm(): void {
    if (cancelDeadline) cancelDeadline();
    cancelDeadline = null;
    if (armedAt !== null) remaining = Math.max(0, remaining - (scheduler.now() - armedAt));
    armedAt = null;
  }

  /** Starts the deadline for the remaining visible budget. */
  function arm(): void {
    if (state.status !== 'waiting' || !visible || cancelDeadline) return;
    armedAt = scheduler.now();
    cancelDeadline = scheduler.timeout(() => {
      cancelDeadline = null;
      armedAt = null;
      remaining = 0;
      halt('timed-out');
    }, remaining);
  }

  /** Cancels all scheduled work for the current load. */
  function cancelAll(): void {
    disarm();
    if (cancelFrame) cancelFrame();
    cancelFrame = null;
    pending = null;
  }

  /**
   * Stops the current load in a terminal visible state.
   * @param status - Failure or disposal state.
   */
  function halt(status: 'timed-out' | 'unstable' | 'disposed'): void {
    cancelAll();
    anchors = new Map();
    update({ status, ...(status === 'disposed' ? { token: null } : {}) });
  }

  /** Applies the latest pending measurement, bounding oscillation. */
  function flush(): void {
    if (cancelFrame) cancelFrame();
    cancelFrame = null;
    const next = pending;
    pending = null;
    if (!next || state.status !== 'measured') return;
    const now = scheduler.now();
    if (appliedAt !== null && now - appliedAt >= LAYOUT_QUIET_MS) {
      direction = 0;
      alternations = 0;
    }
    appliedAt = now;
    const step = state.height === null ? 0 : Math.sign(next.height - state.height);
    if (step !== 0) {
      if (direction !== 0 && step !== direction) alternations++;
      direction = step;
    }
    if (alternations > LAYOUT_OSCILLATION_LIMIT) {
      halt('unstable');
      return;
    }
    let delta = 0;
    for (const [revision, value] of anchors) {
      if (revision > state.revision && revision <= next.revision) delta += value;
      if (revision <= next.revision) anchors.delete(revision);
    }
    options.apply(next.height);
    update({ height: next.height, revision: next.revision });
    if (delta !== 0) options.adjust?.(delta);
  }

  return {
    load(generation) {
      if (state.status === 'disposed') return;
      cancelAll();
      remaining = LAYOUT_FIRST_MEASURE_MS;
      received = 0;
      anchors = new Map();
      direction = 0;
      alternations = 0;
      appliedAt = null;
      const token = options.createToken();
      update({ status: 'waiting', generation, token, ready: false, height: null, revision: 0 });
      options.post({ type: 'layout:handshake', generation, token });
      arm();
    },
    receive(message) {
      const live = state.status === 'waiting' || state.status === 'measured';
      if (!live || message.generation !== state.generation || message.token !== state.token) return false;
      switch (message.type) {
        case 'layout:ready':
          if (!state.ready) update({ ready: true });
          return true;
        case 'layout:scroll':
          options.scroll(message.command);
          return true;
        case 'layout:anchor':
          if (message.revision <= state.revision) return false;
          anchors.set(message.revision, message.delta);
          if (anchors.size > MAX_PENDING_ANCHORS) {
            const oldest = Math.min(...anchors.keys());
            anchors.delete(oldest);
          }
          return true;
        case 'layout:size':
          if (message.revision <= received) return false;
          received = message.revision;
          pending = { revision: message.revision, height: message.height };
          if (state.status === 'waiting') {
            disarm();
            update({ status: 'measured' });
          }
          if (!visible) flush();
          else if (!cancelFrame) cancelFrame = scheduler.frame(flush);
          return true;
      }
    },
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      if (visible) arm();
      else {
        disarm();
        // Animation frames may be suspended while hidden; apply now.
        if (pending) flush();
      }
    },
    getState() {
      return { ...state };
    },
    dispose() {
      if (state.status !== 'disposed') halt('disposed');
    }
  };
}
