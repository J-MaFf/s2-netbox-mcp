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

export type NbapiParamPrimitive = string | number | boolean;

/**
 * A PARAMS value may be a scalar, a nested object (its own PARAMS-shaped
 * map, serialised as a child element wrapping its own children), or an
 * array (serialised as one sibling element per item, each item following
 * these same rules under the array's own key) — nested to any depth (R5).
 */
export type NbapiParamValue = NbapiParamPrimitive | NbapiParams | NbapiParamValue[] | undefined;
export type NbapiParams = { [key: string]: NbapiParamValue };

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isNbapiParams(value: unknown): value is NbapiParams {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialises one PARAMS entry (`tag` already upper-cased) per R5:
 *  - `undefined` -> dropped (empty string; also drops `undefined` array items)
 *  - array -> one sibling `<tag>...</tag>` per item, each serialised by this
 *    same function under the same tag
 *  - nested object -> `<tag>` + buildParamsXml(value) + `</tag>`
 *  - scalar -> `<tag>escaped(value)</tag>`
 */
function serializeEntry(tag: string, value: NbapiParamValue): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => serializeEntry(tag, item)).join('');
  }
  if (isNbapiParams(value)) {
    return `<${tag}>${buildParamsXml(value)}</${tag}>`;
  }
  return `<${tag}>${xmlEscape(String(value))}</${tag}>`;
}

/** Builds the `<PARAMS>...</PARAMS>` body (or a nested params element's
 * inner body) from a key/value map, nested to any depth per R5. Keys are
 * upper-cased defensively — at every nesting level — so PARAMS/child element
 * names always satisfy the uppercase-tag requirement regardless of what
 * callers pass in. Order is preserved (object key insertion order). */
export function buildParamsXml(params: NbapiParams): string {
  return Object.entries(params)
    .map(([key, value]) => serializeEntry(key.toUpperCase(), value))
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
