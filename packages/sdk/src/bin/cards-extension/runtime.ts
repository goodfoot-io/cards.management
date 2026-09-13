/**
 * Guarded operator runtime maintenance commands.
 * @summary Operator runtime maintenance CLI
 */
import { discoverApiInfo } from '@cards.management/sdk/client/discovery';
import { buildFetchOptions, handleErrorResponse } from './utils.js';

const HELP = `Usage: cards-extension runtime retire <execution-id> --confirm RETIRE --reason <text>`;

/**
 * Parses and sends an explicitly confirmed legacy execution retirement.
 * @param args - Arguments following the runtime subcommand.
 * @returns Intended process exit code.
 */
export async function runRuntime(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const [operation, executionId, ...rest] = args;
  if (operation !== 'retire' || !executionId) {
    console.error(HELP);
    return 1;
  }
  const value = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const confirmation = value('--confirm');
  const reason = value('--reason');
  if (confirmation !== 'RETIRE' || reason === undefined || reason.trim().length < 8) {
    console.error('cards-extension runtime retire: --confirm RETIRE and an 8-500 character --reason are required');
    return 1;
  }
  const info = await discoverApiInfo();
  if (!info) {
    console.error('API discovery failed — is the Cards extension running in VS Code?');
    return 1;
  }
  const url = `http://${info.host}:${info.port}/internal/runtime/executions/${encodeURIComponent(executionId)}/retire`;
  const response = await fetch(
    url,
    buildFetchOptions(info.accessToken, 'POST', { confirmation: 'RETIRE', reason: reason.trim() })
  );
  const error = await handleErrorResponse(response);
  if (error) {
    console.error(`cards-extension runtime retire: ${error}`);
    return 1;
  }
  console.log(JSON.stringify(await response.json()));
  return 0;
}
