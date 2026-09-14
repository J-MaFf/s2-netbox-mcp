import { XMLParser } from 'fast-xml-parser';

/**
 * XML request/response helpers for the NBAPI wire format:
 *
 *   <NETBOX-API sessionid="...">
 *     <COMMAND name="..." num="1">
 *       <PARAMS>
 *         <KEY>value</KEY>
 *       </PARAMS>
 *     </COMMAND>
 *   </NETBOX-API>
 *
 * Per the NBAPI documentation ("All XML tags must be in uppercase"), every
 * XML *element* name (NETBOX-API, COMMAND, PARAMS, and every PARAMS child)
 * is uppercase. The three documented XML *attributes* (`sessionid` on
 * NETBOX-API, `name` and `num` on COMMAND) are reproduced exactly as shown
 * in the documented example, which uses lowercase attribute names.
 */

export type NbapiParamValue = string | number | boolean;
export type NbapiParams = Record<string, NbapiParamValue | undefined>;

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds the `<PARAMS>...</PARAMS>` body from a flat key/value map. Keys are
 * upper-cased defensively so PARAMS element names always satisfy the
 * uppercase-tag requirement regardless of what callers pass in. */
export function buildParamsXml(params: NbapiParams): string {
  return Object.entries(params)
    .filter((entry): entry is [string, NbapiParamValue] => entry[1] !== undefined)
    .map(([key, value]) => {
      const tag = key.toUpperCase();
      return `<${tag}>${xmlEscape(String(value))}</${tag}>`;
    })
    .join('');
}

export interface BuildRequestXmlOptions {
  /** The active session ID, if any. Omitted (no sessionid attribute) for Login. */
  sessionId?: string | null;
  command: string;
  /** Per-request sequence number attribute on <COMMAND>. Defaults to 1. */
  num?: number;
  params?: NbapiParams;
}

/** Builds a full `<NETBOX-API>...</NETBOX-API>` request document. */
export function buildRequestXml(opts: BuildRequestXmlOptions): string {
  const { sessionId, command, num = 1, params = {} } = opts;
  const sessionAttr = sessionId ? ` sessionid="${xmlEscape(sessionId)}"` : '';
  const paramsXml = buildParamsXml(params);
  return (
    `<NETBOX-API${sessionAttr}>` +
    `<COMMAND name="${xmlEscape(command)}" num="${num}">` +
    `<PARAMS>${paramsXml}</PARAMS>` +
    `</COMMAND>` +
    `</NETBOX-API>`
  );
}

// Type coercion deliberately OFF: NBAPI fields (IDs, dates, etc.) are treated
// as opaque strings throughout this client, so "007" or "5" stay strings
// rather than silently becoming numbers (or "true"/"false" becoming
// booleans) on their way through the pass-through response data.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Parses a raw NBAPI response document into a plain JS object. */
export function parseResponseXml(xml: string): unknown {
  return parser.parse(xml);
}
