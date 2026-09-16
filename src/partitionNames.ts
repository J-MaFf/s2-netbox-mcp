import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { asRecord, asRecordList, text } from './paging.js';

/**
 * Shared partition-name enrichment, used by `list_events`'s
 * `RESOLVEPARTITIONNAMES` path (src/tools/events.ts) to resolve a bare
 * `PARTITIONID` into its human-readable `NAME`.
 *
 * Mirrors `src/readerDescriptions.ts`'s `fetchReaderDescriptions` shape
 * exactly: a `Map`-returning fetch function that never throws. Unlike that
 * module (and `src/readerGroupNames.ts`/`src/timeSpecGroupNames.ts`), this
 * one does *not* walk `fetchAllPages` — the GetPartitions command takes no
 * STARTFROMKEY parameter at all (its documented PARAMS list is empty) and
 * this codebase has already verified live that it answers every partition
 * in a single response (NEXTKEY "-1" from the first and only call). So
 * this is always exactly one `client.call`, never a paginated walk — a
 * single small, bounded GetPartitions fetch per call, matching the spec's
 * "not scaling with anything" framing.
 *
 * Per-request only: no cache persists between separate calls to this module
 * (see the spec's "Out of scope").
 */

/**
 * R2/R5: fetches every partition via a single GetPartitions call and
 * builds a `PARTITIONKEY -> NAME` map. A partition whose `PARTITIONKEY`
 * normalizes to the empty string is skipped (not a real partition identity
 * to key on), so the map never gains a bogus `'' -> name` entry that could
 * wrongly match an event whose own `PARTITIONID` happens to be empty.
 *
 * This function itself never throws. If the underlying GetPartitions call
 * fails (a thrown error) or answers "not found", that outcome is caught
 * right here and the function resolves to an **empty** `Map` instead of
 * rejecting — the same failure-safety shape as
 * `fetchReaderDescriptions`/`fetchReaderGroupNames` (R5): since
 * `RESOLVEPARTITIONNAMES` defaults to `true` (opt-out), an enrichment
 * hiccup must never silently break the primary ListEvents call for a
 * caller who didn't even explicitly ask for partition names. An empty map
 * here is indistinguishable, by design, from "no partitions matched" —
 * callers treat an unmatched `PARTITIONID` as `PARTITIONNAME: ''` either
 * way.
 */
export async function fetchPartitionNames(client: NetboxClient): Promise<Map<string, string>> {
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_PARTITIONS, {});
    const namesByPartitionKey = new Map<string, string>();
    if (result.notFound) {
      return namesByPartitionKey;
    }
    const details = asRecord(result.data);
    const partitions = asRecordList(asRecord(details.PARTITIONS).PARTITION);
    for (const partition of partitions) {
      const partitionKey = text(partition.PARTITIONKEY);
      if (partitionKey === '') continue;
      namesByPartitionKey.set(partitionKey, text(partition.NAME));
    }
    return namesByPartitionKey;
  } catch {
    return new Map();
  }
}
