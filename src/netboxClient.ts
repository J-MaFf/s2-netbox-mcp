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
 * Interprets a parsed NBAPI response document per the documented error model:
 *  - An `<APIERROR>` element anywhere under <NETBOX-API> is a session/API-level failure.
 *  - Otherwise <RESPONSE><CODE> is one of SUCCESS, FAIL (with optional ERRMSG), or NOT FOUND.
 */
export function interpretResponse(parsed: unknown): InterpretedResponse {
  const root = asRecord(asRecord(parsed)['NETBOX-API']);

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

function extractSessionId(data: unknown): string | undefined {
  const record = asRecord(data);
  for (const key of ['SESSIONID', 'SESSION-ID', 'SESSION_ID']) {
    const value = textOf(record[key]);
    if (value) return value;
  }
  return undefined;
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
    const interpreted = interpretResponse(parseResponseXml(responseXml));

    if (interpreted.kind === 'apierror') {
      throw new NbapiApiError(interpreted.code);
    }
    if (interpreted.kind === 'fail') {
      throw new NbapiFailError(interpreted.errmsg);
    }
    if (interpreted.kind === 'not_found') {
      throw new Error('NetBox NBAPI Login returned NOT FOUND, which is not a valid login outcome.');
    }

    const sessionId = extractSessionId(interpreted.data);
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
