import type { FetchLike } from '../src/netboxClient.js';

export interface MockCall {
  url: string;
  body: string;
}

export interface MockFetchController {
  fetchImpl: FetchLike;
  calls: MockCall[];
  /** Queue a canned XML response (and optional HTTP status) for the next request. */
  queueXml(xml: string, status?: number): void;
}

/** A hand-rolled fetch stub — no live controller, no network library. */
export function createMockFetch(): MockFetchController {
  const calls: MockCall[] = [];
  const queue: Array<{ xml: string; status: number }> = [];

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
    };
  };

  return {
    fetchImpl,
    calls,
    queueXml(xml: string, status = 200) {
      queue.push({ xml, status });
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
