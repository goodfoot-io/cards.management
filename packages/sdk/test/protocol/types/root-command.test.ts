/**
 * Root-command wire contracts: the launch union's two strict variants, the
 * bounded opaque `execution.commandReport`, `launchProtocol` replacing
 * `worktreeProtocol`, and the completed retrieval carrying an optional report.
 * @summary Root command launch, report and launch-protocol contract tests
 */
import { describe, expect, it } from 'vitest';
import { publicActionRetrievalResponseSchema } from '../../../src/client/runtime/actions.js';
import { RUNTIME_MESSAGE_CONTRACTS } from '../../../src/protocol/types/runtime-authorization.js';
import {
  commandReportPayloadSchema,
  executeRequestPayloadSchema,
  interactiveHandoffPayloadSchema,
  launchRequestPayloadSchema,
  MAX_COMMAND_REPORT_BYTES,
  RUNTIME_MESSAGE_PAYLOADS
} from '../../../src/protocol/types/runtime-messages.js';

const ACTION = { actionId: 'implement', environmentName: 'default', mode: 'background', exitWhenDone: true };
const ROOT = { rootCommand: 'worktreeMaintenance', input: { mode: 'cleanup' } };
const EXECUTION = { executionId: 'execution-1', launchRequestId: 'request-1' };
const TERMINAL = {
  terminalDecisionId: 'terminal:execution-1',
  observationId: 'obs-1',
  trigger: 'root-exit',
  status: 'drained',
  phase: 'graceful',
  rootExit: { code: 0, signal: null },
  finalization: 'complete'
};

describe('launch union', () => {
  it.skip('accepts the action variant and every root-command mode, on launch and execute alike', () => {
    for (const schema of [launchRequestPayloadSchema, executeRequestPayloadSchema]) {
      expect(schema.safeParse(ACTION).success).toBe(true);
      for (const mode of ['preview', 'cleanup', 'prepare-delete']) {
        expect(schema.safeParse({ rootCommand: 'worktreeMaintenance', input: { mode } }).success).toBe(true);
      }
    }
  });

  it.skip('rejects a payload mixing both variants, an unknown command, an unknown mode and extra input', () => {
    for (const payload of [
      { ...ACTION, ...ROOT },
      { rootCommand: 'somethingElse', input: { mode: 'cleanup' } },
      { rootCommand: 'worktreeMaintenance', input: { mode: 'purge' } },
      { rootCommand: 'worktreeMaintenance', input: { mode: 'cleanup', cardId: 'main-1' } },
      { rootCommand: 'worktreeMaintenance' }
    ]) {
      expect(launchRequestPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe('execution.commandReport', () => {
  it.skip('is an agent-handler durable result', () => {
    expect(RUNTIME_MESSAGE_CONTRACTS['execution.commandReport']).toMatchObject({
      direction: 'client-to-server',
      deliveryClass: 'durable-result',
      allowedRoles: ['agent-handler']
    });
    expect(RUNTIME_MESSAGE_PAYLOADS['execution.commandReport']).toBe(commandReportPayloadSchema);
  });

  it.skip('accepts an opaque object up to the bound and rejects a larger one or a non-object', () => {
    expect(commandReportPayloadSchema.safeParse({ decisions: [], nested: { any: ['shape'] } }).success).toBe(true);
    const fits = { blob: 'x'.repeat(MAX_COMMAND_REPORT_BYTES - 20) };
    expect(commandReportPayloadSchema.safeParse(fits).success).toBe(true);
    expect(commandReportPayloadSchema.safeParse({ blob: 'x'.repeat(MAX_COMMAND_REPORT_BYTES) }).success).toBe(false);
    expect(commandReportPayloadSchema.safeParse(['array']).success).toBe(false);
    expect(commandReportPayloadSchema.safeParse(null).success).toBe(false);
  });
});

describe('launchProtocol', () => {
  it.skip('replaces worktreeProtocol on the interactive handoff', () => {
    const continuation = { kind: 'inline', value: '{"sessionId":"s"}' };
    expect(interactiveHandoffPayloadSchema.safeParse({ continuation, launchProtocol: 2 }).success).toBe(true);
    expect(interactiveHandoffPayloadSchema.safeParse({ continuation }).success).toBe(true);
    expect(interactiveHandoffPayloadSchema.safeParse({ continuation, worktreeProtocol: 2 }).success).toBe(false);
  });
});

describe('completed retrieval', () => {
  const completed = {
    status: 'completed',
    execution: EXECUTION,
    retrievedOutcome: { disposition: 'spawned', processBootId: 'boot-1' },
    terminalOutcome: TERMINAL
  };

  it.skip('accepts a completed record with or without a commandReport', () => {
    expect(publicActionRetrievalResponseSchema.safeParse(completed).success).toBe(true);
    expect(
      publicActionRetrievalResponseSchema.safeParse({ ...completed, commandReport: { decisions: [] } }).success
    ).toBe(true);
  });

  it.skip('rejects a null commandReport and one over the bound', () => {
    expect(publicActionRetrievalResponseSchema.safeParse({ ...completed, commandReport: null }).success).toBe(false);
    expect(
      publicActionRetrievalResponseSchema.safeParse({
        ...completed,
        commandReport: { blob: 'x'.repeat(MAX_COMMAND_REPORT_BYTES) }
      }).success
    ).toBe(false);
  });

  it.skip('carries no commandReport on any other status', () => {
    expect(
      publicActionRetrievalResponseSchema.safeParse({
        status: 'pending',
        execution: EXECUTION,
        retrievedOutcome: null,
        commandReport: {}
      }).success
    ).toBe(false);
  });
});
