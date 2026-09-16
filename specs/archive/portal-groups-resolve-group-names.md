# Spec: `RESOLVEGROUPNAMES` group-name enrichment for `get_portal_groups` (plural)

## Goal

Let `get_portal_groups` (the plural, paginated list tool) resolve each returned group's bare
`UNLOCKTIMESPECGROUPKEY` foreign key into a human-readable time spec group name by default — the
explicitly-deferred follow-on to the singular `get_portal_group`'s already-merged
`RESOLVEGROUPNAMES` (`specs/archive/portal-group-resolve-group-names.md`).

## Context

This project is `s2-netbox-mcp`. `get_portal_groups` (`src/tools/portalGroup.ts:110-115`) is an
existing, always-registered pass-through tool wrapping NBAPI's `GetPortalGroups` command — a
single Zod field today, `STARTFROMKEY: z.string().optional()` (confirmed:
`test/portalGroupTools.test.ts:271` asserts `Object.keys(schema)` equals exactly
`['STARTFROMKEY']`).

**This is the explicitly-planned follow-on to the sibling spec.** The already-merged
`specs/archive/portal-group-resolve-group-names.md`'s "Out of scope" section states verbatim:
"`get_portal_groups` (plural) — same `UNLOCKTIMESPECGROUPKEY`/`THREATLEVELGROUPKEY` shape per
group; if this tool also needs `RESOLVEGROUPNAMES`, that is a follow-on spec, not this one." This
spec is that follow-on.

**Verified response shape — each plural-list item is already flat, with no per-item wrapper.**
This is the single most important fact distinguishing this spec from its singular sibling.
`GetPortalGroup` (singular) nests a single result's fields one level deeper under a `PORTALGROUP`
key (`src/tools/portalGroup.ts:47-56`'s doc comment; the defensive unwrap this requires is at
`src/tools/portalGroup.ts:92-97`: `'PORTALGROUP' in topLevel ? asRecord(topLevel.PORTALGROUP) :
topLevel`) — a controller quirk discovered live during that spec's own forge run. `GetPortalGroups`
(plural) has **no such per-item wrapper**: its documented shape
(`specs/archive/s2-netbox-mcp-write.md:713`) is `DETAILS.PORTALGROUPS.PORTALGROUP[]`, an array of
already-flat objects, each shaped `{PORTALGROUPKEY, NAME, DESCRIPTION, PORTALS, UNLOCKTIMESPECGROUPKEY,
THREATLEVELGROUPKEY}` (`specs/archive/s2-netbox-mcp-write.md:712-713` — the singular command's own
documented shape, which every plural-list item mirrors). This spec's implementation must **not**
apply the singular tool's `'PORTALGROUP' in details` unwrap to each list item — it is specific to
the singular command's own response envelope, not to the shape of a portal group record itself.
Each list item is mapped directly, the same flat-list-mapping pattern `get_portals`'s
`RESOLVEDESCRIPTIONS` already uses over `PORTALS.PORTAL[]` (`src/tools/portal.ts:93-100`).

**Reuses the exact same flag name, default, and shared module as the singular tool.** `true`
(opt-out) — resolving every group's `UNLOCKTIMESPECGROUPKEY` on a page costs exactly one fixed-size
`GetTimeSpecGroups` fetch via `fetchTimeSpecGroupNames` (`src/timeSpecGroupNames.ts`, already
merged), built **once per call** regardless of how many groups are on the page — not once per
group. This is the key design difference from the singular tool's own implementation
(`src/tools/portalGroup.ts:83-107`): the singular tool does at most one *conditional* fetch (only
if its single `UNLOCKTIMESPECGROUPKEY` is non-empty); this plural tool should build the map once
whenever at least one group on the page carries a non-empty key, then look each group up against
that same map (matching `get_time_spec_groups`'s `RESOLVEMEMBERNAMES` precedent of one shared fetch
serving every item on the page — `src/tools/timeSpec.ts`, `specs/archive/time-spec-groups-resolve-member-names.md`).

**New sibling field, not replacing anything**: `UNLOCKTIMESPECGROUPNAME` is added onto each group
in the list, alongside its existing `PORTALGROUPKEY`/`NAME`/`DESCRIPTION`/`PORTALS`/
`UNLOCKTIMESPECGROUPKEY`/`THREATLEVELGROUPKEY`. The `PORTALS` sub-list (already `{PORTALKEY, NAME}`
per portal) and `THREATLEVELGROUPKEY` are both left exactly as-is — same reasoning as the singular
spec: `PORTALS` is already human-readable, and `THREATLEVELGROUPKEY` has no NBAPI read command to
resolve it against.

## Deliverable

- `src/tools/portalGroup.ts` — **modified**: `get_portal_groups` gains `RESOLVEGROUPNAMES`.
- `test/portalGroupTools.test.ts` — **modified**: new test cases, mirroring the existing
  `describe('get_portal_group RESOLVEGROUPNAMES ...)` block's conventions (`:53-265`) for the
  plural tool's list-shaped equivalent.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_portal_groups`'s Zod schema gains `RESOLVEGROUPNAMES: z.boolean().optional()`,
  defaulting to `true` when omitted (opt-out). `STARTFROMKEY` is unchanged. [verify: a test asserts
  the schema has exactly `STARTFROMKEY` and `RESOLVEGROUPNAMES`]
- R2. When `RESOLVEGROUPNAMES` is effectively true (omitted or explicitly `true`): after fetching
  the requested page of portal groups, call `fetchTimeSpecGroupNames` **once** if at least one
  group on the page has a non-empty `UNLOCKTIMESPECGROUPKEY` (zero calls if every group's key is
  empty), then for every group on that page, add `UNLOCKTIMESPECGROUPNAME` resolved from its own
  `UNLOCKTIMESPECGROUPKEY` (`''` for an empty key or a key with no match in the fetched map). Every
  other field on every group (`PORTALGROUPKEY`, `NAME`, `DESCRIPTION`, `PORTALS`,
  `THREATLEVELGROUPKEY`) is unchanged, and each group's own item shape stays flat (no
  `'PORTALGROUP' in item` unwrap applied). [verify: a unit test with a scripted multi-group page
  (including a mix of matching, non-matching, and empty `UNLOCKTIMESPECGROUPKEY` values) asserts
  every group gains the correct `UNLOCKTIMESPECGROUPNAME`, with exactly one `GetTimeSpecGroups`
  call regardless of how many groups are on the page]
- R3. When `RESOLVEGROUPNAMES` is explicitly `false`: no `GetTimeSpecGroups` call is made, and
  groups are returned exactly as `GetPortalGroups` provides them (no `UNLOCKTIMESPECGROUPNAME` key
  added to any group) — byte-identical to this tool's behavior before this change. [verify: a unit
  test with `RESOLVEGROUPNAMES: false` asserts zero `GetTimeSpecGroups` calls and no
  `UNLOCKTIMESPECGROUPNAME` key on any group]
- R4. If every group on the page has an empty/absent `UNLOCKTIMESPECGROUPKEY`, no `GetTimeSpecGroups`
  call is made at all (not even one), and every group gets `UNLOCKTIMESPECGROUPNAME: ''`. [verify: a
  unit test with a page of groups that all have empty `UNLOCKTIMESPECGROUPKEY` asserts zero
  `GetTimeSpecGroups` calls]
- R5. If the underlying `fetchTimeSpecGroupNames` fetch fails, every group's
  `UNLOCKTIMESPECGROUPNAME` resolves to an empty string and the call still succeeds with every
  group's other fields (including `PORTALS`) intact — never let an enrichment failure lose the
  primary data. [verify: a unit test where the underlying `GetTimeSpecGroups` call throws asserts
  the tool call still returns successfully, with every group's `UNLOCKTIMESPECGROUPNAME: ''` and
  `PORTALS`/other fields still correct]
- R6. `RESOLVEGROUPNAMES` never changes error or not-found handling — only the shape of a
  *successful* result. [verify: a unit test with `RESOLVEGROUPNAMES: true` (the default) and a
  scripted not-found/error `GetPortalGroups` response asserts the same not-found/error text as
  without this change, and that no `GetTimeSpecGroups` call is made]
- R7. The tool description is updated to state what `RESOLVEGROUPNAMES` does, that it defaults to
  `true`, and that it costs at most one `GetTimeSpecGroups` fetch per call (not per group).
  [verify: a test asserts the description string contains "RESOLVEGROUPNAMES"]
- R8. `README.md`'s documentation of `get_portal_groups` documents `RESOLVEGROUPNAMES`, distinct
  from the singular `get_portal_group`'s own entry. [verify: `grep -n RESOLVEGROUPNAMES README.md`
  finds an entry for `get_portal_groups`]
- R9. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_portal_groups` and
  `RESOLVEGROUPNAMES`]
- R10. `scripts/live-check.ts`'s existing `get_portal_groups` smoke-check (if one exists — check
  first) is extended to confirm at least one group on a real page has a non-empty
  `UNLOCKTIMESPECGROUPNAME` after this change. If no existing smoke-check covers this tool yet, add
  one. [verify: `npm run test:live` output shows this exercised, PASS]

## Out of scope

- `THREATLEVELGROUPKEY` resolution — no NBAPI read command for threat level groups exists.
- The `PORTALS` sub-list — already `{PORTALKEY, NAME}`, not a gap.
- Any change to `get_portal_groups`' own `STARTFROMKEY`/pagination behavior — only the content of
  whatever page is returned changes.
- Any change to the already-merged singular `get_portal_group` tool.
- Cross-request/TTL caching of the fetched group-name map.
- Any write/mutation capability.
- Any change to the 80-command NBAPI allowlist.

## Constraints

- Reuse `fetchTimeSpecGroupNames` from `src/timeSpecGroupNames.ts` as-is — do not write a second,
  parallel fetch-and-map implementation.
- Do not apply the singular `get_portal_group`'s `'PORTALGROUP' in details` defensive unwrap to
  plural-list items — confirmed each item is already flat.
- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff a test proves every group gains the correct `UNLOCKTIMESPECGROUPNAME`
  with exactly one `GetTimeSpecGroups` call, including a mix of matching/non-matching/empty keys
  on the same page.
- C3 (from R3): PASS iff a test proves `RESOLVEGROUPNAMES: false` makes zero `GetTimeSpecGroups`
  calls and adds no new key to any group.
- C4 (from R4): PASS iff a test proves an all-empty-key page makes zero `GetTimeSpecGroups` calls.
- C5 (from R5): PASS iff a test proves a `GetTimeSpecGroups` failure still yields a successful call
  with every group's name empty and other fields (including `PORTALS`) intact.
- C6 (from R6): PASS iff a test proves not-found/error handling is unaffected by
  `RESOLVEGROUPNAMES`.
- C7 (from R7): PASS iff the description string mentions "RESOLVEGROUPNAMES".
- C8 (from R8): PASS iff README.md documents `RESOLVEGROUPNAMES` for `get_portal_groups`.
- C9 (from R9): PASS iff CHANGELOG.md's `[Unreleased]` section names this addition.
- C10 (from R10): PASS iff `npm run test:live` (or a description of a manual run) shows this case
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation reuses `fetchTimeSpecGroupNames` without reimplementing it and
  without applying the singular tool's `PORTALGROUP`-unwrap to list items.

## Open questions

None.
