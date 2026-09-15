# Spec: S2 NetBox MCP Server — Daily Recurring Unlock Window

## Goal
Add a companion to the existing managed unlock window feature that expresses "unlock these doors
from *dailyStartTime* to *dailyEndTime*, every day from *startDate* through *endDate*" — a single
partial-day window that recurs daily across a date range — which the existing `schedule_unlock_window`
cannot express (it models one continuous span, so a multi-day request keeps doors unlocked
overnight on the days strictly between the first and last).

## Context

### Where this builds on
- Repo `J-MaFf/s2-netbox-mcp`, currently `v0.1.1`, `main` clean, 0 open issues (`STATUS.md`,
  verified this session). Tool surface: 35 read tools with writes off, 72 with
  `NETBOX_ENABLE_WRITES`, 83 with `NETBOX_ENABLE_DESTRUCTIVE` as well (`STATUS.md`).
- The existing managed unlock window feature (`specs/archive/s2-netbox-mcp-write.md`, R22-R28,
  **completed and live-verified**) is the direct precedent for this spec's mechanism, naming
  scheme, and rigor. Read that file's Context before touching this feature — it is the
  authoritative record of every NBAPI quirk this spec inherits (session login, XML shapes, the
  `GetTimeSpecGroup` NOT-FOUND quirk, `Modify*Group` needing the complete membership every time,
  the "group names are unique across group types" collision, the 30-holiday/8-holiday-group caps,
  `ENDDATE` exclusive / `ENDTIME` inclusive-through-its-minute). Do not re-derive any of that here.
- Verified this session by reading the current source directly:
  - `src/unlockWindow/planner.ts` — `planUnlockWindow` is pure, takes `(start, end, groups, prefix)`
    as full date-*times*, and always produces 1-3 segments (`first`/`middle`/`last`) because a
    continuous span's middle days need a full `00:00`-`23:59` grant. There is no code path that
    produces "the same partial time range on every day" — that is the gap this spec fills.
  - `src/unlockWindow/executor.ts` — `scheduleUnlockWindow`'s 8-step apply order (managed TSG,
    per-segment holiday+time spec, TSG membership, delete stale segments, managed portal group,
    read-back, rollback-on-failure) is the pattern this spec's simpler (always-one-segment) apply
    order follows.
  - `src/unlockWindow/managed.ts` — the shared fetch/normalise helpers (`fetchPortals`,
    `fetchHolidays`, `fetchTimeSpecs`, `fetchTimeSpecGroups`, `fetchPortalGroups`,
    `fetchPortalGroup`, `sameSet`, `keyList`, `normalizeGroups`, `normalizeTime`,
    `normalizeDateTime`, `normalizeFlag`, `MANAGED_DESCRIPTION`, `NEVER_GROUP_NAME`, `WEEKDAYS`) are
    generic over any managed-object naming scheme and **must be reused, not duplicated**, by this
    feature's implementation.
  - `src/tools/unlockWindow.ts` — confirms `get_unlock_window` is always registered and
    `schedule_unlock_window`/`cancel_unlock_window` are gated on `gate.writesEnabled` only (not
    `NETBOX_ENABLE_DESTRUCTIVE` — the managed objects' own deletes are server-owned cleanup, not
    user-data deletion). This feature's three tools follow the same gating.

### The gap, and how we worked around it live this session (2026-09-15)
A user asked to unlock "all doors from 5 AM to 10 PM, tomorrow (Wed) through Saturday" — the same
`05:00`-`22:00` window repeating on each of 4 consecutive days, locked overnight every night.
`schedule_unlock_window(start="2026-09-16 05:00", end="2026-09-19 22:00")` would have produced a
`middle` segment covering `2026-09-17`/`2026-09-18` at `00:00`-`23:59` — unlocked all night both
nights — which is wrong for this request.

We built it by hand with the primitive write tools instead of the composite tool: one Holiday
(`STARTDATE 2026-09-16 00:00`, `ENDDATE 2026-09-20 00:00` exclusive) in an unused holiday group +
one Time Spec (no weekdays, that holiday's group only, `STARTTIME 05:00`, `ENDTIME 22:00`) + one
Portal Group (target keys, `UNLOCKTIMESPECGROUPKEY` -> that time spec's group). This works because
a Time Spec with no weekdays and holiday group *G* ticked is active during its `STARTTIME`-`ENDTIME`
on **every** date covered by a holiday in group *G* (existing feature's Context, "live: GRAND
OPENING, user-confirmed working") — so a single holiday spanning the whole date range, paired with
one partial-day time spec, already expresses "same time-of-day window, every day in range" with no
segment-splitting needed. This spec turns that hand-built pattern into a tool.

### Live facts from this session's read-only investigation (2026-09-15)
- `GetPortals` currently returns **68** portals (one more than the `67` recorded in the prior
  spec — not load-bearing for this design, since the default target is always "every portal from
  `GetPortals`" regardless of count).
- `GetTimeSpecs` currently has exactly three time specs: `Always` (ticks holiday groups `1-8`),
  `Never` (ticks none), and a leftover `GRAND OPENING` spec (ticks group `1` only, no weekdays,
  `00:00`-`23:59`) from the prior feature's live testing.
- `GetHolidays` currently has exactly one holiday: `GRAND OPENING` (`HOLIDAYGROUPS 1`,
  `STARTDATE 2026-09-11 00:00:00`, `ENDDATE 2026-09-21 00:00:00`) — **live and currently active**,
  unrelated to this spec, left as found (out of scope to clean up here).
- Holiday groups `6`/`7`/`8` are `NETBOX_UNLOCK_HOLIDAY_GROUPS`'s default reserved set for the
  continuous feature; group `1` is occupied by the leftover `GRAND OPENING` spec above; groups
  `2`-`5` are unused by anything on this controller today. This spec's default
  (`NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP = 5`) was picked to avoid all of the above, and R1 makes the
  two features' groups mutually exclusive by construction rather than by convention alone.

### Design decisions (resolved here, not left open)
1. **A new set of three tools, not an extension of the existing ones.** `schedule_unlock_window`'s
   parameters are two datetime *instants*; this feature's natural parameters are a date range plus
   a separate daily time-of-day range — different enough that folding both into one schema would
   force an LLM caller to infer the mode from an extra flag rather than the parameter shape, and
   would conflate two different planning algorithms (1-3 segments vs. always exactly one) inside
   one function. New tools: `schedule_daily_unlock_window`, `cancel_daily_unlock_window`,
   `get_daily_unlock_window`.
2. **A single, dedicated reserved holiday group** (`NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP`, one
   integer), not a 3-group pool. Unlike the continuous feature, this feature's plan is always
   exactly one segment (R2) — there is no first/middle/last to reserve groups for.
3. **The two features are independent and may both be active at the same time.** They use disjoint
   holiday groups (enforced at config load, R1) and disjoint portal groups (different name
   prefixes), so they never share or contend for an NBAPI object. A currently-active continuous
   window is not special-cased by this feature's side-effect check (R5) — if the two windows'
   dates happen to overlap, that overlap is reported like any other foreign time spec, which is
   the correct, general behavior rather than a special case.
4. **Own `get`/`cancel` tools rather than generalizing the existing ones.** Keeps
   `get_unlock_window`/`schedule_unlock_window`/`cancel_unlock_window`'s response shapes and
   behavior completely stable for existing callers, and avoids a single status/cancel tool having
   to represent two independent schedules (which could exist, both, or neither) in one payload.

## Deliverable
Changes inside the repo, in the same worktree conventions as the existing feature:
- `src/config.ts` — `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` and `NETBOX_DAILY_UNLOCK_NAME_PREFIX` per R1.
- `src/unlockWindow/dailyPlanner.ts` (or equivalent) — a **pure** planner mirroring
  `planner.ts`'s separation of concerns (R2, R3), unit-testable without a controller.
- `src/unlockWindow/dailyExecutor.ts` (or equivalent) — the apply/cancel/get logic (R5-R9),
  built on the existing `managed.ts` helpers (reused, not duplicated).
- `src/tools/dailyUnlockWindow.ts` (or added to `src/tools/unlockWindow.ts`) —
  `registerDailyUnlockWindowTools`, wired into `src/index.ts` the same way as the existing three.
- `test/` — new vitest files covering R1-R10 as itemised in their verify clauses.
- `scripts/live-check-write.ts` (or a sibling script) — the opt-in daily-window phase, R11.
- `README.md`, `.env.example`, `CHANGELOG.md`, `STATUS.md`, `package.json` per R12-R13.

## Requirements

### Configuration
- R1. `loadConfigFromEnv` additionally reads `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` (default `5`; must
  parse as exactly one integer in `1..8`) and `NETBOX_DAILY_UNLOCK_NAME_PREFIX` (default
  `MCP Daily Unlock Window`; 1-40 characters, so `<prefix> time specs` fits the 64-character NAME
  limit). Startup fails with a one-line `NetboxConfigError` naming the variable and the rule when:
  `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` is not a single integer in `1..8`; or it equals any group in
  the resolved `NETBOX_UNLOCK_HOLIDAY_GROUPS` list (so the two features' reserved groups can never
  collide). [verify: config unit tests for the default, a valid override, an out-of-range value,
  and a value colliding with `NETBOX_UNLOCK_HOLIDAY_GROUPS`'s resolved groups]

### Planning (pure function)
- R2. Planning is a pure function of `(startDate, endDate, dailyStartTime, dailyEndTime,
  dailyGroup, dailyPrefix)` producing exactly **one** segment, always (no first/middle/last
  splitting): holiday `HOLIDAYNAME` = `<dailyPrefix> schedule`, `STARTDATE` = `startDate 00:00`,
  `ENDDATE` = `(endDate + 1 day) 00:00` (exclusive, matching the existing feature's convention);
  time spec `NAME` = `<dailyPrefix> schedule` (same name as the holiday — different object tables,
  no collision), `STARTTIME` = `dailyStartTime`, `ENDTIME` = `dailyEndTime`, all seven weekday
  flags `'0'`, `HOLIDAYGROUPS` = `dailyGroup`. The explicitly-managed time spec group is named
  `<dailyPrefix> time specs` (never `<dailyPrefix>` bare — that name is the portal group's, and an
  `AddTimeSpec` incidentally auto-creates its own same-named singular group, which is tolerated and
  otherwise unused, exactly as the existing feature tolerates it for its segment names). Required
  outputs (`dailyGroup=5`, `dailyPrefix="P"`):
  - `startDate="2026-09-16", endDate="2026-09-16", dailyStartTime="05:00", dailyEndTime="22:00"` ->
    holiday `2026-09-16 00:00` -> `2026-09-17 00:00`, spec `05:00`-`22:00`, group `5`.
  - `startDate="2026-09-16", endDate="2026-09-19", dailyStartTime="05:00", dailyEndTime="22:00"` ->
    holiday `2026-09-16 00:00` -> `2026-09-20 00:00`, spec `05:00`-`22:00`, group `5` (one segment
    covering all 4 dates — no `middle` day gets a different, full-day range).
  [verify: unit tests assert these two plans exactly]
- R3. Input validation, in this order, each returning `isError` with **zero** writes on failure:
  `startDate`/`endDate` must each be a real calendar date `YYYY-MM-DD`; `dailyStartTime`/
  `dailyEndTime` must each be a real `HH:MM`; `endDate` must be >= `startDate`; `dailyEndTime` must
  be later than `dailyStartTime` (same-day time-of-day only — an overnight-crossing daily window,
  e.g. `22:00` to `05:00`, is rejected: see Out of scope); the window's last instant
  (`endDate` at `dailyEndTime`, controller-local) must be later than the host's current time;
  `endDate - startDate` must be at most 31 days (mirrors the existing feature's `MAX_WINDOW_DAYS`);
  adding the one planned holiday (if a holiday named `<dailyPrefix> schedule` does not already
  exist) must not exceed the controller's 30-holiday-per-partition cap (count from `GetHolidays`);
  `portalKeys`, if given, must contain only keys returned by `GetPortals`. [verify: handler tests
  for each rejection, each asserting zero write commands]

### `schedule_daily_unlock_window`
- R4. Tool schema: `startDate`, `endDate` (required, `YYYY-MM-DD`); `dailyStartTime`,
  `dailyEndTime` (required, `HH:MM`); `portalKeys` (optional `string[]`; omitted = every portal
  from a fully paginated `GetPortals`); `acknowledgeSideEffects` (optional boolean, default
  `false`); `dryRun` (optional boolean, default `false`). Registered only when
  `NETBOX_ENABLE_WRITES` is truthy (not gated by `NETBOX_ENABLE_DESTRUCTIVE` — this tool's own
  deletes touch only its own managed objects). [verify: schema-key test; registration test under
  each flag combination]
- R5. Side-effect report, computed the same way as the existing feature's R24 (scoped to this
  tool's own plan and prefix): before writing, fetch every time spec (paginated `GetTimeSpecs`) and
  every holiday (`GetHolidays` + `GetHoliday` per key). `suppressedTimeSpecs` = time specs whose
  `NAME` is not `Never`, does not carry **this tool's own** managed prefix, and whose
  `HOLIDAYGROUPS` (comma-split) lacks the daily group. `overlappingHolidays` = holidays not
  carrying this tool's own prefix whose `[STARTDATE, ENDDATE)` intersects the plan's
  `[STARTDATE, ENDDATE)`. A currently-active continuous-window time spec or holiday (from
  `schedule_unlock_window`) is **not** excluded from this check — if its dates overlap this plan's
  dates it is reported like any other foreign object (see Context, Design decision 3). If
  `suppressedTimeSpecs` is non-empty and `acknowledgeSideEffects` is not `true`, the tool returns
  `isError` listing them (key, name, groups) and writes nothing. If `dryRun` is `true`, the tool
  returns the plan and this report and writes nothing, regardless of acknowledgement. [verify:
  fake-client tests: a foreign time spec lacking the daily group blocks the call, then is allowed
  with the flag; `dryRun` never writes; a simulated continuous-window time spec is reported like
  any other foreign spec, not excluded]
- R6. Apply order (each step's NBAPI calls in this sequence; a failure at any step stops the apply,
  best-effort deletes the managed holiday and time spec written so far this run — tolerating
  refusals — and returns `isError` naming the failed step, the controller's message, and what the
  rollback removed):
  1. Resolve targets: paginate `GetPortals`; validate `portalKeys`.
  2. Managed time spec group: find by exact `NAME` = `<dailyPrefix> time specs` in paginated
     `GetTimeSpecGroups`; if absent, `AddTimeSpecGroup(NAME, DESCRIPTION="Managed by s2-netbox-mcp; do not edit")`.
  3. Managed holiday: find by exact `NAME` = `<dailyPrefix> schedule`; `ModifyHoliday` to the
     planned `STARTDATE`/`ENDDATE`/`HOLIDAYGROUPS` if present, else `AddHoliday`.
  4. Managed time spec: find by exact `NAME` = `<dailyPrefix> schedule`; `ModifyTimeSpec` to the
     planned `STARTTIME`/`ENDTIME`/weekdays(`'0'`)/`HOLIDAYGROUPS` if present, else `AddTimeSpec`.
  5. `ModifyTimeSpecGroup(TIMESPECGROUPKEY=managed, TIMESPECKEYS=[the one time spec key from step 4])`.
  6. Managed portal group: find by exact `NAME` = `<dailyPrefix>` in paginated `GetPortalGroups`;
     `ModifyPortalGroup` (wrapped `<PORTALKEYS><PORTALKEY>…` shape, `UNLOCKTIMESPECGROUPKEY` =
     managed TSG) if present, else `AddPortalGroup`.
  7. Read back (`GetPortalGroup`; the managed TSG's entry from paginated `GetTimeSpecGroups` —
     never `GetTimeSpecGroup`, same controller quirk as the existing feature; `GetTimeSpec`;
     `GetHoliday`) and compare to the plan, normalising `TRUE`/`FALSE` <-> `1`/`0` and `HH:MM:SS`
     <-> `HH:MM`; any mismatch -> `isError` describing the field.
  8. Return `{ window:{startDate,endDate,dailyStartTime,dailyEndTime}, holidayKey, timeSpecKey,
     timeSpecGroupKey, portalGroupKey, holidayGroup, portals:[{PORTALKEY,NAME}],
     replacedPreviousWindow:boolean, sideEffects:{suppressedTimeSpecs,overlappingHolidays},
     verified:true }`.
  [verify: fake-client test recording the full command sequence for a first run (adds) and a
  second run with different times (modifies only, identical keys) and asserts the exact order]
- R7. `schedule_daily_unlock_window` is idempotent: calling it twice with identical arguments
  issues only Modify/Get calls on the second run (no Add, no Delete) and returns the same keys.
  [verify: fake-client test]

### `cancel_daily_unlock_window`
- R8. No parameters; registered only when `NETBOX_ENABLE_WRITES` is truthy. Resolves the built-in
  `Never` time spec group by exact `NAME` (fails clearly if absent). If the managed portal group
  (`<dailyPrefix>`) exists, `ModifyPortalGroup` sets its `UNLOCKTIMESPECGROUPKEY` to `Never`
  (re-sending its current `PORTALKEYS` from `GetPortalGroup`). Regardless, if the managed holiday
  (`<dailyPrefix> schedule`) exists, `DeleteHoliday` it. Then, best-effort:
  `ModifyTimeSpecGroup(managed TSG, TIMESPECKEYS=[])`, and if the managed time spec exists,
  `DeleteTimeSpec` it — a refusal of either is tolerated and reported under `leftBehind` rather
  than failing the call (the portal group, if any, already points at `Never` and no managed
  holiday exists, so nothing can unlock either way). Returns a normal (non-error) "nothing to
  cancel" result only when no managed object of any kind (portal group, time spec group, holiday,
  time spec) exists. Only objects named exactly `<dailyPrefix>`, `<dailyPrefix> time specs`, or
  `<dailyPrefix> schedule` are ever touched. [verify: fake-client tests for the full-cancel order,
  the tolerated-refusal path, and the nothing-to-cancel path]

### `get_daily_unlock_window`
- R9. Read-only, no parameters, **always registered** regardless of `NETBOX_ENABLE_WRITES`.
  Returns `{ prefix, configured:boolean, portalGroup:{PORTALGROUPKEY,NAME,portals,
  UNLOCKTIMESPECGROUPKEY,unlockTimeSpecGroupName,pointsAtManagedTimeSpecGroup}|null,
  timeSpecGroup:{TIMESPECGROUPKEY,NAME,TIMESPECKEYS}|null,
  timeSpec:{TIMESPECKEY,NAME,STARTTIME,ENDTIME,HOLIDAYGROUPS,inManagedGroup}|null,
  holiday:{HOLIDAYKEY,NAME,STARTDATE,ENDDATE,HOLIDAYGROUPS}|null,
  window:{startDate,endDate,dailyStartTime,dailyEndTime}|null, activeNow:boolean, checkedAt }`
  (singular `timeSpec`/`holiday`, not arrays — this feature never has more than one of each).
  `activeNow` is `true` iff: the portal group exists and points at the managed time spec group; the
  managed time spec's `HOLIDAYGROUPS` includes the managed holiday's group; today's date (host
  clock) falls within `[holiday STARTDATE, holiday ENDDATE)`; and the current time-of-day (host
  clock) falls within `[timeSpec STARTTIME, timeSpec ENDTIME]` inclusive. [verify: fake-client
  tests against a populated fixture (active; inactive because outside today's time-of-day) and an
  empty fixture]

### Naming and ownership
- R10. The daily tools never `Modify`/`Delete` a holiday, time spec, time spec group, or portal
  group whose `NAME` is not exactly `<dailyPrefix>`, `<dailyPrefix> time specs`, or
  `<dailyPrefix> schedule`; a user-created object with one of those names is treated as managed
  (names are the identity — mirrors the existing feature's R27). [verify: code review of the
  executor; test that a non-prefixed holiday overlapping the window (R5) is reported, not touched]

### Live verification
- R11. A new sibling script (e.g. `scripts/live-check-write-daily.ts`) run by its **own** npm
  script (e.g. `npm run test:live:write:daily`) — not chained onto `npm run test:live:write` with
  `&&`, because npm only forwards a trailing `-- --go` to the *last* script in a chain, which would
  silently redirect the existing, already-shipped `test:live:write -- --go` flag away from that
  script and break its documented behavior (Constraint: this feature must not change the existing
  feature's observable behavior). This new script gains an opt-in daily-window phase, gated
  identically to the existing write-check's phases: prints one "skipped" line and exits 0 without
  any network call unless the three
  credential vars, `NETBOX_ENABLE_WRITES=true`, and `NETBOX_LIVE_TEST_PORTALKEY` are all set.
  When it runs: (a) round-trips add -> get -> modify -> get -> delete for a time spec, time spec
  group, holiday, and portal group under a `MCP livecheck daily` prefix, asserting each read-back;
  (b) after the same controller-clock-skew guard (fails closed above 2 minutes skew) and the same
  user-notification-and-go-ahead gate as the existing write check's phase (c), schedules a real
  daily window covering only today's date with `dailyStartTime` = now + 2 min, `dailyEndTime` =
  now + 4 min on the designated test portal, asserts `verified:true`, prints an `OBSERVE:` line in
  the same style as the existing check, polls `get_daily_unlock_window` every 30 s printing
  `activeNow` until `dailyEndTime` + 1 min, then calls `cancel_daily_unlock_window` and asserts the
  portal group's `UNLOCKTIMESPECGROUPKEY` is `Never`'s key and no managed holiday or time spec
  remains; (c) never touches persons, credentials, access levels, threat levels, outputs, events,
  partitions, or UDF lists; (d) never prints the password; (e) exits non-zero on any assertion
  failure and, on a failure after the door phase began, still attempts
  `cancel_daily_unlock_window` before exiting. `npm test` never runs this script. [verify: run once
  with the vars unset (one line, exit 0); the user records in the completion note whether the
  portal was observed unlocked during the window and locked after it]

### Documentation and packaging
- R12. `README.md` gains a subsection (alongside "Scheduled unlock windows") titled exactly
  "Scheduled daily unlock windows" explaining: the holiday + time spec + portal group mechanism
  reused from the continuous feature; why no first/middle/last splitting is needed; the two new
  environment variables and their collision-safe defaults; the side-effect check; the
  single-managed-daily-window model and how to cancel; the 31-day cap; that an overnight-crossing
  daily window is not supported; and that the two features can be active at the same time because
  their holiday groups and portal groups never overlap (R1). The tools table gains
  `schedule_daily_unlock_window`, `cancel_daily_unlock_window`, `get_daily_unlock_window`. [verify:
  read the README for each item, including the exact heading]
- R13. `.env.example` documents `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` and
  `NETBOX_DAILY_UNLOCK_NAME_PREFIX` with their defaults and a one-line explanation each;
  `CHANGELOG.md` gains a new `[Unreleased]` (or versioned, if cut at build time) entry under
  `### Added` referencing the eventual GitHub issue and PR; `STATUS.md`'s tool-surface counts and
  Components table are updated to include the three new tools and their source files;
  `package.json`'s `version` is bumped one **minor** version above whatever is the current
  published version at build time (a new backward-compatible feature, per semver — `0.1.1` as of
  this spec). [verify: read each file]
- R14. `npm test`, `npm run typecheck`, and `npm run build` all succeed; the unit suite covers
  R1-R10 as itemised in their verify clauses, plus a schema-key test for each of the three tools.
  [verify: run the three commands; list test names]

## Out of scope
- Overnight-crossing daily windows (`dailyEndTime` <= `dailyStartTime`, e.g. `22:00`-`05:00`) —
  rejected by R3, not supported. A future spec could add this as two segments if ever needed.
- Per-weekday selectivity within the date range (e.g. "weekdays only, skip the weekend") — the
  whole `[startDate, endDate]` range unlocks every day at the given time-of-day; no day-of-week
  filtering. A plausible future extension, not built here.
- Extending or modifying `schedule_unlock_window`/`cancel_unlock_window`/`get_unlock_window` in any
  way (see Design decision 1/4) — they are untouched by this spec.
- Multiple concurrent *daily* windows (still one managed daily window at a time, identified by
  name under `NETBOX_DAILY_UNLOCK_NAME_PREFIX`, mirroring the existing feature's single-window
  model) — though one daily window and one continuous window may coexist (Design decision 3).
- Resolving portals by name in this feature's tools (keys only, matching the existing feature —
  `get_portals`/`find_portals` map names to keys).
- Automatically deleting the managed portal group or time spec group on cancel (they stay,
  pointing at `Never` / emptied, and are reused on the next `schedule_daily_unlock_window` call).
- Any scheduler on the MCP host (timers, Task Scheduler) — the controller is the only scheduler,
  exactly as in the existing feature.
- Confirmation prompts inside the server — the MCP host's permission model and
  `NETBOX_ENABLE_WRITES` are the controls, as with every other write tool in this repo.
- Cleaning up the leftover, currently-active `GRAND OPENING` holiday/time spec found during this
  session's investigation — unrelated to this feature, left for the user to address separately.
- Creating the GitHub issue, branch, or PR — done by the build step under this repo's git-policies
  (issue-first workflow), not by this spec.

## Constraints
- TypeScript/Node, `@modelcontextprotocol/sdk` stdio, zod, fast-xml-parser, undici — no new
  runtime dependencies, matching the existing feature.
- No secrets in tracked files; `.env` stays gitignored; the live script never prints
  `NETBOX_PASSWORD`; no test fixture or README example contains a real host, user, or password.
- Reuse `src/unlockWindow/managed.ts`'s existing helpers (fetchers, normalisers, `sameSet`,
  `keyList`, `MANAGED_DESCRIPTION`, `NEVER_GROUP_NAME`, `WEEKDAYS`) rather than duplicating them;
  the only new naming logic is this feature's own name-construction functions (mirroring
  `timeSpecGroupName`/`segmentName`/`carriesManagedPrefix` but for the single-segment scheme).
- Composite tools issue only commands already present in `NBAPI_COMMANDS` (no new NBAPI commands
  are needed — this feature reuses `AddHoliday`, `ModifyHoliday`, `DeleteHoliday`, `AddTimeSpec`,
  `ModifyTimeSpec`, `DeleteTimeSpec`, `AddTimeSpecGroup`, `ModifyTimeSpecGroup`, `AddPortalGroup`,
  `ModifyPortalGroup`, `GetPortals`, `GetHolidays`, `GetHoliday`, `GetTimeSpecs`,
  `GetTimeSpecGroups`, `GetPortalGroups`, `GetPortalGroup`, all already in `NBAPI_COMMANDS` and
  already documented in `specs/archive/s2-netbox-mcp-write.md`'s Command reference — no new
  Command reference section is needed in this spec).
- "Fully paginated" means following `NEXTKEY` per `src/unlockWindow/managed.ts`'s existing fetchers
  (which already implement this) — do not write a second paging loop.
- Managed object names: `<dailyPrefix>` for the portal group; `<dailyPrefix> time specs` for the
  time spec group (never the portal group's bare name — group names are unique across group
  types); `<dailyPrefix> schedule` for the one holiday and the one time spec; all <= 64 characters
  (so the prefix, default `MCP Daily Unlock Window`, is capped at 40).
- `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` must never be a member of the resolved
  `NETBOX_UNLOCK_HOLIDAY_GROUPS` list (R1) — this is what makes Design decision 3 (both features
  may run concurrently) true by construction rather than by convention.
- Live write checks run only via `npm run test:live:write`, never from `npm test`, matching the
  existing feature.

## Acceptance rubric
- C1 (R1): PASS iff config tests show the default, a valid override, a one-line rejection for an
  out-of-range `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP`, and a one-line rejection when it collides with
  `NETBOX_UNLOCK_HOLIDAY_GROUPS`.
- C2 (R2): PASS iff the two required plans (same-day and multi-day) are produced exactly, with
  always exactly one segment.
- C3 (R3): PASS iff each of the eight rejection cases returns `isError` with zero write commands.
- C4 (R4): PASS iff `schedule_daily_unlock_window` has exactly the listed schema keys and is
  registered only when `NETBOX_ENABLE_WRITES` is truthy, regardless of
  `NETBOX_ENABLE_DESTRUCTIVE`.
- C5 (R5): PASS iff a foreign time spec lacking the daily group blocks the call without writes,
  `acknowledgeSideEffects=true` unblocks it, `dryRun` never writes under any acknowledgement state,
  and a simulated concurrently-active continuous-window time spec is reported exactly like any
  other foreign time spec (not excluded).
- C6 (R6): PASS iff the recorded command sequences for a first run and a second (modify-only) run
  match the eight-step order exactly, and a read-back mismatch produces `isError`.
- C7 (R7): PASS iff a second identical call issues no Add/Delete commands and returns the same
  keys as the first call.
- C8 (R8): PASS iff cancel issues the stated sequence, tolerates refusal of the last two steps
  while still reporting the `Never` assignment and holiday deletion, and returns the "nothing to
  cancel" result only when no managed object exists.
- C9 (R9): PASS iff `get_daily_unlock_window` reports `activeNow` correctly for an active fixture,
  a fixture outside today's time-of-day, and an empty fixture, and is registered with
  `NETBOX_ENABLE_WRITES` unset.
- C10 (R10): PASS iff no code path modifies or deletes a non-prefixed object, and a non-prefixed
  holiday overlapping the plan's dates is reported by R5 but left untouched.
- C11 (R11): PASS iff the live script skips cleanly (one line, exit 0) without the gating vars,
  and — when run for real — completes the CRUD round-trip and the 2-minute door window with
  `verified:true`, ends with the portal group on `Never` and no managed holiday/time spec, never
  prints the password, and the user has recorded observing the door unlocked during the window and
  locked afterwards.
- C12 (R12): PASS iff `README.md` contains every item listed in R12, including the exact heading
  "Scheduled daily unlock windows".
- C13 (R13): PASS iff `.env.example`, `CHANGELOG.md`, `STATUS.md`, and `package.json` are updated
  exactly as R13 states.
- C14 (R14): PASS iff `npm test`, `npm run typecheck`, and `npm run build` all exit 0 and the
  listed coverage exists.
- C-final: PASS iff a security-conscious reviewer familiar with the existing managed unlock window
  feature and this session's live findings (the leftover `GRAND OPENING` holiday, the current
  holiday-group occupancy) would accept this feature as safe, correctly scoped, non-interfering
  with the existing feature, and faithful to the documented NBAPI commands, without substantive
  changes.

## Open questions
(none)
