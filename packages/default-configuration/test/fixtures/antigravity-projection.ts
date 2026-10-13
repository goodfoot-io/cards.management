/**
 * Captured Antigravity destination records shared by projection and cross-provider checks.
 * @summary Antigravity native projection test fixtures
 */
import { createHash } from 'node:crypto';

export const recordLine = (
  idx: number,
  stepType: number,
  status: number,
  content: string,
  anomaly: { kind: 'host-drift' | 'flush-partial' | 'format-unknown'; detail: string } | null = null
): string =>
  JSON.stringify({
    v: 1,
    idx,
    stepType,
    status,
    content,
    hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    anomaly
  });

/** Captured destination records exercise source order, duplicate replay and every named anomaly. */
export const nativeFixture = [
  recordLine(20, 15, 3, 'The answer is **42**.'),
  recordLine(10, 14, 3, 'What is the answer?'),
  recordLine(20, 15, 3, 'The answer is **42**.'),
  recordLine(30, 132, 3, '{"tool":"run_command","arguments":{"command":"echo ready"}}'),
  recordLine(31, 15, 3, 'The command reported `ready`.'),
  recordLine(40, 99, 3, 'captured future-step payload <script>alert(1)</script>'),
  recordLine(50, 132, 3, 'HIDDEN', { kind: 'format-unknown', detail: 'unwitnessed step_format 9' }),
  recordLine(60, 15, 1, 'partial response', { kind: 'flush-partial', detail: 'flushed before terminal state' }),
  recordLine(60, 15, 3, 'completed response'),
  recordLine(70, 15, 3, 'original response'),
  recordLine(70, 15, 3, 'revised response', { kind: 'host-drift', detail: 'step 70 changed after terminal emission' }),
  recordLine(-1, -1, -1, 'schema fingerprint changed', {
    kind: 'host-drift',
    detail: 'schema fingerprint changed'
  }),
  '{"v":2,"idx":80}',
  'not JSON'
];
