import { describe, expect, it } from 'vitest';
import { resumeAckPayloadSchema, resumePayloadSchema } from '../../../src/protocol/types/runtime-messages.js';
import { MAX_OUTSTANDING_MESSAGES } from '../../../src/protocol/types/runtime-transport.js';

/**
 * Exercises the payload schemas that guard the resume handshake.
 * The cases pin the acknowledgment to the same bound as the request it answers, so a client cannot
 * be handed a larger list than it is allowed to send, and pin the strictness that makes an
 * unexpected field a rejection rather than something a consumer silently ignores.
 *
 * @summary Tests resume and resume-acknowledgment payload validation
 */

const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `m-${index}`);

describe('resumeAckPayloadSchema', () => {
  it('accepts an acknowledgment naming the messages already accepted', () => {
    const parsed = resumeAckPayloadSchema.parse({ revision: 7, acceptedMessageIds: ['m-1', 'm-2'] });
    expect(parsed.acceptedMessageIds).toEqual(['m-1', 'm-2']);
    expect(parsed.revision).toBe(7);
  });

  it('accepts an empty list, which is how a client learns to replay everything', () => {
    expect(resumeAckPayloadSchema.parse({ revision: 0, acceptedMessageIds: [] }).acceptedMessageIds).toEqual([]);
  });

  it('bounds the answer by the same cap as the request it answers', () => {
    // A client may name at most MAX_OUTSTANDING_MESSAGES obligations, and the
    // answer is a subset of those. A larger answer could only come from a server
    // reporting messages the client never asked about.
    expect(
      resumeAckPayloadSchema.safeParse({ revision: 1, acceptedMessageIds: ids(MAX_OUTSTANDING_MESSAGES) }).success
    ).toBe(true);
    expect(
      resumeAckPayloadSchema.safeParse({ revision: 1, acceptedMessageIds: ids(MAX_OUTSTANDING_MESSAGES + 1) }).success
    ).toBe(false);
    const request = (count: number): unknown => ({
      revision: 1,
      capabilities: { switchToInteractive: true, agentShutdown: true, strictDrainBarrier: true },
      lifecycleState: 'running',
      workRevision: 0,
      outstandingMessageIds: ids(count)
    });
    expect(resumePayloadSchema.safeParse(request(MAX_OUTSTANDING_MESSAGES)).success).toBe(true);
    expect(resumePayloadSchema.safeParse(request(MAX_OUTSTANDING_MESSAGES + 1)).success).toBe(false);
  });

  it('rejects an empty message id rather than accepting an unaddressable obligation', () => {
    expect(resumeAckPayloadSchema.safeParse({ revision: 1, acceptedMessageIds: [''] }).success).toBe(false);
  });

  it('rejects an unexpected field instead of ignoring it', () => {
    const withExtra = { revision: 1, acceptedMessageIds: [], corruptMessageIds: ['m-9'] };
    expect(resumeAckPayloadSchema.safeParse(withExtra).success).toBe(false);
  });

  it('requires a revision, so an answer cannot be applied out of order', () => {
    expect(resumeAckPayloadSchema.safeParse({ acceptedMessageIds: [] }).success).toBe(false);
  });
});
