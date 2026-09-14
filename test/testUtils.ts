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

// Per the spec's Command reference: on SUCCESS there is no SESSIONID field in
// the response body — the session id is the `sessionid` *attribute* on the
// outer <NETBOX> response element itself (not <NETBOX-API>, which is only the
// *request* wrapper).
export const LOGIN_SUCCESS_XML = (sessionId: string): string =>
  `<NETBOX sessionid="${sessionId}"><RESPONSE command="Login"><CODE>SUCCESS</CODE></RESPONSE></NETBOX>`;

export const SUCCESS_XML = (command: string, fields: Record<string, string> = {}): string => {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return `<NETBOX-API><RESPONSE command="${command}"><CODE>SUCCESS</CODE>${body}</RESPONSE></NETBOX-API>`;
};

export const NOT_FOUND_XML = (command: string): string =>
  `<NETBOX-API><RESPONSE command="${command}"><CODE>NOT FOUND</CODE></RESPONSE></NETBOX-API>`;

export const FAIL_XML = (command: string, errmsg: string): string =>
  `<NETBOX-API><RESPONSE command="${command}"><CODE>FAIL</CODE><ERRMSG>${errmsg}</ERRMSG></RESPONSE></NETBOX-API>`;

export const API_ERROR_XML = (code: number): string => `<NETBOX-API><APIERROR>${code}</APIERROR></NETBOX-API>`;
