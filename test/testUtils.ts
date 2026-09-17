import type { FetchLike, NetboxClient } from '../src/netboxClient.js';

// ---------------------------------------------------------------------------
// Shared FakeServer / fake-client helpers for tool registration tests
// (R1-R3, R8-R21). Every test/tools*.test.ts and test/registration.test.ts
// file uses this instead of hand-rolling its own copy.
// ---------------------------------------------------------------------------

export interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

/** A minimal stand-in for McpServer that just records every server.tool(...) call. */
export class FakeServer {
  registrations: ToolRegistration[] = [];
  tool(name: string, description: string, schema: Record<string, unknown>, handler: ToolRegistration['handler']): void {
    this.registrations.push({ name, description, schema, handler });
  }
}

export function byName(server: FakeServer, name: string): ToolRegistration {
  const reg = server.registrations.find((r) => r.name === name);
  if (!reg) throw new Error(`tool not registered: ${name}`);
  return reg;
}

/** A fake NetboxClient whose .call() always resolves to the given result
 * (default: an empty SUCCESS) and records every invocation. */
export function fakeClient(
  result: { notFound: boolean; data: unknown } = { notFound: false, data: {} }
): { client: NetboxClient; calls: Array<{ command: string; params: unknown }> } {
  const calls: Array<{ command: string; params: unknown }> = [];
  const client = {
    call: async (command: string, params: unknown) => {
      calls.push({ command, params });
      return result;
    },
  } as unknown as NetboxClient;
  return { client, calls };
}

export interface MockCall {
  url: string;
  body: string;
}

export interface MockFetchController {
  fetchImpl: FetchLike;
  calls: MockCall[];
  /** Queue a canned XML response (optional HTTP status, optional response
   * headers e.g. `{ Date: 'Thu, 17 Sep 2026 09:09:50 GMT' }`) for the next request. */
  queueXml(xml: string, status?: number, headers?: Record<string, string>): void;
}

/** A hand-rolled fetch stub — no live controller, no network library. */
export function createMockFetch(): MockFetchController {
  const calls: MockCall[] = [];
  const queue: Array<{ xml: string; status: number; headers: Record<string, string> }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    const next = queue.shift();
    if (!next) {
      throw new Error('createMockFetch: no queued response for request');
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: next.status === 200 ? 'OK' : 'Error',
      text: async () => next.xml,
      headers: {
        get: (name: string) => {
          const match = Object.keys(next.headers).find((k) => k.toLowerCase() === name.toLowerCase());
          return match ? next.headers[match] : null;
        },
      },
    };
  };

  return {
    fetchImpl,
    calls,
    queueXml(xml: string, status = 200, headers = {}) {
      queue.push({ xml, status, headers });
    },
  };
}

// Per the spec's Command reference and the doc's general "XML Responses"
// section: every response — not just Login — is wrapped in <NETBOX ...>,
// documented as "the outermost element of the response," with a nested
// <RESPONSE command="..." num="1"><CODE>...</CODE><DETAILS>...</DETAILS></RESPONSE>.
// <NETBOX-API> is the *request* wrapper only and never appears in a response.
// On a Login SUCCESS specifically, there is no SESSIONID field in the
// response body at all — the session id is the `sessionid` *attribute* on
// the outer <NETBOX> response element itself.
export const LOGIN_SUCCESS_XML = (sessionId: string): string =>
  `<NETBOX sessionid="${sessionId}"><RESPONSE command="Login"><CODE>SUCCESS</CODE></RESPONSE></NETBOX>`;

// Documented fields for a SUCCESS response live inside <DETAILS>, nested
// under <RESPONSE> — not as direct children of <RESPONSE> itself.
export const SUCCESS_XML = (command: string, fields: Record<string, string> = {}): string => {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  const details = body ? `<DETAILS>${body}</DETAILS>` : '';
  return `<NETBOX><RESPONSE command="${command}"><CODE>SUCCESS</CODE>${details}</RESPONSE></NETBOX>`;
};

// A NOT FOUND response typically carries no <DETAILS> block at all.
export const NOT_FOUND_XML = (command: string): string =>
  `<NETBOX><RESPONSE command="${command}"><CODE>NOT FOUND</CODE></RESPONSE></NETBOX>`;

// ERRMSG on a FAIL response lives inside <DETAILS>, same as SUCCESS fields.
export const FAIL_XML = (command: string, errmsg: string): string =>
  `<NETBOX><RESPONSE command="${command}"><CODE>FAIL</CODE><DETAILS><ERRMSG>${errmsg}</ERRMSG></DETAILS></RESPONSE></NETBOX>`;

// APIERROR is an API-level failure nested inside <RESPONSE> (inside <NETBOX>),
// distinct from — and with no — <CODE>/<DETAILS> of its own.
export const API_ERROR_XML = (code: number): string =>
  `<NETBOX><RESPONSE><APIERROR>${code}</APIERROR></RESPONSE></NETBOX>`;
