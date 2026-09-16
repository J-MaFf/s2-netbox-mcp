import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { fetchAllPages, text } from './paging.js';

/**
 * Shared reader-description enrichment, used by every tool that attaches a
 * reader's human-readable `DESCRIPTION` to a record carrying a `READERKEY`
 * (currently `get_access_history` and `get_card_access_details`'s
 * `RESOLVEDESCRIPTIONS` path, plus `get_reader_access_history`'s single
 * top-level field -- see `specs/get-access-history-resolve-descriptions.md`
 * R1-R4).
 *
 * Unlike `src/personEnrichment.ts` (one person-lookup call per distinct
 * `PERSONID`, since there is no bulk person-fetch command), the reader table
 * is small and unfiltered: the reader-list command already returns every
 * reader regardless of how many records are being enriched, and
 * `src/portalSearch.ts` already proved the fetch-and-join-by-`READERKEY`
 * pattern this module reuses via `fetchAllPages` (`src/paging.ts`) -- no
 * second pagination loop. So this module always does exactly one full
 * paginated reader-list walk per call, never a per-record lookup.
 *
 * Per-request only, same as `personEnrichment.ts`: no cache persists between
 * separate calls to this module (see the spec's "Out of scope").
 */

/**
 * R1: fetches every reader via a fully paginated reader-list walk and
 * builds a `READERKEY -> DESCRIPTION` map. A reader whose `READERKEY`
 * normalizes to the empty string is skipped (not a real reader identity to
 * key on), so the map never gains a bogus `'' -> description` entry that
 * could wrongly match a record whose own `READERKEY` happens to be empty.
 */
export async function fetchReaderDescriptions(client: NetboxClient): Promise<Map<string, string>> {
  const readers = await fetchAllPages(client, NBAPI_COMMANDS.GET_READERS, 'READERS', 'READER');
  const descriptionsByReaderKey = new Map<string, string>();
  for (const reader of readers) {
    const readerKey = text(reader.READERKEY);
    if (readerKey === '') continue;
    descriptionsByReaderKey.set(readerKey, text(reader.DESCRIPTION));
  }
  return descriptionsByReaderKey;
}

/**
 * R2: attaches `READERDESCRIPTION` to each of `records` by calling
 * `fetchReaderDescriptions` exactly once regardless of how many records are
 * passed (never once per record -- the reader table is small and
 * unfiltered, so one full-table fetch already covers every possible
 * `READERKEY`). A record whose `READERKEY` has no match in the fetched map
 * (an unknown or deleted reader) gets `READERDESCRIPTION: ''` rather than
 * throwing.
 *
 * R2b: if the `fetchReaderDescriptions` call itself throws (e.g. a
 * transient/permissions failure on the underlying GetReaders fetch --
 * distinct from R2's per-record "no match in the map" case, which isn't a
 * failure at all), that error is caught here rather than propagated. Since
 * `RESOLVEDESCRIPTIONS` defaults to `true` (R3/R4), an enrichment hiccup
 * must never silently break the primary call for every caller who didn't
 * even explicitly ask for descriptions -- every record is returned with
 * `READERDESCRIPTION: ''`, exactly as if every `READERKEY` were simply
 * unmatched. Mirrors `enrichWithPersonNames`'s existing per-`PERSONID`
 * failure isolation, generalized to this module's single all-or-nothing
 * fetch (there's no smaller unit to isolate a failure to here, so the whole
 * fetch degrades together rather than throwing).
 */
export async function enrichWithReaderDescriptions<T extends { READERKEY: string }>(
  client: NetboxClient,
  records: T[]
): Promise<(T & { READERDESCRIPTION: string })[]> {
  let descriptionsByReaderKey: Map<string, string>;
  try {
    descriptionsByReaderKey = await fetchReaderDescriptions(client);
  } catch {
    descriptionsByReaderKey = new Map();
  }
  return records.map((record) => ({
    ...record,
    READERDESCRIPTION: descriptionsByReaderKey.get(record.READERKEY) ?? '',
  }));
}
