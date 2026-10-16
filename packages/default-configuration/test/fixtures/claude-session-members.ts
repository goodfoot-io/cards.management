/**
 * Reconstructed Claude main and subagent records for multi-source session composition.
 * Relationship fields follow the captured 2.1.280 projection shapes used by the linkage
 * acceptance tests (Agent `tool_use`, joined `toolUseResult.agentId`, sidechain `agentId`);
 * identities and text are synthetic, never captured transcripts.
 * @summary Claude session-member fixtures
 */

export const SESSION_ID = 'SESSION';

/**
 * A main-thread user prompt.
 * @param text - User-authored text.
 * @param uuid - Native event identity.
 * @returns Native record.
 */
export const prompt = (text: string, uuid: string) => ({
  type: 'user',
  uuid,
  sessionId: SESSION_ID,
  message: { role: 'user', content: [{ type: 'text', text }] }
});

/**
 * An assistant Agent delegation call.
 * @param toolId - Native tool-use identity.
 * @param uuid - Native event identity.
 * @param caller - Sidechain caller identity, when a subagent delegates.
 * @returns Native record.
 */
export const delegate = (toolId: string, uuid: string, caller?: string) => ({
  type: 'assistant',
  uuid,
  sessionId: SESSION_ID,
  ...(caller ? { agentId: caller, isSidechain: true } : {}),
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Agent', id: toolId, input: { description: 'Investigate', prompt: 'Look' } }]
  }
});

/**
 * The structured result joining a delegation to its child agent identity.
 * @param toolId - Native tool-use identity.
 * @param agentId - Child agent identity.
 * @param uuid - Native event identity.
 * @param caller - Sidechain caller identity, when a subagent delegates.
 * @returns Native record.
 */
export const delegated = (toolId: string, agentId: string, uuid: string, caller?: string) => ({
  type: 'user',
  uuid,
  sessionId: SESSION_ID,
  ...(caller ? { agentId: caller, isSidechain: true } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Finished.' }] },
  toolUseResult: { status: 'completed', agentId }
});

/**
 * A sidechain record written by a subagent.
 * @param agentId - Subagent identity.
 * @param text - Assistant text.
 * @param uuid - Native event identity.
 * @returns Native record.
 */
export const sidechain = (agentId: string, text: string, uuid: string) => ({
  type: 'assistant',
  uuid,
  sessionId: SESSION_ID,
  agentId,
  isSidechain: true,
  message: { role: 'assistant', content: [{ type: 'text', text }] }
});

/**
 * A main-thread assistant reply.
 * @param text - Assistant-authored text.
 * @param uuid - Native event identity.
 * @returns Native record.
 */
export const reply = (text: string, uuid: string) => ({
  type: 'assistant',
  uuid,
  sessionId: SESSION_ID,
  message: { role: 'assistant', content: [{ type: 'text', text }] }
});

/**
 * Serializes native records into JSONL lines.
 * @param records - Native objects.
 * @returns One JSON line per record.
 */
export const lines = (records: readonly unknown[]): string[] => records.map((record) => JSON.stringify(record));
