/**
 * The machinery behind the coding-agent actions: the shared session utilities
 * of each agent (Claude Code, Codex, OpenCode, Antigravity), the resolution of
 * `cards.defaultCodingAgent`, and the worktree slots every session runs in.
 * The per-agent termination, trust, configuration and CLI-spawning modules
 * beside them are internal to those sessions.
 *
 * @summary Coding-agent sessions, agent resolution and worktree slots
 * @module
 */

export * from './antigravity-session.js';
export * from './claude-session.js';
export * from './codex-session.js';
export * from './coding-agent.js';
export * from './opencode-session.js';
export * from './worktrees/index.js';
