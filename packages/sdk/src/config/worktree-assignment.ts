/** Assignment callback policy for authenticated handler contexts.
 * @summary A single deadline covers connection, durable send and same-message retry
 */
import type { RuntimeClient } from '../client/runtime/index.js';
import type { AssignedWorktree, ExecutionRef } from '../protocol/index.js';

/**
 * Creates the handler's bounded assignment operation without changing client recovery.
 * @param client - The authenticated handler runtime client.
 * @param execution - Durable execution identity from its credential.
 * @param requestId - Initial admission request identity.
 * @param onCloseError - Diagnostic for a failed timeout-triggered connection close.
 * @returns An operation preserving one message identity through uncertain retries.
 * @throws When execution identity is missing; the returned operation rejects on refusal or deadline expiration.
 */
export function createWorktreeAssignmentCallback(
  client: RuntimeClient,
  execution: ExecutionRef,
  requestId: string,
  onCloseError: (error: unknown) => void
): () => Promise<AssignedWorktree> {
  const executionId = execution.executionId;
  if (executionId === null) throw new Error('Worktree assignment requires a durable execution identity');
  return async () => {
    const deadline = Date.now() + 120_000;
    const sentAt = new Date().toISOString();
    const messageId = `${executionId}:agent-handler:worktree.assign`;
    let expired = false;
    const timeoutError = () => new Error('Runtime worktree assignment could not be confirmed within 120 seconds');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          expired = true;
          // close aborts the connection while retaining durable outbox obligations.
          void client.close().catch(onCloseError);
          reject(timeoutError());
        },
        Math.max(1, deadline - Date.now())
      );
    });
    const assigning = async (): Promise<AssignedWorktree> => {
      while (!expired && Date.now() < deadline) {
        if (client.state !== 'connected') await client.connect();
        if (expired || Date.now() >= deadline) throw timeoutError();
        const result = await client.send({
          type: 'worktree.assign',
          payload: {},
          messageId,
          sentAt,
          requestId,
          causationId: executionId,
          execution,
          deadlineMs: Math.max(1, deadline - Date.now())
        });
        if (expired || Date.now() >= deadline) throw timeoutError();
        if (result.status === 'completed') return result.payload;
        if (result.status === 'rejected' && result.reason !== 'not-synchronized')
          throw new Error(`Runtime worktree assignment refused: ${result.reason}`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      }
      throw timeoutError();
    };
    try {
      return await Promise.race([assigning(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
