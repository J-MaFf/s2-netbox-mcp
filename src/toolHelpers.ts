import type { NetboxClient } from './netboxClient.js';
import type { NbapiCommandName } from './commands.js';
import type { NbapiParams, NbapiParamValue } from './xml.js';
import { NbapiApiError, NbapiFailError } from './errors.js';

export interface ToolTextResult {
  // Index signature required to satisfy the MCP SDK's CallToolResult shape.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * R1/R2 gating flags, threaded into every `registerXxxTools(server, client,
 * gate)` call from `src/index.ts`. A tool module consults `writesEnabled`
 * before registering any write tool and `writesEnabled && destructiveEnabled`
 * before registering any of the 11 destructive tools (R2); the same flags are
 * consulted again inside `modify_person`/`modify_udf_list_items` at call time
 * (R2's independent-of-registration guard).
 */
export interface ToolGateFlags {
  writesEnabled: boolean;
  destructiveEnabled: boolean;
}

/** Default success formatter: a thin pass-through of the NBAPI response data as JSON. */
export function formatAsJson(data: unknown): string {
  return JSON.stringify(data ?? {}, null, 2);
}

/**
 * Success formatter for write tools (R3): every write tool's success text
 * contains the literal `SUCCESS` followed by the pretty-printed DETAILS JSON
 * (which may be `{}` when the controller returns no DETAILS on that
 * command), so callers can tell a write succeeded even with no response body.
 */
export function formatWriteSuccess(data: unknown): string {
  return `SUCCESS\n${formatAsJson(data)}`;
}

/** A client-side validation failure (R2/R9-R20 guards): returns `isError`
 * without ever issuing an NBAPI command. */
export function clientGuardError(message: string): ToolTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** R2: the specific guard result for `modify_person`/`modify_udf_list_items`
 * when a destructive-shaped write is attempted with NETBOX_ENABLE_DESTRUCTIVE
 * not truthy. Names the flag, per the spec's verify clause. */
export function destructiveFlagRequired(what: string): ToolTextResult {
  return clientGuardError(`Refused: ${what} requires NETBOX_ENABLE_DESTRUCTIVE to be enabled.`);
}

/**
 * Wraps a possibly-`undefined` list of items under `{ [wrapperKey]: {
 * [itemKey]: items } }` — the common "wrapped list" wire shape used
 * throughout R11-R20 (e.g. `PORTALKEYS: string[]` ->
 * `{ PORTALKEYS: { PORTALKEY: [...] } }`, per R5). Returns `{}` (no key
 * added) when `items` is `undefined`, so the result can always be spread
 * into an outer PARAMS object literal.
 */
export function wrapList(wrapperKey: string, itemKey: string, items: NbapiParamValue[] | undefined): NbapiParams {
  return items === undefined ? {} : { [wrapperKey]: { [itemKey]: items } };
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
    return toolErrorResult(err);
  }
}

/** Maps an error thrown while issuing NBAPI commands onto the MCP tool-error
 * shape: APIERROR/FAIL messages verbatim, anything else prefixed as unexpected. */
export function toolErrorResult(err: unknown): ToolTextResult {
  if (err instanceof NbapiApiError || err instanceof NbapiFailError) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Unexpected error calling NetBox NBAPI: ${message}` }], isError: true };
}

/** Passes a tool's named optional fields through as a flat PARAMS map
 * (undefined-valued fields are dropped when the request is built). */
export function mergeParams(named: NbapiParams): NbapiParams {
  return { ...named };
}
