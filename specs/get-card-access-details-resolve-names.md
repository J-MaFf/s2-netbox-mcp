# Spec: `RESOLVENAMES` person-name enrichment for `get_card_access_details`

## Goal

Let callers of `get_card_access_details` opt in to having the card's owner name resolved
alongside the card's access records, reusing the same person-enrichment machinery already built
for `get_access_history`.

## Context

This project is `s2-netbox-mcp`. `get_card_access_details` (`src/tools/person.ts`) is an existing,
published, always-registered pass-through tool wrapping NBAPI's `GetCardAccessDetails` command.

**Verified live response shape (checked this session, not assumed):**

```json
{
  "PERSONID": "_41",
  "DISABLED": "0",
  "EXPDATE": "null",
  "ACCESSES": {
    "ACCESS": [
      { "LOGID": "49809", "DTTM": "...", "NODEDTTM": "...", "TYPE": "1", "REASON": "",
        "READERKEY": "52", "PORTALKEY": "18", "PORTALNAME": "02RB06" }
    ]
  },
  "NEXTLOGID": "49805"
}
```

The critical difference from `get_access_history`/`get_reader_access_history`: **`PERSONID`
appears exactly once, at the top level** — a card belongs to one person, so every access record
in the response shares the same person. This is a much simpler enrichment than those two tools'
per-record case: **one `GetPerson` lookup per tool call**, not one per distinct `PERSONID` across
many records.

This session already built the reusable piece this needs:
`src/personEnrichment.ts` exports `PersonEnrichment` (`FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES`,
all `string`) and `enrichWithPersonNames<T extends { PERSONID: string }>(client, records: T[]):
Promise<(T & PersonEnrichment)[]>`, built for `get_access_history` and `get_reader_access_history`
(see `specs/archive/get-reader-access-history.md` and the `get_access_history` RESOLVENAMES spec).
Reuse it here rather than writing a third enrichment implementation — a single-element array
input (`[{ PERSONID: topLevelPersonId }]`) exercises the exact same function correctly, since it
already handles the "one distinct PERSONID" case as its simplest path.

**Current schema** (`src/tools/person.ts`, `get_card_access_details` registration):
`ENCODEDNUM` (required), `CARDFORMAT` (required), `MAXRECORDS` (optional), `OLDESTDTTM`
(optional). Note: `OLDESTDTTM`'s actual behavior on this controller is **unverified** this
session — unlike `get_access_history`'s now-confirmed-broken `OLDESTDTTM`/`NEWESTDTTM`, this is a
different NBAPI command and hasn't been tested. Leave it exactly as-is; do not touch it as part of
this spec (auditing it is out of scope — same boundary this project already draws around
`get_access_history`'s `ORDER` parameter).

**Not in scope here:** reader/portal description enrichment (`PORTALNAME` in this tool's output is
a site-code, not a description — same issue documented for the other access-record tools). That's
covered by a separate spec (`specs/get-access-history-resolve-descriptions.md`) that also touches
this tool; keep this spec limited to `RESOLVENAMES` only so each PR stays scoped to one feature.

## Deliverable

- `src/tools/person.ts` — **modified**: `get_card_access_details` gains `RESOLVENAMES`.
- `test/tools.test.ts` (or wherever `get_card_access_details` is currently tested — grep for it
  first) — **modified**: new test cases for `RESOLVENAMES` true/false.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_card_access_details`'s Zod schema gains `RESOLVENAMES: z.boolean().optional()`
  (matching the existing project convention — see `dryRun` in the unlock-window tools, and
  `get_access_history`'s own `RESOLVENAMES` from the sibling spec), defaulting to `false`/off when
  omitted. `ENCODEDNUM`, `CARDFORMAT`, `MAXRECORDS`, `OLDESTDTTM` are unchanged. [verify: a test
  asserts `Object.keys(schema).sort()` equals exactly `['CARDFORMAT', 'ENCODEDNUM', 'MAXRECORDS',
  'OLDESTDTTM', 'RESOLVENAMES'].sort()`]
- R2. When `RESOLVENAMES` is omitted or `false`, behavior is byte-identical to before this change:
  `runNbapiTool(client, NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, mergeParams(otherParams))`, no
  `GetPerson` call ever made. [verify: a unit test with `RESOLVENAMES` omitted and one with it
  explicitly `false` both assert exactly one `GetCardAccessDetails` call, zero `GetPerson` calls]
- R3. When `RESOLVENAMES` is `true`: call `GetCardAccessDetails` once with the other params
  (unchanged), read the top-level `PERSONID` from the response, and — unless it's the empty string
  (see R4) — call the shared `enrichWithPersonNames` (`src/personEnrichment.ts`) with a
  single-element array containing just that `PERSONID`, then merge the four resulting fields
  (`FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES`) onto the **top level** of the response object
  (alongside `PERSONID`, `DISABLED`, `EXPDATE`) — not onto each `ACCESS` record, since they all
  share the same person. `ACCESSES`/`NEXTLOGID` and everything else in the response are otherwise
  unchanged. [verify: a unit test with `RESOLVENAMES: true` and a scripted response asserts the
  top-level result has `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` alongside the original
  `PERSONID`/`DISABLED`/`EXPDATE`/`ACCESSES`/`NEXTLOGID` fields, with exactly one `GetPerson` call
  made]
- R4. If the top-level `PERSONID` is the empty string (or absent), `RESOLVENAMES: true` still
  succeeds: no `GetPerson` call is made, and the four enrichment fields are set to empty strings.
  [verify: a unit test with a scripted response whose `PERSONID` is `''` asserts zero `GetPerson`
  calls and empty-string enrichment fields]
- R5. `RESOLVENAMES` never changes error or not-found handling — only the shape of a *successful*
  result, mirroring R4 of the `get_access_history` RESOLVENAMES spec exactly. [verify: a unit test
  with `RESOLVENAMES: true` and a scripted `notFound` response asserts the standard not-found
  text; a unit test with `RESOLVENAMES: true` and a thrown `NbapiFailError` asserts the standard
  mapped error text]
- R6. If the single `GetPerson` lookup itself fails (thrown error, or not-found-shaped result),
  the tool call still succeeds with empty-string enrichment fields — matching
  `enrichWithPersonNames`'s existing failure-isolation behavior (R5 of the `get_access_history`
  spec), exercised here through its single-element-array path. [verify: a unit test where
  `GetPerson` throws asserts the tool call still returns successfully with empty-string
  `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES`]
- R7. The tool description is updated to state what `RESOLVENAMES` does (a single lookup for the
  card's owner, not per-record — call out that this is cheaper than `get_access_history`'s
  per-record enrichment, since there's exactly one person per card) and its default (`false`).
  [verify: a test asserts the description string contains "RESOLVENAMES"]
- R8. `README.md`'s documentation of `get_card_access_details` documents `RESOLVENAMES`.
  [verify: `grep -n RESOLVENAMES README.md` finds an entry for this tool, distinct from the
  `get_access_history` one]
- R9. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_card_access_details` and
  `RESOLVENAMES`]
- R10. `scripts/live-check.ts`'s existing `get_card_access_details` smoke-check (if one exists —
  check first) is extended to exercise `RESOLVENAMES: true` against the real controller. If no
  existing smoke-check covers this tool yet, add one. [verify: `npm run test:live` output shows
  this case exercised, PASS]

## Out of scope

- Reader/portal description enrichment for this tool — covered by the separate
  `RESOLVEDESCRIPTIONS` spec.
- Any change to `OLDESTDTTM`'s behavior, correctness, or documentation — unverified, untouched,
  out of scope (same boundary as `get_access_history`'s `ORDER` parameter).
- Cross-request/TTL caching — none; this is a single lookup per call, caching would add complexity
  for no real benefit here.
- Any write/mutation capability — stays a read tool, always registered.
- Any change to the 80-command NBAPI allowlist (`GetPerson`/`GetCardAccessDetails` are both
  already allowlisted).

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- Reuse `src/personEnrichment.ts`'s `enrichWithPersonNames` as-is — do not write a second,
  parallel single-person enrichment implementation.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff tests prove `RESOLVENAMES` omitted/false produce the pre-change call with
  zero `GetPerson` calls.
- C3 (from R3): PASS iff a test proves the enrichment fields land at the top level (not per
  record) with exactly one `GetPerson` call.
- C4 (from R4): PASS iff a test proves an empty `PERSONID` skips the lookup and produces
  empty-string fields.
- C5 (from R5): PASS iff tests prove not-found/error handling are identical regardless of
  `RESOLVENAMES`.
- C6 (from R6): PASS iff a test proves a `GetPerson` failure still yields a successful call with
  empty-string fields.
- C7 (from R7): PASS iff the description string mentions "RESOLVENAMES".
- C8 (from R8): PASS iff README.md documents `RESOLVENAMES` for this specific tool.
- C9 (from R9): PASS iff CHANGELOG.md's `[Unreleased]` section names this addition.
- C10 (from R10): PASS iff `npm run test:live` (or a description of a manual run) shows this case
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation reuses `personEnrichment.ts` without duplicating its logic.

## Open questions

None.
