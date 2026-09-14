import type { NetboxClient } from './netboxClient.js';
import type { NbapiCommandName } from './commands.js';
import type { NbapiParams } from './xml.js';
import { NbapiApiError, NbapiFailError } from './errors.js';

export interface ToolTextResult {
  // Index signature required to satisfy the MCP SDK's CallToolResult shape.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Default success formatter: a thin pass-through of the NBAPI response data as JSON. */
export function formatAsJson(data: unknown): string {
  return JSON.stringify(data ?? {}, null, 2);
}

/**
 * Shared execution wrapper for every tool: issues one NBAPI command and maps
 * the outcome onto the MCP tool-result shape per R7-R9:
 *  - APIERROR / FAIL -> { isError: true, content: [<message>] }
 *  - NOT FOUND        -> a normal (non-error) result stating "not found"
 *  - SUCCESS          -> a normal result with the formatted response data
 */
export async function runNbapiTool(
  client: NetboxClient,
  command: NbapiCommandName,
  params: NbapiParams,
  formatSuccess: (data: unknown) => string = formatAsJson
): Promise<ToolTextResult> {
  try {
    const result = await client.call(command, params);
    if (result.notFound) {
      return {
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      };
    }
    return { content: [{ type: 'text', text: formatSuccess(result.data) }] };
  } catch (err) {
    if (err instanceof NbapiApiError || err instanceof NbapiFailError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Unexpected error calling NetBox NBAPI: ${message}` }], isError: true };
  }
}

/** Merges named optional fields with a free-form extraParams passthrough bag
 * into a single flat PARAMS map, dropping any undefined values. */
export function mergeParams(named: NbapiParams, extraParams?: Record<string, string>): NbapiParams {
  return { ...named, ...(extraParams ?? {}) };
}
