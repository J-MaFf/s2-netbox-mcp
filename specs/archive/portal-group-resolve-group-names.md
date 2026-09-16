# Spec: `RESOLVEGROUPNAMES` group-name enrichment for `get_portal_group`

## Goal

Let `get_portal_group` resolve its bare `UNLOCKTIMESPECGROUPKEY` foreign key into a human-readable
time spec group name by default, instead of requiring a separate `get_time_spec_groups` call to
find out which schedule actually governs the group's managed unlock.

## Context

This project is `s2-netbox-mcp`. `get_portal_group` (`src/tools/portalGroup.ts:21-25`) is an
existing, always-registered pass-through tool wrapping NBAPI's `GetPortalGroup` command.

**Verified live response shape — corrected post-generation.** The example originally here was
copied from a *plural* `get_portal_groups` call's per-item shape, not an independently verified
call to the *singular* `get_portal_group` tool this spec actually modifies — a lookup gap, not a
confirmed fact. The generator built against the flat shape below, found live testing broke (the
enrichment silently no-opped), and traced it to the real shape: the singular `GetPortalGroup`
command's `DETAILS` nests everything one level deeper, under a `PORTALGROUP` key — matching the
existing defensive unwrap already in `src/unlockWindow/managed.ts`'s `fetchPortalGroup`
(`'PORTALGROUP' in details ? asRecord(details.PORTALGROUP) : details`), which this spec's
implementation now also uses. Confirmed live, `PORTALGROUPKEY: "26"`:

```json
{
  "PORTALGROUP": {
    "PORTALGROUPKEY": "26",
    "NAME": "LAB ALL ACCESS",
    "DESCRIPTION": "ACCESS TO MAIN LAB DOORS",
    "PORTALS": { "PORTAL": { "PORTALKEY": "51", "NAME": "01OF20B" } },
    "UNLOCKTIMESPECGROUPKEY": "1",
    "THREATLEVELGROUPKEY": ""
  }
}
```

The `PORTALS` sub-list is already `{PORTALKEY, NAME}` per portal — already human-readable, not a
gap. `UNLOCKTIMESPECGROUPKEY` is a bare foreign key with no accompanying name — the same class of
gap the sibling spec `specs/archive/access-level-resolve-group-names.md` (build that spec first)
just fixed for `get_access_level`'s own `TIMESPECGROUPKEY`/`READERGROUPKEY`.

**This spec depends on, and reuses, the sibling spec's shared module** —
`specs/archive/access-level-resolve-group-names.md` introduces `src/timeSpecGroupNames.ts` with
`fetchTimeSpecGroupNames(client): Promise<Map<string, string>>` (`TIMESPECGROUPKEY -> NAME`, one
full paginated `GetTimeSpecGroups` fetch; verified live this session that the singular
`GetTimeSpecGroup` lookup fails `NOT FOUND` even for a genuinely existing group, so the paginated
list is the only reliable source). **Build that spec first**; this one imports from the module it
creates rather than duplicating the fetch-and-map logic.

**Flag name and default, matching the sibling spec exactly**: this reuses the exact same
`RESOLVEGROUPNAMES` flag name and `true`/opt-out default as `get_access_level`'s own
`RESOLVEGROUPNAMES` — it is the identical kind of lookup (a group key resolved against the same
`GetTimeSpecGroups` table) with the identical cost shape (`get_portal_group` returns exactly one
`UNLOCKTIMESPECGROUPKEY` per call, so resolving it always costs exactly one extra full-table
fetch, never scaling with anything). Reusing the same flag name across tools that do the same kind
of resolution keeps the convention legible; introducing a second, differently-named flag for the
same underlying lookup would be needless inconsistency.

**New sibling field, not replacing anything**: `UNLOCKTIMESPECGROUPNAME` is added alongside the
existing `UNLOCKTIMESPECGROUPKEY` — matching this codebase's "new fields are always additive" rule.

`THREATLEVELGROUPKEY` is present on this response too (confirmed live, empty string on this
controller) and is **out of scope** for the same reason as the sibling spec: no NBAPI read command
for threat level groups exists in this server's command surface.

## Deliverable

- `src/tools/portalGroup.ts` — **modified**: `get_portal_group` gains `RESOLVEGROUPNAMES`.
- `test/tools.test.ts` (or wherever `get_portal_group` is currently tested — grep for it first) —
  **modified**: new test cases.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_portal_group`'s Zod schema gains `RESOLVEGROUPNAMES: z.boolean().optional()`, defaulting
  to `true` when omitted (opt-out). `PORTALGROUPKEY` is unchanged and remains the only other field.
  [verify: a test asserts `Object.keys(schema).sort()` equals exactly
  `['PORTALGROUPKEY', 'RESOLVEGROUPNAMES'].sort()`]
- R2. When `RESOLVEGROUPNAMES` is effectively true (omitted or explicitly `true`): after calling
  `GetPortalGroup`, read `UNLOCKTIMESPECGROUPKEY` from the response. If non-empty, resolve its name
  via `fetchTimeSpecGroupNames` (imported from `src/timeSpecGroupNames.ts`, the sibling spec's
  module) and add `UNLOCKTIMESPECGROUPNAME` as a new sibling field on the response (alongside the
  existing `PORTALGROUPKEY`/`NAME`/`DESCRIPTION`/`PORTALS`/`UNLOCKTIMESPECGROUPKEY`/
  `THREATLEVELGROUPKEY`). An unmatched key resolves to an empty-string name. The `PORTALS` sub-list
  is unchanged. [verify: a unit test with a scripted `GetPortalGroup` response plus a scripted
  `GetTimeSpecGroups` list response asserts `UNLOCKTIMESPECGROUPNAME` is correctly populated with
  exactly one `GetTimeSpecGroups` call, and a separate test with a key that has no match in the
  fetched list asserts `UNLOCKTIMESPECGROUPNAME: ''`]
- R3. When `RESOLVEGROUPNAMES` is explicitly `false`: no `GetTimeSpecGroups` call is made, and the
  response is returned exactly as `GetPortalGroup` provides it (no `UNLOCKTIMESPECGROUPNAME` key
  added) — byte-identical to this tool's behavior before this change. [verify: a unit test with
  `RESOLVEGROUPNAMES: false` asserts exactly one `GetPortalGroup` call and zero
  `GetTimeSpecGroups` calls, and no new key on the result]
- R4. An empty/absent `UNLOCKTIMESPECGROUPKEY` skips the fetch entirely (no `GetTimeSpecGroups`
  call) and yields `UNLOCKTIMESPECGROUPNAME: ''`. [verify: a unit test with
  `UNLOCKTIMESPECGROUPKEY: ''` asserts zero `GetTimeSpecGroups` calls and
  `UNLOCKTIMESPECGROUPNAME: ''`]
- R5. If `fetchTimeSpecGroupNames` itself fails, `UNLOCKTIMESPECGROUPNAME` resolves to an empty
  string and the call still succeeds with the primary `GetPortalGroup` data (including `PORTALS`)
  intact. [verify: a unit test where the underlying `GetTimeSpecGroups` call throws asserts the
  tool call still returns successfully, with `UNLOCKTIMESPECGROUPNAME: ''` and `PORTALS` still
  present and correct]
- R6. `RESOLVEGROUPNAMES` never changes error or not-found handling for `GetPortalGroup` itself —
  only the shape of a *successful* result. [verify: a unit test with `RESOLVEGROUPNAMES: true`
  (the default) and a scripted not-found/error `GetPortalGroup` response asserts the same
  not-found/error text as without this change, and that no `GetTimeSpecGroups` call is made]
- R7. The tool description is updated to state what `RESOLVEGROUPNAMES` does and that it defaults
  to `true`. [verify: a test asserts the description string contains "RESOLVEGROUPNAMES"]
- R8. `README.md`'s documentation of `get_portal_group` documents `RESOLVEGROUPNAMES`.
  [verify: `grep -n RESOLVEGROUPNAMES README.md` finds an entry for `get_portal_group`, distinct
  from the `get_access_level` one]
- R9. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_portal_group` and
  `RESOLVEGROUPNAMES`]
- R10. `scripts/live-check.ts`'s existing `get_portal_group`/`get_portal_groups` smoke-check (if
  one exists — check first) is extended to confirm `RESOLVEGROUPNAMES: true` (the default)
  resolves a non-empty `UNLOCKTIMESPECGROUPNAME` against the real controller. If no existing
  smoke-check covers `get_portal_group` (singular, by key) yet, add one. [verify: `npm run
  test:live` output shows this case exercised, PASS]

## Out of scope

- `THREATLEVELGROUPKEY` resolution — no NBAPI read command for threat level groups exists.
- The `PORTALS` sub-list — already `{PORTALKEY, NAME}`, not a gap.
- `get_portal_groups` (plural) — same `UNLOCKTIMESPECGROUPKEY`/`THREATLEVELGROUPKEY` shape per
  group; if this tool also needs `RESOLVEGROUPNAMES`, that is a follow-on spec, not this one — this
  spec is scoped to the singular `get_portal_group` only, matching the "one issue per PR" decision
  made for this whole enrichment batch.
- Any write/mutation capability.
- Cross-request/TTL caching of the fetched group-name map.
- Any change to the 80-command NBAPI allowlist.

## Constraints

- Requires `specs/archive/access-level-resolve-group-names.md` to be implemented first —
  `src/timeSpecGroupNames.ts` must exist before this spec can import from it. Do not duplicate
  `fetchTimeSpecGroupNames`'s logic if that dependency isn't ready yet; block instead.
- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff a test proves `UNLOCKTIMESPECGROUPNAME` resolves correctly with exactly
  one `GetTimeSpecGroups` call, including the no-match case.
- C3 (from R3): PASS iff a test proves `RESOLVEGROUPNAMES: false` makes zero `GetTimeSpecGroups`
  calls and adds no new key.
- C4 (from R4): PASS iff a test proves an empty `UNLOCKTIMESPECGROUPKEY` skips the fetch and
  yields an empty name.
- C5 (from R5): PASS iff a test proves a `GetTimeSpecGroups` failure still yields a successful
  call with an empty-string name and intact `PORTALS`.
- C6 (from R6): PASS iff a test proves not-found/error handling is unaffected by
  `RESOLVEGROUPNAMES`.
- C7 (from R7): PASS iff the description string mentions "RESOLVEGROUPNAMES".
- C8 (from R8): PASS iff README.md documents `RESOLVEGROUPNAMES` for `get_portal_group`.
- C9 (from R9): PASS iff CHANGELOG.md's `[Unreleased]` section names this addition.
- C10 (from R10): PASS iff `npm run test:live` (or a description of a manual run) shows this case
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation imports `fetchTimeSpecGroupNames` from the sibling spec's
  module rather than reimplementing it.

## Open questions

None.
