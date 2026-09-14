import { Agent, fetch as undiciFetch } from 'undici';
import type { NetboxConfig } from './config.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from './commands.js';
import { NbapiApiError, NbapiFailError } from './errors.js';
import { buildRequestXml, parseResponseXml, type NbapiParams } from './xml.js';

/** Minimal fetch-compatible signature, so tests can inject a hand-rolled HTTP
 * stub instead of hitting the network. Matches the subset of the global
 * `fetch`/undici `fetch` surface this client actually uses. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface NbapiCallResult {
  notFound: boolean;
  data: unknown;
}

type InterpretedResponse =
  | { kind: 'apierror'; code: number }
  | { kind: 'success'; data: unknown }
  | { kind: 'fail'; errmsg: string | undefined }
  | { kind: 'not_found' };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('#text' in obj) return String(obj['#text']);
    return undefined;
  }
  return String(value);
}

/**
 * Resolves the outer envelope element of a parsed NBAPI response document.
 *
 * Per the Command reference (see spec Context/Login entry), NBAPI *responses*
 * are wrapped in `<NETBOX ...>`, distinct from the `<NETBOX-API ...>` element
 * used to wrap *requests* (per R2). Both are accepted here defensively (some
 * commands' documented examples are easy to misread as sharing the request's
 * wrapper name), but `<NETBOX>` is the documented, authoritative one.
 */
function responseRoot(parsed: unknown): Record<string, unknown> {
  const doc = asRecord(parsed);
  if ('NETBOX' in doc) return asRecord(doc.NETBOX);
  return asRecord(doc['NETBOX-API']);
}

/**
 * Interprets a parsed NBAPI response document per the documented error model:
 *  - An `<APIERROR>` element anywhere under the response envelope is a session/API-level failure.
 *  - Otherwise <RESPONSE><CODE> is one of SUCCESS, FAIL (with optional ERRMSG), or NOT FOUND.
 */
export function interpretResponse(parsed: unknown): InterpretedResponse {
  const root = responseRoot(parsed);

  if ('APIERROR' in root) {
    const raw = textOf(root.APIERROR) ?? String(root.APIERROR);
    const code = Number.parseInt(raw, 10);
    return { kind: 'apierror', code: Number.isNaN(code) ? -1 : code };
  }

  const response = asRecord(root.RESPONSE);
  const code = textOf(response.CODE)?.trim().toUpperCase();

  if (code === 'FAIL') {
    return { kind: 'fail', errmsg: textOf(response.ERRMSG) };
  }
  if (code === 'NOT FOUND') {
    return { kind: 'not_found' };
  }

  // SUCCESS, or an undocumented/absent CODE: treat as a successful
  // pass-through of whatever fields the controller returned.
  const { CODE: _code, '@_command': _cmd, ...data } = response;
  return { kind: 'success', data };
}

/**
 * Extracts the session id established by a successful Login call.
 *
 * Per the Command reference: "On SUCCESS there is no sessionid field inside
 * the response body — the session id is the `sessionid` *attribute* on the
 * outer `<NETBOX>` response element itself." There is deliberately no
 * fallback to a `SESSIONID` body field here — the spec is explicit that no
 * such field exists on a real response, and guessing one back in is exactly
 * the kind of invented field name the spec warns against.
 */
function extractSessionIdAttr(parsed: unknown): string | undefined {
  const root = responseRoot(parsed);
  const raw = root['@_sessionid'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export class NetboxClient {
  private readonly config: NetboxConfig;
  private readonly fetchImpl: FetchLike;
  private readonly agent: Agent | undefined;
  private sessionId: string | null = null;
  private loginInFlight: Promise<void> | null = null;
  private commandSeq = 0;

  constructor(config: NetboxConfig, fetchImpl?: FetchLike) {
    this.config = config;
    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
      this.agent = undefined;
    } else {
      this.agent = new Agent({
        connect: config.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
      });
      const agent = this.agent;
      this.fetchImpl = ((url, init) =>
        undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as FetchLike;
    }
  }

  /** True once a session has been established and cached. Exposed for tests/diagnostics. */
  get hasSession(): boolean {
    return this.sessionId !== null;
  }

  private nextNum(): number {
    this.commandSeq += 1;
    return this.commandSeq;
  }

  private async postXml(xml: string): Promise<string> {
    const url = `${this.config.baseUrl}/goforms/nbapi`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
    });
    if (!response.ok) {
      throw new Error(`NetBox NBAPI HTTP error: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
  }

  private async login(): Promise<void> {
    // Login never carries a sessionid attribute and is never retried by
    // callInternal's retry-on-expiry path (that would recurse into login()).
    const xml = buildRequestXml({
      sessionId: null,
      command: NBAPI_COMMANDS.LOGIN,
      num: this.nextNum(),
      params: { USERNAME: this.config.username, PASSWORD: this.config.password },
    });
    const responseXml = await this.postXml(xml);
    const parsed = parseResponseXml(responseXml);
    const interpreted = interpretResponse(parsed);

    if (interpreted.kind === 'apierror') {
      throw new NbapiApiError(interpreted.code);
    }
    if (interpreted.kind === 'fail') {
      throw new NbapiFailError(interpreted.errmsg);
    }
    if (interpreted.kind === 'not_found') {
      throw new Error('NetBox NBAPI Login returned NOT FOUND, which is not a valid login outcome.');
    }

    const sessionId = extractSessionIdAttr(parsed);
    if (!sessionId) {
      throw new Error('NetBox NBAPI Login succeeded but no session ID was returned by the controller.');
    }
    this.sessionId = sessionId;
  }

  /**
   * Issues one NBAPI command and returns its interpreted result.
   *
   * - Throws NbapiApiError for any <APIERROR>.
   * - Throws NbapiFailError for <CODE>FAIL</CODE>.
   * - Returns { notFound: true } (not an error) for <CODE>NOT FOUND</CODE>.
   * - On APIERROR 5 (authentication failure / expired session), the session
   *   is dropped, a single re-login is attempted, and the original command
   *   is retried exactly once before giving up.
   */
  async call(command: NbapiCommandName, params: NbapiParams = {}): Promise<NbapiCallResult> {
    await this.ensureSession();
    return this.callInternal(command, params, true);
  }

  private async callInternal(
    command: NbapiCommandName,
    params: NbapiParams,
    allowRetryOnExpiry: boolean
  ): Promise<NbapiCallResult> {
    const xml = buildRequestXml({ sessionId: this.sessionId, command, num: this.nextNum(), params });
    const responseXml = await this.postXml(xml);
    const interpreted = interpretResponse(parseResponseXml(responseXml));

    if (interpreted.kind === 'apierror') {
      if (interpreted.code === 5 && allowRetryOnExpiry) {
        this.sessionId = null;
        await this.ensureSession();
        return this.callInternal(command, params, false);
      }
      throw new NbapiApiError(interpreted.code);
    }
    if (interpreted.kind === 'fail') {
      throw new NbapiFailError(interpreted.errmsg);
    }
    if (interpreted.kind === 'not_found') {
      return { notFound: true, data: undefined };
    }
    return { notFound: false, data: interpreted.data };
  }

  /** Sends Logout for any active session. Best-effort: never throws, so it is
   * always safe to call from a shutdown handler. */
  async logout(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      const xml = buildRequestXml({ sessionId, command: NBAPI_COMMANDS.LOGOUT, num: this.nextNum(), params: {} });
      await this.postXml(xml);
    } catch {
      // Best-effort on shutdown — the process is exiting either way.
    }
  }
}
