import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolTextResult } from '../toolHelpers.js';
import { GUIDE_TOPICS } from '../guide/index.js';

const TOPIC_KEYS = Object.keys(GUIDE_TOPICS);

/** R7: the index text returned when `topic` is omitted or unrecognized --
 * every topic key with its summary, plus a line noting this is the index,
 * not an error. */
function buildIndex(): string {
  const lines = TOPIC_KEYS.map((key) => `- ${key}: ${GUIDE_TOPICS[key].summary}`);
  return [
    'This is the get_guide index, not an error. Call get_guide again with one of the topic keys below to get that topic’s full content.',
    ...lines,
  ].join('\n');
}

const INDEX_TEXT = buildIndex();

/**
 * Registers get_guide (R7): a pure in-process lookup over GUIDE_TOPICS, with
 * no `client`/`gate` dependency and no controller call, so it is available
 * under every gate combination (R9/R10) -- like `check_connection`, it does
 * not fit any one of the tool-category modules.
 */
export function registerGuideTool(server: McpServer): void {
  server.tool(
    'get_guide',
    'Returns static reference guidance on this server’s S2 NetBox domain knowledge. Makes no controller call. Call with no topic for an index of all six topics; call with topic set to one of access-model, unlock-windows, group-and-name-gotchas, credentials-and-card-formats, api-quirks, write-safety for that topic’s full content.',
    {
      topic: z
        .string()
        .optional()
        .describe(
          'Optional. One of: access-model, unlock-windows, group-and-name-gotchas, credentials-and-card-formats, api-quirks, write-safety. Omitted or unrecognized returns the index instead.'
        ),
    },
    async ({ topic }): Promise<ToolTextResult> => {
      const known = topic !== undefined ? GUIDE_TOPICS[topic] : undefined;
      const text = known ? known.content : INDEX_TEXT;
      return { content: [{ type: 'text', text }] };
    }
  );
}
