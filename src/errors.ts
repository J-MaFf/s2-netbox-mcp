/**
 * The six documented NBAPI `<APIERROR>` codes and their meanings, per the
 * NBAPI error model described in "Web-Based API for S2 NetBox and S2 Global"
 * (LenelS2, doc #API-UG-14).
 */
export const API_ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  1: 'General request error — the submitted XML could not be parsed or was otherwise malformed.',
  2: 'The API is not enabled on the system.',
  3: 'Invalid or unrecognized command name.',
  4: 'A required parameter was missing or invalid for the requested command.',
  5: 'Authentication failure — invalid username/password, or an invalid/expired session ID.',
  6: 'The authenticated user does not have sufficient privileges to run this command.',
};

/** Formats an APIERROR code as "<code>: <documented description>". */
export function describeApiError(code: number): string {
  const description = API_ERROR_DESCRIPTIONS[code] ?? 'Undocumented APIERROR code.';
  return `${code}: ${description}`;
}

/** An NBAPI-level failure: the response contained an `<APIERROR>` element. */
export class NbapiApiError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`NetBox NBAPI error ${describeApiError(code)}`);
    this.name = 'NbapiApiError';
    this.code = code;
  }
}

/** A command-level failure: the response's `<CODE>` was `FAIL`. */
export class NbapiFailError extends Error {
  readonly errmsg: string | undefined;

  constructor(errmsg: string | undefined) {
    super(errmsg ? `NetBox NBAPI command failed: ${errmsg}` : 'NetBox NBAPI command failed.');
    this.name = 'NbapiFailError';
    this.errmsg = errmsg;
  }
}
