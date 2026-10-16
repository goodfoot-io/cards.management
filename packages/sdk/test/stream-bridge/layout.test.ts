/**
 * Host layout negotiation over a deterministic clock: handshake tokens, the
 * accumulated-visible first-measurement deadline, frame coalescing, anchor
 * compensation, oscillation bounding, and cancellation.
 * @summary Host layout negotiation checks
 */
import { describe, expect, it } from 'vitest';
import {
  createLayoutHost,
  LAYOUT_FIRST_MEASURE_MS,
  LAYOUT_OSCILLATION_LIMIT,
  LAYOUT_QUIET_MS,
  type LayoutHost,
  type LayoutHostState
} from '../../src/stream-bridge/index.js';
import type { LayoutHandshakeMessage, LayoutScrollCommand } from '../../src/stream-store/index.js';

/** Deterministic clock with ordered timers and manually run frames. */
class FakeClock {
  time = 0;
  timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  frames: Array<{ run: () => void; live: boolean }> = [];

  now = (): number => this.time;

  timeout = (run: () => void, milliseconds: number): (() => void) => {
    const timer = { at: this.time + milliseconds, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  frame = (run: () => void): (() => void) => {
    const frame = { run, live: true };
    this.frames.push(frame);
    return () => {
      frame.live = false;
    };
  };

  /**
   * Advances time, firing due timers in order.
   * @param milliseconds - Elapsed time.
   */
  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const due = this.timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = due.at;
      due.live = false;
      due.run();
    }
    this.time = end;
  }

  /** Runs every scheduled frame once. */
  runFrames(): void {
    const frames = this.frames;
    this.frames = [];
    for (const frame of frames) if (frame.live) frame.run();
  }

  /**
   * Counts uncancelled scheduled work.
   * @returns Live timers plus live frames.
   */
  pending(): number {
    return this.timers.filter((timer) => timer.live).length + this.frames.filter((frame) => frame.live).length;
  }
}

/** Layout host and observed effects. */
interface LayoutRig {
  clock: FakeClock;
  host: LayoutHost;
  handshakes: LayoutHandshakeMessage[];
  heights: number[];
  scrolls: LayoutScrollCommand[];
  adjustments: number[];
  states: LayoutHostState[];
}

/**
 * Creates a layout host over a fake clock.
 * @param visible - Initial visibility.
 * @returns Rig with no load started.
 */
function layoutRig(visible = true): LayoutRig {
  const clock = new FakeClock();
  const handshakes: LayoutHandshakeMessage[] = [];
  const heights: number[] = [];
  const scrolls: LayoutScrollCommand[] = [];
  const adjustments: number[] = [];
  const states: LayoutHostState[] = [];
  let tokens = 0;
  const host = createLayoutHost({
    scheduler: clock,
    createToken: () => `token-${++tokens}`,
    visible,
    post: (message) => handshakes.push(message),
    apply: (height) => heights.push(height),
    scroll: (command) => scrolls.push(command),
    adjust: (delta) => adjustments.push(delta),
    change: (state) => states.push(state)
  });
  return { clock, host, handshakes, heights, scrolls, adjustments, states };
}

/**
 * Builds a size report for the current token.
 * @param host - Layout host.
 * @param revision - Layout revision.
 * @param height - Measured height.
 * @returns Size message.
 */
function size(host: LayoutHost, revision: number, height: number) {
  const { generation, token } = host.getState();
  return { type: 'layout:size' as const, generation: generation ?? '', token: token ?? '', revision, height };
}

describe('handshake and first-measurement deadline', () => {
  it('issues a fresh token per load and times out without a first report', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    expect(r.handshakes).toEqual([{ type: 'layout:handshake', generation: 'gen-1', token: 'token-1' }]);
    expect(r.host.getState()).toMatchObject({ status: 'waiting', ready: false, height: null });
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS - 1);
    expect(r.host.getState().status).toBe('waiting');
    r.clock.advance(1);
    expect(r.host.getState().status).toBe('timed-out');
    expect(r.host.receive(size(r.host, 1, 100))).toBe(false);
    expect(r.heights).toEqual([]);
  });

  it('counts only visible time and restores the remaining budget', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    r.clock.advance(4_000);
    r.host.setVisible(false);
    r.clock.advance(60_000);
    expect(r.host.getState().status).toBe('waiting');
    r.host.setVisible(true);
    r.clock.advance(5_999);
    expect(r.host.getState().status).toBe('waiting');
    r.clock.advance(1);
    expect(r.host.getState().status).toBe('timed-out');
  });

  it('never arms while loaded hidden and applies a hidden report immediately', () => {
    const r = layoutRig(false);
    r.host.load('gen-1');
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS * 3);
    expect(r.host.receive({ type: 'layout:ready', generation: 'gen-1', token: 'token-1' })).toBe(true);
    expect(r.host.receive(size(r.host, 1, 240))).toBe(true);
    expect(r.heights).toEqual([240]);
    expect(r.host.getState()).toMatchObject({ status: 'measured', ready: true, height: 240, revision: 1 });
    expect(r.clock.pending()).toBe(0);
  });

  it('rejects stale tokens, generations, and reports from before a retry', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    const stale = size(r.host, 1, 100);
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS);
    expect(r.host.getState().status).toBe('timed-out');
    r.host.load('gen-1');
    expect(r.host.getState()).toMatchObject({ status: 'waiting', token: 'token-2' });
    expect(r.host.receive(stale)).toBe(false);
    expect(r.host.receive({ ...size(r.host, 1, 100), generation: 'gen-0' })).toBe(false);
    expect(r.host.receive({ ...size(r.host, 1, 100), token: 'forged' })).toBe(false);
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS - 1);
    expect(r.host.getState().status).toBe('waiting');
    expect(r.host.receive(size(r.host, 1, 100))).toBe(true);
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS);
    expect(r.host.getState().status).toBe('measured');
  });
});

describe('measurement application', () => {
  it('coalesces visible reports to the latest per frame and drops non-increasing revisions', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    expect(r.host.receive(size(r.host, 1, 100))).toBe(true);
    expect(r.host.receive(size(r.host, 2, 150))).toBe(true);
    expect(r.host.receive(size(r.host, 2, 999))).toBe(false);
    expect(r.heights).toEqual([]);
    r.clock.runFrames();
    expect(r.heights).toEqual([150]);
    expect(r.host.getState()).toMatchObject({ height: 150, revision: 2 });
    expect(r.host.receive(size(r.host, 1, 50))).toBe(false);
  });

  it('flushes a pending visible report when the document becomes hidden', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    r.host.receive(size(r.host, 1, 100));
    r.host.setVisible(false);
    expect(r.heights).toEqual([100]);
    r.clock.runFrames();
    expect(r.heights).toEqual([100]);
  });

  it('compensates outer scroll by the anchors of the applied revisions', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    const { token } = r.host.getState();
    const anchor = (revision: number, delta: number) =>
      r.host.receive({ type: 'layout:anchor', generation: 'gen-1', token: token ?? '', revision, key: 'row-7', delta });
    expect(anchor(1, 20)).toBe(true);
    r.host.receive(size(r.host, 1, 100));
    r.clock.runFrames();
    expect(r.adjustments).toEqual([20]);
    expect(anchor(1, 5)).toBe(false);
    anchor(2, 10);
    anchor(3, -4);
    r.host.receive(size(r.host, 2, 110));
    r.host.receive(size(r.host, 3, 106));
    r.clock.runFrames();
    expect(r.heights).toEqual([100, 106]);
    expect(r.adjustments).toEqual([20, 6]);
  });

  it('forwards scroll commands only for the current token', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    const command: LayoutScrollCommand = { kind: 'delta', deltaY: 40 };
    expect(r.host.receive({ type: 'layout:scroll', generation: 'gen-1', token: 'token-1', command })).toBe(true);
    expect(r.host.receive({ type: 'layout:scroll', generation: 'gen-1', token: 'token-0', command })).toBe(false);
    expect(r.scrolls).toEqual([command]);
  });
});

describe('oscillation bound', () => {
  /**
   * Applies alternating heights one frame apart.
   * @param r - Layout rig.
   * @param count - Number of applications.
   * @param gap - Milliseconds between applications.
   */
  function oscillate(r: LayoutRig, count: number, gap: number): void {
    const start = r.host.getState().revision;
    for (let index = 1; index <= count; index++) {
      r.host.receive(size(r.host, start + index, index % 2 === 0 ? 100 : 200));
      r.clock.runFrames();
      r.clock.advance(gap);
    }
  }

  it('stops with an unstable state after persistent alternation', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    oscillate(r, LAYOUT_OSCILLATION_LIMIT + 2, 16);
    expect(r.host.getState().status).toBe('measured');
    oscillate(r, 1, 16);
    expect(r.host.getState().status).toBe('unstable');
    const applied = r.heights.length;
    expect(r.host.receive(size(r.host, 10_000, 300))).toBe(false);
    r.clock.runFrames();
    expect(r.heights).toHaveLength(applied);
    expect(r.clock.pending()).toBe(0);
  });

  it('tolerates alternation separated by quiet intervals', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    oscillate(r, LAYOUT_OSCILLATION_LIMIT * 3, LAYOUT_QUIET_MS);
    expect(r.host.getState().status).toBe('measured');
  });

  it('retries cleanly after instability', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    oscillate(r, LAYOUT_OSCILLATION_LIMIT + 3, 16);
    expect(r.host.getState().status).toBe('unstable');
    r.host.load('gen-1');
    oscillate(r, LAYOUT_OSCILLATION_LIMIT, 16);
    expect(r.host.getState()).toMatchObject({ status: 'measured', token: 'token-2' });
  });
});

describe('dispose', () => {
  it('cancels the deadline and pending frame and rejects later work', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    r.host.receive(size(r.host, 1, 100));
    const message = size(r.host, 2, 120);
    r.host.dispose();
    expect(r.clock.pending()).toBe(0);
    r.clock.runFrames();
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS * 2);
    expect(r.heights).toEqual([]);
    expect(r.host.receive(message)).toBe(false);
    r.host.load('gen-2');
    expect(r.handshakes).toHaveLength(1);
    expect(r.host.getState()).toMatchObject({ status: 'disposed', token: null });
    expect(r.states.at(-1)?.status).toBe('disposed');
  });

  it('a waiting dispose never times out', () => {
    const r = layoutRig();
    r.host.load('gen-1');
    r.host.dispose();
    r.clock.advance(LAYOUT_FIRST_MEASURE_MS * 2);
    expect(r.host.getState().status).toBe('disposed');
  });
});
