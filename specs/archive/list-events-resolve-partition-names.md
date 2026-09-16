# Spec: `RESOLVEPARTITIONNAMES` partition-name enrichment for `list_events`

## Goal

Let `list_events` resolve each event's bare `PARTITIONID` into a human-readable partition name by
default, instead of requiring a separate `get_partitions` call to find out which partition an
event actually belongs to.

## Context

This project is `s2-netbox-mcp`. `list_events` (`src/tools/events.ts:96-101`) is an existing,
always-registered pass-through tool wrapping NBAPI's `ListEvents` command.

**Verified live response shape** (checked this session against the real controller):

```json
{
  "EVENTS": {
    "EVENT": [
      { "ID": "1", "NAME": "Front Lobby Intercom Unlock Event", "PARTITIONID": "1",
        "ACTIONS": { "ACTION": ["Log Event", "Unlock Door"] } },
      { "ID": "8", "NAME": "Front Lobby Auto Operator 01OF01A", "PARTITIONID": "1",
        "ACTIONS": { "ACTION": ["Log Event", "action 2", "Action 1"] } }
    ]
  },
  "NEXTKEY": "-1"
}
```

`PARTITIONID` is a bare foreign key with no accompanying name in the same record.

**Confirmed live, this session, that this is the same key space as `get_partitions`'
`PARTITIONKEY`**: `get_partitions` on this controller returns exactly one partition,
`{PARTITIONKEY: "1", NAME: "Master", DESCRIPTION: "The default partition"}`, matching every
event's `PARTITIONID: "1"` seen above.

**This is a genuine but low-value gap on single-partition controllers** (like the one this session
verified against) — `PARTITIONNAME` will always resolve to the same value. It is more useful on a
multi-partition S2 Global installation. It is included in this enrichment batch anyway because it
is cheap (one small, bounded `GetPartitions` fetch, not scaling with anything) and follows the
established pattern exactly.

**Flag name and default**: `RESOLVEPARTITIONNAMES`, plural to match `list_events` returning
multiple events that each carry their own `PARTITIONID`. Defaults to **`true`** (opt-out) — this
codebase's established rule is that a fixed-cost lookup (one full-table fetch regardless of result
size) defaults on, and `GetPartitions` is fetched at most once per call regardless of how many
events are returned.

**New sibling field, not replacing anything**: `PARTITIONNAME` is added onto each `EVENT` record,
alongside its existing `ID`/`NAME`/`PARTITIONID`/`ACTIONS` — matching this codebase's "new fields
are always additive" rule. `ACTIONS` and every other field are unchanged.

**No existing partition-name-fetch helper exists yet** in this codebase (`get_partitions`
itself is the only reader of `GetPartitions`, and it returns the raw pass-through, not a
`Map`-shaped lookup). This spec creates one, `src/partitionNames.ts`, mirroring
`src/readerDescriptions.ts`'s exact shape (a `Map`-returning fetch function that never throws).

## Deliverable

- `src/partitionNames.ts` — **new file**: `fetchPartitionNames(client): Promise<Map<string, string>>`.
- `src/tools/events.ts` — **modified**: `list_events` gains `RESOLVEPARTITIONNAMES`.
- `test/tools.test.ts` (or wherever `list_events` is currently tested — grep for it first) —
  **modified**: new test cases.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `list_events`'s Zod schema gains `RESOLVEPARTITIONNAMES: z.boolean().optional()`, defaulting
  to `true` when omitted (opt-out). `list_events` currently takes no other parameters. [verify: a
  test asserts `Object.keys(schema).sort()` equals exactly `['RESOLVEPARTITIONNAMES']`]
- R2. When `RESOLVEPARTITIONNAMES` is effectively true (omitted or explicitly `true`): after
  calling `ListEvents`, fetch partition names via `fetchPartitionNames` **once** (regardless of how
  many events are returned), then for every event in the response, add `PARTITIONNAME` as a new
  sibling field resolved from its `PARTITIONID` (`''` if the `PARTITIONID` has no match in the
  fetched map). Every other field on every event is unchanged. [verify: a unit test with a
  scripted multi-event `ListEvents` response plus a scripted `GetPartitions` response asserts
  every event gains a correct `PARTITIONNAME`, with exactly one `GetPartitions` call regardless of
  how many events are in the response, and an unmatched `PARTITIONID` resolves to `PARTITIONNAME: ''`]
- R3. When `RESOLVEPARTITIONNAMES` is explicitly `false`: no `GetPartitions` call is made, and
  events are returned exactly as `ListEvents` provides them (no `PARTITIONNAME` key added) —
  byte-identical to this tool's behavior before this change. [verify: a unit test with
  `RESOLVEPARTITIONNAMES: false` asserts zero `GetPartitions` calls and no `PARTITIONNAME` key on
  any event]
- R4. `RESOLVEPARTITIONNAMES` never changes error handling — only the shape of a *successful*
  result. (`ListEvents` has no documented not-found case distinct from an error, per the existing
  tool's plain pass-through behavior — only error handling applies here.) [verify: a unit test
  with `RESOLVEPARTITIONNAMES: true` (the default) and a scripted `ListEvents` error asserts the
  same error text as without this change, and that no `GetPartitions` call is made]
- R5. If `fetchPartitionNames` itself fails (the underlying `GetPartitions` call throws), every
  event's `PARTITIONNAME` resolves to an empty string and the call still succeeds with every
  event's other fields (including `ACTIONS`) intact — never let an enrichment failure lose the
  primary data, matching `fetchReaderDescriptions`'s established failure-safety shape. [verify: a
  unit test where the underlying `GetPartitions` call throws asserts the tool call still returns
  successfully, with every event's `PARTITIONNAME: ''` and `ACTIONS`/other fields still correct]
- R6. The tool description is updated to state what `RESOLVEPARTITIONNAMES` does, that it defaults
  to `true`, and that it costs one `GetPartitions` fetch per call (not per event). [verify: a test
  asserts the description string contains "RESOLVEPARTITIONNAMES"]
- R7. `README.md`'s documentation of `list_events` documents `RESOLVEPARTITIONNAMES`. [verify:
  `grep -n RESOLVEPARTITIONNAMES README.md` finds an entry for `list_events`]
- R8. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `list_events` and
  `RESOLVEPARTITIONNAMES`]
- R9. `scripts/live-check.ts`'s existing `list_events` smoke-check (if one exists — check first)
  is extended to confirm at least one event on a real response has a non-empty `PARTITIONNAME`
  after this change. If no existing smoke-check covers this tool yet, add one. [verify: `npm run
  test:live` output shows this exercised, PASS]

## Out of scope

- Any change to `get_partitions` itself — it remains the plain pass-through source of truth.
- `get_event_history`'s CSV-formatted response — confirmed this session to carry no `PERSONID`/
  `READERKEY`/`PARTITIONID`/other foreign-key field at all (`LogID, Time, EventName, Type, Reason`
  only), so there is nothing to resolve there; untouched by this spec.
- `ACTIONS` — already plain human-readable strings, not a gap.
- Cross-request/TTL caching of the fetched partition-name map.
- Any write/mutation capability.
- Any change to the 80-command NBAPI allowlist (`GetPartitions` is already allowlisted).

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff a test proves every event gains a correct `PARTITIONNAME` with exactly one
  `GetPartitions` call, including the no-match case.
- C3 (from R3): PASS iff a test proves `RESOLVEPARTITIONNAMES: false` makes zero `GetPartitions`
  calls and adds no new key.
- C4 (from R4): PASS iff a test proves error handling is unaffected.
- C5 (from R5): PASS iff a test proves a `GetPartitions` failure still yields a successful call
  with every event's `PARTITIONNAME` empty and other fields intact.
- C6 (from R6): PASS iff the description string mentions "RESOLVEPARTITIONNAMES".
- C7 (from R7): PASS iff README.md documents `RESOLVEPARTITIONNAMES` for `list_events`.
- C8 (from R8): PASS iff CHANGELOG.md names this addition.
- C9 (from R9): PASS iff `npm run test:live` (or a description of a manual run) shows this
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation creates `src/partitionNames.ts` following
  `src/readerDescriptions.ts`'s never-throws convention.

## Open questions

None.
