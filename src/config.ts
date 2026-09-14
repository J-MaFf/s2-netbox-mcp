/**
 * Environment-variable configuration for the NetBox NBAPI client.
 *
 * IMPORTANT: nothing in this module (or anywhere else in src/) may write the
 * value of NETBOX_PASSWORD to a log, console, or error message (see R19).
 * Error messages below only ever reference environment variable *names*.
 */
export interface NetboxConfig {
  baseUrl: string;
  username: string;
  password: string;
  allowInsecureTls: boolean;
  apiPath: string;
}

export class NetboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetboxConfigError';
  }
}

/**
 * The NBAPI path on NetBox 6.x, verified live against a real 6.2.0
 * controller (see spec Context). The pre-6.x doc's `/goforms/nbapi` path
 * returns HTTP 410 Gone on 6.x and is available only as an explicit
 * `NETBOX_API_PATH` override for pre-6.x controllers (R20).
 */
export const DEFAULT_NETBOX_API_PATH = '/nbws/goforms/nbapi';

/**
 * Resolves NETBOX_API_PATH per R20: unset/empty defaults to
 * DEFAULT_NETBOX_API_PATH; a non-empty override is used verbatim except that
 * a missing leading `/` is added.
 */
function resolveApiPath(raw: string | undefined): string {
  if (!raw) return DEFAULT_NETBOX_API_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Reads and validates NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, and
 * the optional NETBOX_ALLOW_INSECURE_TLS and NETBOX_API_PATH from the given
 * environment (defaults to `process.env`). Throws NetboxConfigError with a
 * single-line, actionable message (naming only the missing variable names,
 * never any value) if any required variable is missing.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NetboxConfig {
  const baseUrl = env.NETBOX_BASE_URL;
  const username = env.NETBOX_USERNAME;
  const password = env.NETBOX_PASSWORD;

  const missing: string[] = [];
  if (!baseUrl) missing.push('NETBOX_BASE_URL');
  if (!username) missing.push('NETBOX_USERNAME');
  if (!password) missing.push('NETBOX_PASSWORD');

  if (missing.length > 0) {
    throw new NetboxConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your environment (or a .env file — see .env.example) before starting the server.'
    );
  }

  // Explicit opt-in only; any value other than 1/true/yes (case-insensitive)
  // leaves TLS verification on, per the spec's "no silent fallback" constraint.
  const allowInsecureTls = /^(1|true|yes)$/i.test(env.NETBOX_ALLOW_INSECURE_TLS ?? '');

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ''),
    username: username!,
    password: password!,
    allowInsecureTls,
    apiPath: resolveApiPath(env.NETBOX_API_PATH),
  };
}
