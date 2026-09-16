# Spec: `get_reader_access_history` composite tool

## Goal

Add a read-only MCP tool that scans a bounded window of the most recent system-wide access
(grant/deny) records for matches against one reader, with each match's `PERSONID` enriched to a
name — something the raw `GetAccessHistory` pass-through cannot do today, since it has no
reader/portal filter at all.

**Revision note (this version supersedes an earlier draft's date-range design):** an earlier
draft of this spec tried to bound the scan by a `STARTDATE`/`ENDDATE` date range. Two rounds of
live verification found that design unworkable: (1) the correct NBAPI field names for date
filtering are `STARTDATE`/`ENDDATE`, not the `OLDESTDTTM`/`NEWESTDTTM` first assumed (that error
also exists in the pre-existing `get_access_history` tool — tracked separately as issue #47, not
fixed here); (2) even with the correct names, the live controller does **not** actually filter by
them when paginating via `AFTERLOGID` — a request scoped to "the last 30 days" still returned a
record from 2025-11-07. Chasing a real date range further would have meant binary-searching for a
LOGID boundary via unverified `STARTLOGID` behavior — real added complexity for a use case
(investigating rarely-used readers) that a hard date cutoff might not even serve well, since a
rarely-used reader can legitimately have zero events in any given recent window. This version
drops date-range filtering entirely: the tool scans a fixed-size window of the most recent N
system-wide records instead, which is simpler, needs no date parameters, and costs the same fixed
amount of work regardless of how large the access-history table grows.

## Context

This project is `s2-netbox-mcp` (see `README.md`, `CLAUDE.md`, `STATUS.md` for full background):
a Node/TypeScript MCP server wrapping LenelS2 S2 NetBox's NBAPI. It already has several
**composite** read tools that add client-side logic on top of raw NBAPI pass-through commands
when the API itself can't do what's needed directly — `find_portals` (`src/portalSearch.ts` +
registration in `src/tools/portal.ts`) is the closest precedent and should be mirrored closely.

**Why this tool is needed:** four readers on the live controller have no `DESCRIPTION`
(`01UT02C`, `Employee Gate Exterior`, `Employee Gate Interior`, `01OF18 HR`), so they can't be
found by location via `find_portals`. Seeing who actually badges through a given reader (and
inferring their department/role) is one practical way to figure out what physical room/door an
undocumented reader is. This spec covers only the new tool, not filling in those descriptions.

**Verified facts (checked against the live controller this session, not assumed):**

- `GetAccessHistory` (already in `NBAPI_COMMANDS`, see `src/commands.ts`) has no `READERKEY` or
  `PORTALKEY` request parameter — see its existing registration in `src/tools/events.ts`. But
  every returned `ACCESS` record already carries both fields:
  ```json
  { "LOGID": "49861", "PERSONID": "00208", "READER": "02OF01B READER", "READERKEY": "190",
    "PORTALKEY": "57", "DTTM": "2026-09-15 19:26:42", "NODEDTTM": "...", "TYPE": "1", "REASON": "" }
  ```
  So filtering by reader is only possible client-side, over every record.
- Calling `GetAccessHistory` with no `AFTERLOGID` returns the most recent records, **newest LOGID
  first** (e.g. `49955, 49954, 49953, ...`), with a `NEXTLOGID` in the response. **A single such
  call with `MAXRECORDS: '1'` is therefore a cheap way to discover the current maximum `LOGID`** —
  this is the seed for R1's scan window.
- **Confirmed this response's `NEXTLOGID` is not a usable backward-continuation cursor.** Passing
  it back as `AFTERLOGID` just resumes the ordinary ascending walk from a much earlier point,
  unrelated to "the next older page." No backward/descending pagination mechanism is verified to
  exist for this command — `AFTERLOGID`'s forward/ascending walk (next bullet) is the only
  reliable pagination mechanism found.
- Calling `GetAccessHistory` **with `AFTERLOGID` set** (confirmed: `AFTERLOGID=49856` after the
  above) returns records in **ascending** LOGID order (`49857, 49858, 49859, ...`), and
  `NEXTLOGID` equals `max(LOGID in this page) + 1` — safe to pass directly as next call's
  `AFTERLOGID` to continue forward through time with no gaps or duplicates. This is the only walk
  direction this spec uses.
- There is no `NEXTKEY: "-1"`-style terminal sentinel for this command (unlike the
  `STARTFROMKEY`/`NEXTKEY` commands `src/paging.ts` already handles) — the stop condition (a page
  shorter than requested, or empty) is inferred from `GetAccessHistory`'s documented `MAXRECORDS`
  parameter semantics, not directly observed against the live edge of history.
- **The live controller's access-history table currently spans roughly LOGID 236 to ~49,955
  (~49,700 records)**, confirmed this session, and grows continuously. A full-table forward walk
  from `LOGID 0` (an earlier draft's design) would need ~249 pages at 200 records/page — this is
  exactly why R1/R2 instead scan a small, fixed-size window seeded near the current maximum.
- The real NBAPI date-range field names for this command are `STARTDATE`/`ENDDATE` (confirmed via
  the controller's own validation error text), not the `OLDESTDTTM`/`NEWESTDTTM` used by the
  pre-existing `get_access_history` tool (a separate, real bug — tracked as issue #47, not fixed
  here). This tool doesn't use either pair — see the Goal's revision note for why date-range
  filtering was dropped entirely.
- `src/paging.ts`'s `fetchAllPages`/`fetchAllPagesWith` are hard-wired to the
  `STARTFROMKEY`/`NEXTKEY` shape (see its own docstring) and are the wrong fit here — this tool
  needs its own, separate pagination loop for the `AFTERLOGID`/`NEXTLOGID` shape. Do not modify
  `src/paging.ts`.
- The existing test convention for a composite tool's pagination/filtering logic is a scripted
  fake client, not the stateful `test/fakeNetbox.ts` double (that exists for write-tool
  round-trips). See `test/portalSearch.test.ts`'s `scriptedClient` helper (serves scripted pages
  per command in call order, records every call made) and mirror it.
- A composite tool's MCP registration returns `{ content: [{ type: 'text', text:
  formatAsJson(result) }] }` wrapped in try/catch with `toolErrorResult(err)` (both from
  `src/toolHelpers.ts`) — see `find_portals`'s registration in `src/tools/portal.ts` (not
  `runNbapiTool`, which is for direct pass-through commands only).
- `GetPerson` is already in `NBAPI_COMMANDS` (`GET_PERSON`) and is already read-only/always
  registered — no new NBAPI command or allowlist change is needed anywhere in this spec.
  `test/commandAllowlist.test.ts`'s 80-command count and confinement check are unaffected.
- Live person records include `FIRSTNAME`/`LASTNAME` (confirmed earlier this session via
  `search_person_data`); some `PERSONID`s observed in access history are operator-style
  (`_5`, `_10`) rather than plain numeric IDs — `GetPerson` may fail or return not-found for
  these, which must not fail the whole tool call (see R7).

## Deliverable

- `src/readerAccessHistory.ts` — new module, mirroring `src/portalSearch.ts`'s shape: exported
  pure/testable function(s) plus one top-level async function that drives the NBAPI calls.
- `src/tools/events.ts` — add the new tool registration (import from the new module), alongside
  the existing `get_access_history`/`get_event_history`/`list_events` registrations.
- `test/readerAccessHistory.test.ts` — new unit test file, following `test/portalSearch.test.ts`'s
  `scriptedClient` convention.
- Updates to `scripts/live-check.ts`, `README.md`, and `CHANGELOG.md` per R10–R12 below.

## Requirements

- R1. A pure exported function in `src/readerAccessHistory.ts` (e.g.
  `fetchReaderAccessHistory(client, readerKey, options)`) first calls `GetAccessHistory` once with
  `MAXRECORDS: '1'` and no `AFTERLOGID` to discover the current maximum `LOGID` (`maxLogid`, parsed
  from the single returned record). It then computes `seedLogid = Math.max(0, maxLogid -
  scanWindow)` (`scanWindow` from R5), and begins the walk with `AFTERLOGID: String(seedLogid)`.
  [verify: a unit test scripts the discovery call returning a record with a known `LOGID`, then
  asserts the first walk call's `AFTERLOGID` equals `maxLogid - scanWindow` for a given
  `scanWindow`]
- R2. The walk continues forward using `AFTERLOGID`: each call after the first uses the previous
  response's `NEXTLOGID` as `AFTERLOGID` (per the verified ascending-walk behavior in Context),
  with a fixed `MAXRECORDS` per call (implementer's choice of a reasonable page size, e.g. 200).
  The walk stops at whichever of these happens first: (a) the total number of records scanned
  across all walk calls reaches `scanWindow`; (b) a page returns fewer records than the requested
  `MAXRECORDS`, or zero records (the live edge of history); (c) the number of matches already
  found (post-`READERKEY`-filter, see R4) reaches `MAXMATCHES` (R8). [verify: a unit test where
  cumulative scanned records reach `scanWindow` exactly at a page boundary asserts no further call
  is made; a unit test with a short/empty final page asserts the same; a unit test where matches
  reach `MAXMATCHES` mid-scan asserts the walk stops early without exhausting `scanWindow`]
- R3. A safety cap (a new constant local to this module or file, distinctly named from
  `paging.ts`'s `MAX_PAGES` to avoid confusion — e.g. `MAX_ACCESS_HISTORY_PAGES`) bounds total
  walk calls regardless of `scanWindow`, as defense-in-depth against a misbehaving `NEXTLOGID`
  sequence (it should not be reachable in normal operation given R2's `scanWindow` stop condition
  — set it comfortably above `scanWindow / pageSize` for the default `scanWindow`, e.g. 50).
  Exceeding it throws an `Error` naming the command and the cap, in the same style as
  `fetchAllPagesWith`'s existing overrun error. [verify: a unit test scripts more walk calls than
  the cap, each returning a full page (so R2's stop conditions never trigger), and asserts the
  thrown error's message names the cap]
- R4. Every fetched `ACCESS` record is kept only if its `READERKEY` exactly (string) equals the
  requested `readerKey`. [verify: a unit test scripts a page mixing records for multiple
  `READERKEY`s and asserts only the matching ones appear in the result]
- R5. The pure function's options include `scanWindow` (a positive integer, default **2000** when
  omitted) — the number of most-recent system-wide records to scan, per the Goal's revision note.
  There are no date-range parameters anywhere in this tool. [verify: a unit test omitting
  `scanWindow` asserts a `seedLogid` computed against the default 2000; a unit test passing an
  explicit `scanWindow` asserts it's used instead of the default]
- R6. When `maxLogid - scanWindow < 0` (fewer total records exist than the requested window), the
  clamp in R1 (`Math.max(0, ...)`) means `seedLogid` is `0` and the walk simply covers the entire
  (smaller) table once, ending via R2's short/empty-page condition rather than erroring. [verify:
  a unit test where `maxLogid` is smaller than `scanWindow` asserts the first walk call uses
  `AFTERLOGID: '0'` and the function returns normally, without throwing]
- R7. For every distinct `PERSONID` present in the final (post-filter, post-`MAXMATCHES`, see R8)
  match set, call `GetPerson` **once per distinct `PERSONID`** (never once per record) and attach
  `FIRSTNAME`/`LASTNAME` to every matching record sharing that `PERSONID`. If the `GetPerson` call
  throws or returns a not-found-shaped result for a given `PERSONID`, that record's
  `FIRSTNAME`/`LASTNAME` are set to empty strings and the tool call still succeeds (does not
  throw). [verify: a unit test with two matching records sharing one `PERSONID` asserts exactly
  one `GetPerson` call; a unit test where `GetPerson` throws for one `PERSONID` asserts the tool
  still returns successfully with that record's name fields empty, and other records unaffected]
- R8. Register a new MCP tool `get_reader_access_history` unconditionally (always available, not
  gated by `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` — matching `get_access_history`,
  `find_portals`, `get_unlock_window`) in `src/tools/events.ts`. Zod schema: `READERKEY` (required
  string), `SCANWINDOW` (optional string, default `"2000"` when omitted, parsed to the pure
  function's `scanWindow`), `MAXMATCHES` (optional string, default `"100"` when omitted) capping
  the number of matches included in the result. When the number of matches found exceeds
  `MAXMATCHES`, include only the first `MAXMATCHES` (in chronological order) and set a
  `truncated: true` field in the result; otherwise `truncated: false`. [verify: a unit test with
  more matches than `MAXMATCHES` asserts the result contains exactly `MAXMATCHES` records and
  `truncated: true`; a unit test with fewer matches than `MAXMATCHES` asserts `truncated: false`
  and all matches present]
- R9. The tool's description string (passed to `server.tool(...)`) states: what it wraps
  (`GetAccessHistory`), that there is no server-side reader filter so this reads and filters
  client-side, and that it scans the most recent `SCANWINDOW` system-wide records (default 2000)
  rather than a date range — matching this project's existing style of composite-tool descriptions
  (see `find_portals`'s description in `src/tools/portal.ts`). [verify: a test asserts the
  registered tool's description string contains a mention of "no" + "filter" (case-insensitive)
  and "2000"]
- R10. Add the new tool to `scripts/live-check.ts`'s opt-in read-only smoke test, calling it
  against a real `READERKEY` from the live controller (e.g. reuse a key the script already knows
  about) and asserting the call succeeds without error. [verify: `npm run test:live` output shows
  `get_reader_access_history` exercised alongside the other read tools, PASS]
- R11. Document `get_reader_access_history` in README.md's list/table of read tools, describing it
  the same way as R9's tool description (briefly). [verify: `grep -n get_reader_access_history
  README.md` finds an entry outside of any changelog-style section]
- R12. Add a `CHANGELOG.md` entry for this tool under `[Unreleased]` -> `### Added`, following this
  repo's existing Keep a Changelog conventions (one bullet, past tense, linking the eventual
  issue/PR once known — a placeholder issue number is acceptable if written before the issue
  exists, per this repo's own established practice of filing the issue as part of implementation).
  [verify: `CHANGELOG.md`'s `[Unreleased]` section has a bullet mentioning
  `get_reader_access_history`]

## Out of scope

- **Date-range filtering of any kind** (`STARTDATE`/`ENDDATE` or otherwise) — see the Goal's
  revision note. The tool scans by record-count window (`SCANWINDOW`) only. Do not add date
  parameters back in.
- Backward/descending pagination, or any attempt to seek to an arbitrary point in history other
  than the most-recent-N window this spec defines — no verified mechanism for it exists (see
  Context).
- Filtering by `PORTALKEY` or resolving a reader/portal by **name** — `READERKEY` only, per
  explicit decision during spec review. (`find_portals` already exists for name-based portal
  discovery; this tool assumes the caller already has a `READERKEY`, e.g. from `get_readers`,
  `get_portals`, or `find_portals`'s own output.)
- Any change to `src/commands.ts`'s 80-command allowlist (no new NBAPI commands are needed).
- Any write/mutation capability whatsoever — this is a pure read/composite tool and must never be
  gated behind `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE`, nor may it call any command
  outside `GetAccessHistory`/`GetPerson`.
- Modifying `src/paging.ts`'s existing `STARTFROMKEY`/`NEXTKEY` helpers or their tests — the new
  pagination loop is separate and local to `src/readerAccessHistory.ts`.
- A live *write* smoke test entry (`scripts/live-check-write.ts` / `live-check-write-daily.ts`) —
  this tool is read-only and belongs only in `scripts/live-check.ts`.
- Enriching anything other than `PERSONID` → name (e.g. do not also resolve `READERKEY` back to a
  description or name — the caller already supplied the `READERKEY` they're asking about).
- Caching, persisting, or de-duplicating results across separate tool calls.
- Actually filling in the four missing reader `DESCRIPTION`s on the NetBox controller — that is a
  separate, manual, physical-world task this tool merely assists with.

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- Reuse `formatAsJson`, `toolErrorResult`, `ToolTextResult` from `src/toolHelpers.ts` for the MCP
  tool's result shape (see Context — this is a composite tool, not a `runNbapiTool` pass-through).
- No invented NBAPI field names anywhere (project-wide rule; see `src/commands.ts`'s own
  docstring and README's read-only-server philosophy) — every parameter name sent to
  `GetAccessHistory`/`GetPerson` must already appear in their existing tool registrations in this
  codebase.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean (this repo's CI now
  requires this — see `.github/workflows/ci.yml`).
- Follow this repo's issue-first workflow (see `CONTRIBUTING.md`): open a GitHub issue before
  implementing, branch as `feat/<short-description>`, reference `Fixes #N` in the PR, update
  `CHANGELOG.md` in the same PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a unit test proves the `MAXRECORDS:'1'` discovery call happens first, and
  the first walk call's `AFTERLOGID` equals `maxLogid - scanWindow`.
- C2 (from R2): PASS iff unit tests prove all three stop conditions independently: `scanWindow`
  reached, a short/empty page, and `MAXMATCHES` reached mid-scan — each with no further call made.
- C3 (from R3): PASS iff a unit test exceeding the page cap observes a thrown error naming the cap.
- C4 (from R4): PASS iff a unit test with mixed-`READERKEY` scripted data shows only the requested
  reader's records in the result.
- C5 (from R5): PASS iff a unit test with no `scanWindow` shows the default 2000 used to compute
  `seedLogid`, and a unit test with an explicit `scanWindow` shows it used instead.
- C6 (from R6): PASS iff a unit test where `maxLogid < scanWindow` shows `AFTERLOGID: '0'` used
  and the function completing without error.
- C7 (from R7): PASS iff a unit test proves exactly one `GetPerson` call per distinct matched
  `PERSONID`, and a separate test proves a `GetPerson` failure for one person does not fail the
  whole tool call or affect other records' results.
- C8 (from R8): PASS iff a unit test proves `MAXMATCHES` truncation behavior and the `truncated`
  flag in both the truncated and non-truncated cases.
- C9 (from R9): PASS iff the registered tool's description string can be shown (by test or direct
  inspection) to mention both the no-server-filter fact and the default 2000-record scan window.
- C10 (from R10): PASS iff `npm run test:live` output (or a description of a manual run against
  the live controller) shows `get_reader_access_history` exercised successfully.
- C11 (from R11): PASS iff README.md contains a description of the new tool in its read-tools
  documentation.
- C12 (from R12): PASS iff CHANGELOG.md's `[Unreleased]` section names the new tool.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and a domain expert familiar with this codebase's existing composite-tool pattern
  (`find_portals`) would accept this tool's implementation as consistent with it without
  substantive changes.

## Open questions

None.
