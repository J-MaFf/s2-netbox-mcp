import 'dotenv/config';
import { loadConfigFromEnv, NetboxConfigError } from '../src/config.js';
import { NetboxClient } from '../src/netboxClient.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from '../src/commands.js';
import type { NbapiParams } from '../src/xml.js';

/**
 * Opt-in live-controller smoke test (satisfies acceptance criterion C11).
 *
 * `npm test` never runs this file and never requires a `.env` to exist.
 * This script is invoked separately via `npm run test:live`, and only
 * actually talks to a controller when NETBOX_BASE_URL, NETBOX_USERNAME, and
 * NETBOX_PASSWORD are all present (loaded from process.env, or from a local
 * .env file via dotenv if one exists) — otherwise it prints one line and
 * exits 0 without making any network call.
 *
 * SECURITY: this script must never print the value of NETBOX_PASSWORD,
 * under any circumstance, including inside an error message. Every line
 * printed goes through `redact()` as defense in depth on top of the fact
 * that the password never flows anywhere but the Login request body.
 */

let secret = '';

function redact(text: string): string {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

function log(line: string): void {
  console.log(redact(line));
}

function logErr(line: string): void {
  console.error(redact(line));
}

/** Recursively searches a parsed NBAPI response for the first value whose
 * key matches `keyPattern` (e.g. /READERKEY/i), to discover a real record ID
 * for chained detail-lookup checks without assuming an exact response shape. */
function findFirstMatchingId(value: unknown, keyPattern: RegExp): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstMatchingId(item, keyPattern);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (keyPattern.test(key) && (typeof val === 'string' || typeof val === 'number') && String(val).length > 0) {
        return String(val);
      }
    }
    for (const val of Object.values(obj)) {
      const found = findFirstMatchingId(val, keyPattern);
      if (found) return found;
    }
  }
  return undefined;
}

interface CheckResult {
  name: string;
  pass: boolean;
  summary: string;
  data?: unknown;
}

async function runCheck(
  client: NetboxClient,
  name: string,
  command: NbapiCommandName,
  params: NbapiParams
): Promise<CheckResult> {
  try {
    const result = await client.call(command, params);
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND — a valid, documented non-error result)' };
    }
    const json = JSON.stringify(result.data ?? {});
    const short = json.length > 120 ? `${json.slice(0, 120)}...` : json;
    return { name, pass: true, summary: `OK ${short}`, data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, pass: false, summary: message };
  }
}

async function main(): Promise<number> {
  const baseUrl = process.env.NETBOX_BASE_URL;
  const username = process.env.NETBOX_USERNAME;
  const password = process.env.NETBOX_PASSWORD;

  if (!baseUrl || !username || !password) {
    console.log('s2-netbox-mcp live-check: skipped (no NETBOX_BASE_URL/NETBOX_USERNAME/NETBOX_PASSWORD configured).');
    return 0;
  }

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    if (err instanceof NetboxConfigError) {
      console.error(`s2-netbox-mcp live-check: ${err.message}`);
      return 1;
    }
    throw err;
  }

  secret = config.password;

  const client = new NetboxClient(config);
  const results: CheckResult[] = [];

  results.push(await runCheck(client, 'check_connection', NBAPI_COMMANDS.GET_API_VERSION, {}));

  const accessLevels = await runCheck(client, 'get_access_levels', NBAPI_COMMANDS.GET_ACCESS_LEVELS, {});
  results.push(accessLevels);
  const accessLevelKey = findFirstMatchingId(accessLevels.data, /ACCESSLEVELKEY/i) ?? '1';
  results.push(
    await runCheck(client, 'get_access_level', NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY: accessLevelKey })
  );

  const accessLevelGroups = await runCheck(client, 'get_access_level_groups', NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS, {});
  results.push(accessLevelGroups);
  const accessLevelGroupKey = findFirstMatchingId(accessLevelGroups.data, /ACCESSLEVELGROUPKEY/i) ?? '1';
  results.push(
    await runCheck(client, 'get_access_level_group', NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, {
      ACCESSLEVELGROUPKEY: accessLevelGroupKey,
    })
  );

  // No `get_portal` (singular) check: per the Command reference, only the
  // plural GetPortals command exists — it cannot be filtered to a single
  // portal, and its response already nests each portal's readers.
  const portals = await runCheck(client, 'get_portals', NBAPI_COMMANDS.GET_PORTALS, {});
  results.push(portals);

  const readers = await runCheck(client, 'get_readers', NBAPI_COMMANDS.GET_READERS, {});
  results.push(readers);
  const readerKey = findFirstMatchingId(readers.data, /READERKEY/i) ?? '1';
  results.push(await runCheck(client, 'get_reader', NBAPI_COMMANDS.GET_READER, { READERKEY: readerKey }));

  results.push(await runCheck(client, 'get_card_formats', NBAPI_COMMANDS.GET_CARD_FORMATS, {}));

  const searchPersonData = await runCheck(client, 'search_person_data', NBAPI_COMMANDS.SEARCH_PERSON_DATA, {});
  results.push(searchPersonData);
  const personId = findFirstMatchingId(searchPersonData.data, /PERSONID/i) ?? '1';
  results.push(await runCheck(client, 'get_person', NBAPI_COMMANDS.GET_PERSON, { PERSONID: personId }));

  // GetCardAccessDetails has no PERSONID parameter — it identifies a card by
  // ENCODEDNUM + CARDFORMAT. Discover a real card from the search results
  // rather than guessing; skip cleanly if the test person has no card on file.
  const encodedNum = findFirstMatchingId(searchPersonData.data, /^ENCODEDNUM$/i);
  const cardFormat = findFirstMatchingId(searchPersonData.data, /^CARDFORMAT$/i);
  if (encodedNum && cardFormat) {
    results.push(
      await runCheck(client, 'get_card_access_details', NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, {
        ENCODEDNUM: encodedNum,
        CARDFORMAT: cardFormat,
      })
    );
  } else {
    results.push({
      name: 'get_card_access_details',
      pass: true,
      summary: 'SKIPPED (no ENCODEDNUM/CARDFORMAT found in search_person_data results to test against)',
    });
  }

  results.push(await runCheck(client, 'get_event_history', NBAPI_COMMANDS.GET_EVENT_HISTORY, {}));
  results.push(await runCheck(client, 'list_events', NBAPI_COMMANDS.LIST_EVENTS, {}));
  results.push(await runCheck(client, 'get_access_history', NBAPI_COMMANDS.GET_ACCESS_HISTORY, {}));

  await client.logout();

  for (const result of results) {
    const status = result.pass ? 'PASS' : 'FAIL';
    log(`[${status}] ${result.name}: ${result.summary}`);
  }

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  log(`Summary: ${results.length} tools checked, ${passCount} passed, ${failCount} failed.`);

  return failCount > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`s2-netbox-mcp live-check: unexpected error: ${message}`);
    process.exit(1);
  });
