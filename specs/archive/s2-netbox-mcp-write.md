# Spec: S2 NetBox MCP Server — Write Tools and Managed Unlock Windows

> **COMPLETED, 2026-09-15.** All 23 acceptance criteria + C-final PASS. Built via
> #8/[PR #10](https://github.com/J-MaFf/s2-netbox-mcp/pull/10) (stage 1: gating, 80-command
> allowlist, nested XML, event path, 18 read + 45 write tools) and
> #9/[PR #11](https://github.com/J-MaFf/s2-netbox-mcp/pull/11) (stage 2: `set_portals_state`,
> managed unlock windows, write live check). C20 was closed by the user standing at portal
> `02OF01A`: `npm run test:live:write -- --go` scheduled a 08:25–08:27 window, the strike released
> at 08:25 and re-engaged at the end of the 08:27 minute, and the script's cancel left no managed
> holiday or time spec behind (19/19). Three live findings amended this spec during the run and
> are recorded in Context: group names are unique across group types, Modify replaces group
> membership with the parsed list, and the controller clock was 4 h 35 min wrong (fixed by the
> user; the live check now measures skew). Archived as a historical record; see `CHANGELOG.md` /
> `STATUS.md` for current state.

## Goal
Extend the existing read-only S2 NetBox MCP server with the NBAPI's write/control commands as
environment-gated tools, and add a composite "unlock window" capability so that "unlock all doors
from <date-time> to <date-time>" is one tool call whose schedule the controller itself enforces
(no process has to stay alive to relock the doors).

## Context

### Where this builds on
- The repo is `C:\Users\jmaffiola\Documents\Scripts\s2-netbox-mcp` (GitHub `J-MaFf/s2-netbox-mcp`),
  currently v0.2.0 plus the unreleased `find_portals` door search (#6, merged as PR #7 on
  2026-09-14: 16 tools, 101 unit tests, `npm run test:live` 16/16), `main` clean, all read-only
  acceptance criteria passed and live-verified. The
  archived v1 spec `specs/archive/s2-netbox-mcp.md` is the authoritative record of every decision
  this spec inherits: XML envelope (`<NETBOX-API sessionid>` / `<COMMAND name num>` / `<PARAMS>`,
  uppercase element names, lowercase attributes), session login + cache + retry-once-on-APIERROR-5,
  the `APIERROR` / `FAIL`+`ERRMSG` / `NOT FOUND` error model, the NetBox 6.x path
  `/nbws/goforms/nbapi`, the R22 MAC-mode diagnostic, and the secrets rules. Do not re-derive them.
- Existing code and conventions to extend, not replace:
  - `src/commands.ts` — the closed `NBAPI_COMMANDS` map; the **only** file allowed to contain NBAPI
    command-name string literals (enforced by `test/commandAllowlist.test.ts`).
  - `src/xml.ts` — `buildRequestXml` / `buildParamsXml` (flat key→scalar today), `parseResponseXml`
    (fast-xml-parser, attributes as `@_`, no type coercion, so every field is a string).
  - `src/netboxClient.ts` — `NetboxClient.call(command, params)` → `{ notFound, data }`; throws
    `NbapiApiError` / `NbapiFailError`; `postXml` posts to `${baseUrl}${apiPath}`.
  - `src/toolHelpers.ts` — `runNbapiTool(client, command, params, formatSuccess?)` maps outcomes to
    MCP results (`isError` on APIERROR/FAIL; NOT FOUND is a normal result); `mergeParams`;
    `toolErrorResult(err)` for composite tools that call the client directly.
  - `src/portalSearch.ts` — `findPortals`, behind the one existing composite tool `find_portals`:
    reads every page of `GetPortals`/`GetReaders` following `NEXTKEY` (stops at `-1`, a missing or
    repeated key, or 100 pages) and joins readers by `READERKEY`. Its paging loop is the reference
    pattern for every "fully paginated" read in this spec.
  - `src/tools/{person,accessLevel,portal,events}.ts` — one `registerXxxTools(server, client)` per
    area; every tool except `find_portals` is a thin pass-through whose zod schema uses the documented PARAMS names
    verbatim, and returns the DETAILS block as pretty JSON.
  - `src/config.ts` — `loadConfigFromEnv`; boolean env flags parse as `/^(1|true|yes)$/i` (explicit
    opt-in only); startup misconfiguration is a one-line `NetboxConfigError`, never a stack trace.
  - `test/` — vitest; `test/testUtils.ts` has the hand-rolled fetch stub and canned
    `LOGIN_SUCCESS_XML` / `SUCCESS_XML` / `FAIL_XML` / `NOT_FOUND_XML` / `API_ERROR_XML` fixtures;
    `test/tools.test.ts` shows the `FakeServer` pattern for asserting registered tool names, schema
    keys, and the exact `client.call` arguments; `test/portalSearch.test.ts` shows how a composite
    tool is tested against a scripted fake client (paging, NOT FOUND, failure mapping) — the model
    for the R10 and R22–R28 tests.
  - `scripts/live-check.ts` (`npm run test:live`) — opt-in live smoke test; skips with one line when
    the three credential vars are unset; never prints the password; chains real keys from list
    responses; treats `ERRMSG="NOT FOUND"` on the two Access Level Group commands as an empty
    collection.
  - `README.md` currently states the server is "structurally incapable" of writes and calls
    `find_portals` "the one composite tool"; `CHANGELOG.md` (Keep a Changelog; its `[Unreleased]`
    block currently holds the `find_portals` bullet), `STATUS.md` (says 16 tools), `.env.example`,
    `package.json` (`"version": "0.1.0"` field is stale vs CHANGELOG 0.2.0 — bump to 0.3.0 with
    this work).

### Primary source (verified)
- "Web-Based API for S2 NetBox and S2 Global", LenelS2, February 2020, doc #API-UG-14. Local copy:
  `C:\Users\jmaffiola\.claude\projects\C--Users-jmaffiola-Documents-Tasks\9b02c63b-5b70-42ba-8ef1-bd9e89371a6e\tool-results\webfetch-1789396815900-v6cg0d.pdf`
  (201 pages, text-extractable with `pypdf`; **printed page number + 5 = PDF page index**). Every
  command in the "Command reference" section below was read from its own page; the printed page is
  cited per command so a reviewer can re-check any field name in seconds.
- Setting Up User Roles for the API (printed p. 17): the API user's role needs **Read-Write** API
  privilege (Configuration : Site Settings : User Roles → API Privilege) for any write command;
  Read-Only suffices for everything the v0.2.0 server does.
- Date Formats (printed p. 6): input dates are `YYYY-MM-DD HH:MM` or `YYYY-MM-DD` (time defaults
  to 00:00); all dates are the controller's **local time**; returned dates are
  `YYYY-MM-DD HH:MM:SS`.
- Time Specs and Time Spec Groups (printed p. 7): a time spec group is built from one or more time
  specs; the system ships with time specs *Always* and *Never* and same-named singular groups;
  "when a time spec is modified or deleted, any time spec group of which that time spec is a member
  is also modified or deleted"; *Always*/*Never* cannot be modified or deleted (ERRMSG "Cannot
  modify timespecs ALWAYS or NEVER" / "Cannot Delete timespecs ALWAYS or NEVER").
- Person Access Levels (printed p. 6–7): `ACCESSLEVELS` has two syntaxes — a list of bare
  `ACCESSLEVEL` names (on ModifyPerson this **replaces** all of the person's access levels), or
  `ACCESSLEVEL` blocks with `ACCESSLEVELNAME` + `DELETE` (0 add / 1 remove) + optional `ACTDATE`,
  `EXPDATE`, `AUTOREMOVE` (additive; unmentioned levels are kept).
- Event API (printed p. 27): the doc places `ListEvents`, `TriggerEvent` at `/appd/nbapi` and
  `StreamEvents` at `/appdevent/nbapi/event`. **Live fact:** `ListEvents` succeeds on the 6.x main
  path `/nbws/goforms/nbapi` (v1 live-check, 15/15 PASS), so the 6.x controller does not require
  the separate path for at least one Event-API command. `TriggerEvent` therefore defaults to the
  main path with an override env var (R6); this is the one command whose live behaviour is
  unverified (no harmless test event exists — see the live probe below).
- The AD-sync caution (printed p. 1): if person/access-level data is synced from Active Directory,
  NBAPI writes to those fields are overwritten on the next sync. Whether this controller syncs from
  AD is unknown → surfaced in the README and in the `modify_person`/`add_person` tool descriptions.

### Live facts (read-only probe of the user's NetBox 6.2.0 controller, 2026-09-14)
- `GetAPIVersion` → `6.2.0`. Single partition: `GetPartitions` → `Master`, `PARTITIONKEY` `1`.
- 67 portals (`GetPortals`, one page, `NEXTKEY` `-1`), names like `01OF01A`; readers keyed
  non-contiguously; `GetOutputs` lists the strike outputs (`<portal> EL`).
- Time specs (`GetTimeSpecs`): `1` **Always** (all weekdays `TRUE`, `STARTTIME` `00:00`,
  `ENDTIME` `23:59`, `HOLIDAYGROUPS` `1,2,3,4,5,6,7,8`); `2` **Never** (all `FALSE`, `00:00`–`00:00`,
  no groups); `3` **GRAND OPENING** (all weekdays `FALSE`, `00:00`–`23:59`, `HOLIDAYGROUPS` `1`).
  Read-back weekday values are the strings `TRUE`/`FALSE` although the doc's input format is `1`/`0`.
- Time spec groups: `1` Always → spec 1; `2` Never → spec 2; `28` GRAND OPENING → spec 3.
- Portal groups: `26` LAB ALL ACCESS (portal 51, `UNLOCKTIMESPECGROUPKEY` `1`); `29` GRAND OPENING
  UNLOCKED (portal 43 `01OF01A`, `UNLOCKTIMESPECGROUPKEY` `28`, `THREATLEVELGROUPKEY` empty) —
  renamed by the user to `Entrances` later the same day; match managed objects by name only
  for the managed prefix, never by these example names.
- **Controller quirk (verified twice, 2026-09-14):** `GetTimeSpecGroup` with a valid
  `TIMESPECGROUPKEY` (`1`, `28`) returns `CODE=FAIL`, `ERRMSG="NOT FOUND"` on this 6.2.0
  controller, while `GetTimeSpecGroups` lists those groups with their `TIMESPECKEYS`, and the
  sibling singular commands `GetTimeSpec`, `GetPortalGroup`, `GetReaderGroup` work by key.
  Consequence: anything that must read a time spec group's membership (R25 step 7, R26) does so
  from paginated `GetTimeSpecGroups` filtered by key, never from `GetTimeSpecGroup`; the
  `get_time_spec_group` tool still exists and surfaces the FAIL per R8, and the read live check
  treats that FAIL as an accepted quirk (R29).
- Holidays: `GetHolidays` → `HOLIDAYS` is the **comma-separated string** `"1"` (not a list of
  elements); `GetHoliday` `1` → `NAME` GRAND OPENING, `HOLIDAYGROUPS` `1`,
  `STARTDATE` `2026-09-11 00:00:00`, `ENDDATE` `2026-09-21 00:00:00`.
- **The user confirmed this GRAND OPENING configuration is exactly how they schedule an unlock
  window by hand:** a Holiday covering the dates, a Time Spec with *no weekdays* and only that
  holiday group ticked, and a Portal Group whose *Unlock Time Spec* is that time spec's group. It is
  active at the time of writing. This is the mechanism the composite tools automate.
- `GetEventHistory` returns a CSV text body (`LogID, Time, EventName, Type, Reason, AlarmCause` —
  one more column than the doc lists) containing only *defined-Event* activations (intercom /
  auto-operator events). It does **not** contain portal Unlock/Relock activity, and no other read
  command exposes portal state. Consequence: a scheduled unlock cannot be observed through the
  NBAPI; live verification reads back the configuration objects and the user observes the door on
  *Monitor → Portal Status* (R30).
- `ListEvents` on this controller returns events whose actions include "Unlock Door" — triggering
  one would physically unlock a door, so no event may be used as a live-test target.
- **Group membership on Modify (live write check, 2026-09-15):** `AddPortalGroup` with
  `<PORTALKEYS><PORTALKEY>56</PORTALKEY></PORTALKEYS>` and `AddReaderGroup` with
  `<READERKEYS><READERKEY>187</READERKEY></READERKEYS>` both create the group **with** the member
  (read back verified). But `ModifyReaderGroup` sent with only `DESCRIPTION` **cleared** the
  membership (read-back `[]`): on this firmware an omitted list means "no members", not "leave
  unchanged". And `ModifyPortalGroup` sent with the doc's repeated top-level `<PORTALKEY>` siblings
  (p. 165 example) also left membership empty — that shape is not parsed. Consequences: every
  Modify of a portal or reader group must send the **complete** membership, and `ModifyPortalGroup`
  uses the same wrapped `<PORTALKEYS><PORTALKEY>…` shape as `AddPortalGroup` (R13, R14, R25 step 6,
  R26). Other live confirmations from the same run: `AddTimeSpec` also creates a same-named singular
  time spec group; `AddTimeSpecGroup` returns `TIMESPECGROUPKEY`; `ModifyTimeSpecGroup` with an
  empty `TIMESPECKEYS` list empties the group.
- **Group names are unique across group types (live, 2026-09-15):** with a time spec group named
  `MCP Unlock Window` already created (R25 step 2), `AddPortalGroup` with the same `NAME` failed
  with `ERRMSG="Duplicate Portal Group"` — portal groups and time spec groups share one name table
  (the doc's error lists for both commands mention the same `S2Group` insert). The first `--go`
  run therefore stopped at step 6 with a managed holiday (group 8, dated that day), a managed time
  spec, and the managed time spec group left behind and no portal group; the `finally` cancel found
  no managed portal group and removed nothing, and the operator had to delete the leftovers by hand.
  Consequences: the managed time spec group is named `<prefix> time specs` (R25 step 2, R27), and
  cancel/rollback removes managed holidays and time specs whether or not the managed portal group
  exists (R25 failure handling, R26).
- **Designated live-test portal (chosen by the user, 2026-09-14):** `02OF01A` ("STAIRWELL TO
  OFFICE"), `PORTALKEY` `56`, reader `187` (`02OF01A READER`, OSDP), strike output `189`
  (`02OF01A EL`); it belongs to **no** portal group, so the managed test group creates no overlap.
  `NETBOX_LIVE_TEST_PORTALKEY=56` is already set in the local `.env`.

### Semantics the design relies on (with the evidence for each)
- Holiday date range: `STARTDATE` is inclusive at 00:00 and `ENDDATE` is **exclusive** — the doc's
  one-day Christmas example is `2016-12-25 00:00` → `2016-12-26 00:00` (printed p. 49) and the
  live 10-day GRAND OPENING is `09-11 00:00` → `09-21 00:00`.
- End of day is `ENDTIME` `23:59` (the built-in *Always* uses it). **Live, 2026-09-15:** `ENDTIME`
  is inclusive through the end of its minute — a window ending `08:27` relocked at `08:27:59`
  controller time — so a multi-day window has **no** relock gap at midnight (`23:59` covers through
  `23:59:59`, and the next segment starts at `00:00`). The earlier "up to 60 s gap" caveat is
  withdrawn; the user-facing consequence is that the door relocks up to 59 s after the stated
  `end` minute.
- A time spec with no weekdays and holiday group *G* ticked is active only on dates covered by a
  holiday in group *G* (live: GRAND OPENING, user-confirmed working).
- A holiday in group *G* suppresses, on its dates, time specs that do **not** tick *G* (S2 training
  guide: "the scheduled event will not take place unless specifically told to do so on a holiday").
  On this controller only *Always* (ticks 1–8) and GRAND OPENING (ticks 1) exist today, but any
  future access-level time spec that does not tick the reserved group would lose access on the
  window's dates → the side-effect check (R24) exists for this reason.
- Holiday groups are a shared resource of exactly 8 (`1..8`); holidays are capped at 30 per
  partition (ERRMSG "Cannot exceed count of 30 Holidays per partition").
- `UnlockPortal` puts a portal in *Extended Unlock* until `LockPortal`; there is no timed variant,
  no `ModifyPortal`, and the web UI's *Schedule Action* feature is UI-only. So controller-side
  scheduling via holiday + time spec + portal group is the only API-drivable mechanism.
- `ModifyTimeSpecGroup` **replaces** the member list (doc p. 172). `ModifyPortalGroup` documents
  `PORTALKEY` as required and its example sends the full list (p. 165); whether it replaces or adds
  is not stated, so the composite tools always send the **complete** desired membership, which
  yields the intended result under either semantics.

### Assumed (no way to check without a write; each names the evidence that would settle it)
- `AddTimeSpec` also creates a same-named singular time spec group (the doc's AddTimeSpec error
  list includes S2Group/TimeSpecToGroup insert errors; live TSG 28 mirrors spec 3). The design never
  depends on it: the managed time spec group is created and maintained explicitly (R25), and any
  auto-created singular group is tolerated. Settled by the first live `add_time_spec`.
- `TriggerEvent` works on the 6.x main path (inferred from `ListEvents`). Settled only by a user
  who configures a harmless test event; until then the README says "unverified live".
- ~~The MCP host and the controller share a timezone.~~ **Falsified live, 2026-09-15:** during the
  first door test the controller's newest access records read `03:30` while the host read `08:05`
  (about 4 h 35 min behind — a wrong controller clock, not a timezone), so a window scheduled for
  host-time `08:03–08:05` never arrived in controller time and the door stayed locked, while the
  configuration objects were exactly right. Window times are controller-local by definition; the
  host clock is used only for the "already elapsed" check in R22, and the write live check now
  measures the controller's clock and refuses to run the door phase on a skew above 2 minutes
  (R30). The user is correcting the controller's time (Configuration → Time / NTP).

### Decisions taken by the user on 2026-09-14
- Write surface: **all four areas** — unlock workflow (portal control, time specs, holidays, portal
  groups); people, credentials, access levels, reader groups; outputs, threat levels, events
  (`TriggerEvent`, `InsertActivity`); partitions and UDF lists.
- Unlock windows: **one managed window at a time**, realised with a fixed set of prefixed objects
  that are rewritten on each call; a new window replaces the previous one.
- Live verification may unlock **one portal the user designates** via `NETBOX_LIVE_TEST_PORTALKEY`.
- Gating (decided here as the careful default; editable in this file): `NETBOX_ENABLE_WRITES` gates
  every write tool; `NETBOX_ENABLE_DESTRUCTIVE` additionally gates deletes/removes/purges.

### Project conventions that apply at build time
- Global `CLAUDE.md`: no secrets in tracked files; issue-first workflow, `feat/<slug>` branch,
  signed commits, PR with `Fixes #N`, squash-merge, never auto-merge to `main`. Beads
  (`bd`) for task tracking; `bd dolt push` after bead changes.
- Windows 11 host, PowerShell/Git Bash, Node 24 (`engines` says >= 18.17). No WSL required.

## Deliverable
Changes inside `C:\Users\jmaffiola\Documents\Scripts\s2-netbox-mcp\`:
- `src/commands.ts` — `NBAPI_COMMANDS` extended to the 80-command closed set in R4.
- `src/xml.ts` — nested `PARAMS` support per R5.
- `src/config.ts` — new env vars per R7.
- `src/netboxClient.ts` — per-call request path so `TriggerEvent` can use the event path (R6).
- `src/index.ts` — conditional registration per R1/R2.
- `src/tools/` — new modules for portal control (incl. `set_portals_state`), time specs, holidays,
  portal groups, reader groups, threat levels, partitions/UDF, and the composite unlock-window
  tools; `person.ts`, `accessLevel.ts`, `events.ts` extended with their write tools. Module names
  are the generator's choice; behaviour and the literal-confinement rule are what the rubric checks.
- `src/unlockWindow/` (or equivalent) — a **pure** planner (`planUnlockWindow(start, end, groups,
  prefix)` → segments) separated from the executor that issues NBAPI calls, so R23 is unit-testable
  without a controller.
- `test/` — new/updated vitest files covering R33.
- `scripts/live-check.ts` — extended read coverage (R29); `scripts/live-check-write.ts` — opt-in
  write smoke test run by `npm run test:live:write` (R30).
- `README.md`, `.env.example`, `CHANGELOG.md` (0.3.0), `STATUS.md`, `package.json` (version 0.3.0,
  new script) per R31–R32.

## Requirements

### Gating and safety
- R1. With `NETBOX_ENABLE_WRITES` unset, empty, or any value other than `1`/`true`/`yes`
  (case-insensitive), the server registers exactly: the 16 read tools already on `main` (the 15
  pass-through tools plus `find_portals`), the 18 read tools of R8,
  and `get_unlock_window` — and **no** tool that can issue a write command. With it set truthy, all
  write tools of R9–R20 plus `set_portals_state`, `schedule_unlock_window`, and
  `cancel_unlock_window` are registered as well, except the destructive tools of R2.
  [verify: unit test registers against a fake server under each flag combination and compares the
  sorted tool-name list to the expected list]
- R2. The **destructive** tools — `delete_access_level`, `delete_access_level_group`,
  `delete_holiday`, `delete_portal_group`, `delete_reader_group`, `delete_time_spec`,
  `delete_time_spec_group`, `remove_credential`, `remove_person`, `remove_threat_level`,
  `remove_threat_level_group` — are registered only when **both** `NETBOX_ENABLE_WRITES` and
  `NETBOX_ENABLE_DESTRUCTIVE` are truthy. Independently of registration, `modify_person` returns
  `isError` naming `NETBOX_ENABLE_DESTRUCTIVE` (and sends nothing) when called with
  `DELETED` = `TRUE` or `PERSONPURGE` = `TRUE` while that flag is not truthy; `modify_udf_list_items`
  does the same for any list item with `DELETE` = `1`. The composite tools (R25, R26) may delete
  **only** holidays and time specs whose `NAME` carries the managed prefix (R27), and do so
  regardless of `NETBOX_ENABLE_DESTRUCTIVE` because those objects are server-owned.
  [verify: registration test as in R1; handler tests for the two guarded tools assert no
  `client.call` happened and the error names the flag]
- R3. Every write tool's description starts with `WRITE:` and every destructive tool's with
  `DESTRUCTIVE:`; every write tool's success result text contains the literal `SUCCESS` followed by
  the pretty-printed DETAILS JSON (which may be `{}`), so callers can tell a write succeeded even
  when the controller returns no DETAILS. [verify: iterate registrations in a test; call each write
  handler against a fake client returning `{ notFound:false, data:{} }` and assert the text]
- R4. `NBAPI_COMMANDS` contains exactly these 80 commands and nothing else: the 17 v0.2.0 commands
  (`Login`, `Logout`, `GetAPIVersion`, `GetPerson`, `SearchPersonData`, `GetCardAccessDetails`,
  `GetCardFormats`, `GetAccessLevel`, `GetAccessLevels`, `GetAccessLevelGroup`,
  `GetAccessLevelGroups`, `GetPortals`, `GetReader`, `GetReaders`, `GetEventHistory`, `ListEvents`,
  `GetAccessHistory`); reads `GetTimeSpec`, `GetTimeSpecs`, `GetTimeSpecGroup`,
  `GetTimeSpecGroups`, `GetHoliday`, `GetHolidays`, `GetPortalGroup`, `GetPortalGroups`,
  `GetReaderGroup`, `GetReaderGroups`, `GetOutputs`, `GetAccessLevelNames`, `GetPartitions`,
  `GetUDFLists`, `GetUDFListItems`, `GetElevators`, `GetFloors`, `PingApp`; actions
  `ActivateOutput`, `DeactivateOutput`, `DogOnNextExitPortal`, `LockPortal`,
  `MomentaryUnlockPortal`, `UnlockPortal`, `SetThreatLevel`; adds `AddAccessLevel`,
  `AddAccessLevelGroup`, `AddHoliday`, `AddPartition`, `AddPortalGroup`, `AddReaderGroup`,
  `AddTimeSpec`, `AddTimeSpecGroup`, `AddThreatLevel`, `AddThreatLevelGroup`; deletes
  `DeleteAccessLevel`, `DeleteAccessLevelGroup`, `DeleteHoliday`, `DeletePortalGroup`,
  `DeleteReaderGroup`, `DeleteTimeSpec`, `DeleteTimeSpecGroup`; modifies `ModifyAccessLevel`,
  `ModifyAccessLevelGroup`, `ModifyHoliday`, `ModifyPortalGroup`, `ModifyReaderGroup`,
  `ModifyThreatLevel`, `ModifyThreatLevelGroup`, `ModifyTimeSpec`, `ModifyTimeSpecGroup`,
  `ModifyUDFListItems`; removes `RemoveThreatLevel`, `RemoveThreatLevelGroup`; people
  `AddCredential`, `AddPerson`, `ModifyCredential`, `ModifyPerson`, `RemoveCredential`,
  `RemovePerson`; events `TriggerEvent`, `InsertActivity`; `SwitchPartition`. Command-name string
  literals remain confined to `src/commands.ts`; `test/commandAllowlist.test.ts` is rewritten so
  its forbidden list is `GetPicture`, `StreamEvents`, `GetPortal`, and the seven deprecated
  commands (`EditPerson`, `EditThreatLevel`, `EditThreatLevelGroup`, `GetAccessDataLog`,
  `GetAccessCardDetails`, `LoginUserName`, `LoginUserPassword`), and every `client.call(` site
  still passes a `NBAPI_COMMANDS.*` constant. [verify: run the allowlist test; grep `src/` and
  `scripts/` for the literals]

### XML and client
- R5. `NbapiParams` values may be a scalar, an object, or an array, nested to any depth, and
  `buildParamsXml` serialises them as: scalar → `<KEY>escaped</KEY>`; object → `<KEY>…children…</KEY>`;
  array → one sibling element per item, each serialised by the same rules under the array's key;
  `undefined` values (and `undefined` array items) are dropped; keys are upper-cased; text is
  XML-escaped as today. Required outputs (whitespace-free, order preserved):
  - `{ PORTALKEYS: { PORTALKEY: ['30','32'] } }` → `<PORTALKEYS><PORTALKEY>30</PORTALKEY><PORTALKEY>32</PORTALKEY></PORTALKEYS>`
  - `{ PORTALGROUPKEY: '56', PORTALKEY: ['1','2'] }` → `<PORTALGROUPKEY>56</PORTALGROUPKEY><PORTALKEY>1</PORTALKEY><PORTALKEY>2</PORTALKEY>`
  - `{ ACCESSLEVELS: { ACCESSLEVEL: ['A', 'B'] } }` → `<ACCESSLEVELS><ACCESSLEVEL>A</ACCESSLEVEL><ACCESSLEVEL>B</ACCESSLEVEL></ACCESSLEVELS>`
  - `{ ACCESSLEVELS: { ACCESSLEVEL: [{ ACCESSLEVELNAME: 'A', DELETE: '1' }] } }` → `<ACCESSLEVELS><ACCESSLEVEL><ACCESSLEVELNAME>A</ACCESSLEVELNAME><DELETE>1</DELETE></ACCESSLEVEL></ACCESSLEVELS>`
  - `{ VEHICLES: { VEHICLE: [{ VEHICLEMAKE: 'Honda', VEHICLELICNUM: '123 PGA' }] } }` → `<VEHICLES><VEHICLE><VEHICLEMAKE>Honda</VEHICLEMAKE><VEHICLELICNUM>123 PGA</VEHICLELICNUM></VEHICLE></VEHICLES>`
  - `{ LISTITEMS: { LISTITEM: [{ ITEMKEY: '1', DELETE: '1' }, { DELETE: '0', ITEMNAME: 'X', CUSTOMKEY: '_3' }] } }` → the two `<LISTITEM>` blocks in that order inside `<LISTITEMS>`
  [verify: unit tests assert these exact strings, plus one with `&`/`<` in a nested value]
- R6. `NetboxClient.call` accepts an optional per-call request path; every command posts to
  `${NETBOX_BASE_URL}${NETBOX_API_PATH}` except `TriggerEvent`, which posts to
  `${NETBOX_BASE_URL}${NETBOX_EVENT_API_PATH}`. `NETBOX_EVENT_API_PATH` unset/empty resolves to the
  resolved `NETBOX_API_PATH`; a non-empty override is used verbatim with a missing leading `/`
  added; `/appd/nbapi` is documented as the pre-6.x value. Session handling (login, retry once on
  APIERROR 5) is unchanged for the event path. [verify: unit test captures the URL of a
  `TriggerEvent` call with and without the override, and of one other command]
- R7. `loadConfigFromEnv` additionally reads: `NETBOX_ENABLE_WRITES` (bool), `NETBOX_ENABLE_DESTRUCTIVE`
  (bool), `NETBOX_EVENT_API_PATH` (R6), `NETBOX_UNLOCK_HOLIDAY_GROUPS` (default `8,7,6`; must be
  1–3 distinct integers in 1..8 separated by commas, otherwise a one-line `NetboxConfigError` that
  names the variable and the rule), `NETBOX_UNLOCK_NAME_PREFIX` (default `MCP Unlock Window`; 1–40
  characters so `<prefix> middle` fits the 64-character NAME limit), `NETBOX_LIVE_TEST_PORTALKEY`
  (optional string, read only by `scripts/live-check-write.ts`). Booleans use the existing
  explicit-opt-in regex. [verify: config unit tests for defaults, valid overrides, and each
  rejected value]

### Read tools (always registered)
- R8. Eighteen new pass-through read tools, each wrapping the named command with exactly the
  documented PARAMS (see Command reference): `get_time_spec` (`TIMESPECKEY` req),
  `get_time_specs` (`STARTFROMKEY` opt), `get_time_spec_group` (`TIMESPECGROUPKEY` req),
  `get_time_spec_groups` (`STARTFROMKEY` opt), `get_holiday` (`HOLIDAYKEY` req), `get_holidays`
  (`STARTFROMKEY` opt), `get_portal_group` (`PORTALGROUPKEY` req), `get_portal_groups`
  (`STARTFROMKEY` opt), `get_reader_group` (`READERGROUPKEY` req), `get_reader_groups`
  (`STARTFROMKEY` opt), `get_outputs` (`STARTFROMKEY` opt), `get_access_level_names`
  (`PARTITIONKEY` opt, `STARTFROMNAME` opt), `get_partitions` (none), `get_udf_lists` (none),
  `get_udf_list_items` (`UDFLISTKEY` req), `get_elevators` (`STARTFROMKEY` opt), `get_floors`
  (`STARTFROMKEY` opt), `ping_app` (none). [verify: schema-key tests as in `test/tools.test.ts`;
  live: `npm run test:live` reports PASS for each — R29]

### Write tools (pass-through; one tool per command, documented PARAMS only)
- R9. Portal/output actions: `lock_portal`, `unlock_portal`, `momentary_unlock_portal`,
  `dog_on_next_exit_portal` (each `PORTALKEY` req); `activate_output`, `deactivate_output` (each
  `OUTPUTKEY` req). [verify: schema + call-argument tests]
- R10. `set_portals_state` (composite, write): params `action` ∈ {`LOCK`, `UNLOCK`,
  `MOMENTARY_UNLOCK`} (req), `portalKeys` (optional string[]; omitted → every portal from a fully
  paginated `GetPortals`). Issues the corresponding command per portal **sequentially**, never
  aborting on a single failure, and returns JSON `{ action, requested, succeeded: [{PORTALKEY,
  NAME}], alreadyInState: [...], failed: [{PORTALKEY, NAME, error}] }`. A `FAIL` whose `ERRMSG`
  contains `Portal state not changed` counts as `alreadyInState`; any other FAIL/APIERROR counts as
  `failed`. The result is `isError` iff `failed` is non-empty. [verify: fake-client test with one
  success, one "Portal state not changed", one other FAIL]
- R11. Time specs: `add_time_spec` (`NAME` req; `DESCRIPTION`, `STARTTIME`, `ENDTIME` `HH:MM`,
  `MONDAY`…`SUNDAY` each `'0'|'1'`, `HOLIDAYGROUPS` comma string — all opt), `modify_time_spec`
  (`TIMESPECKEY` req + the same optionals), `add_time_spec_group` (`NAME` req, `DESCRIPTION` opt),
  `modify_time_spec_group` (`TIMESPECGROUPKEY` req; `NAME`, `DESCRIPTION` opt; `TIMESPECKEYS`
  string[] opt → wire `<TIMESPECKEYS><TIMESPECKEY>…`), `delete_time_spec` (`TIMESPECKEY`),
  `delete_time_spec_group` (`TIMESPECGROUPKEY`). [verify: schema + wire-shape tests]
- R12. Holidays: `add_holiday` (`HOLIDAYNAME`, `STARTDATE`, `ENDDATE` req; `HOLIDAYGROUPS` opt),
  `modify_holiday` (`HOLIDAYKEY` req; `HOLIDAYNAME`, `HOLIDAYGROUPS`, `STARTDATE`, `ENDDATE` opt),
  `delete_holiday` (`HOLIDAYKEY`). Descriptions state that `ENDDATE` is exclusive and that dates
  are controller-local. [verify: schema tests; description text contains "exclusive"]
- R13. Portal groups: `add_portal_group` (`NAME` req; `DESCRIPTION`, `UNLOCKTIMESPECGROUPKEY`,
  `THREATLEVELGROUPKEY` opt; `PORTALKEYS` string[] req → wire `<PORTALKEYS><PORTALKEY>…`),
  `modify_portal_group` (`PORTALGROUPKEY` req; `PORTALKEYS` string[] req → wire
  `<PORTALKEYS><PORTALKEY>…</PORTALKEY>…</PORTALKEYS>`, the same wrapped shape as `add_portal_group`
  — the doc's repeated top-level `<PORTALKEY>` example is **not parsed** by this controller and
  leaves the group empty (live, 2026-09-15); `NAME`, `DESCRIPTION`, `UNLOCKTIMESPECGROUPKEY`,
  `THREATLEVELGROUPKEY` opt; the description states that `PORTALKEYS` is the complete membership
  because an omitted or unparsed list empties the group), `delete_portal_group` (`PORTALGROUPKEY`).
  [verify: schema + wire-shape tests, including the wrapped shape on modify]
- R14. Reader groups: `add_reader_group` (`NAME` req; `DESCRIPTION` opt; `READERKEYS` string[] req →
  `<READERKEYS><READERKEY>…`), `modify_reader_group` (`READERGROUPKEY` and `READERKEYS` string[]
  **req** — omitting the list clears the group's membership on this controller (live, 2026-09-15),
  so the tool requires the complete membership and its description says so; `NAME`, `DESCRIPTION`
  opt), `delete_reader_group` (`READERGROUPKEY`). [verify: as above]
- R15. Access levels: `add_access_level` (`ACCESSLEVELNAME`, `TIMESPECGROUPKEY` req;
  `ACCESSLEVELDESCRIPTION`, `READERKEY`, `READERGROUPKEY`, `THREATLEVELGROUPKEY` opt; client-side
  error if both `READERKEY` and `READERGROUPKEY` are given), `modify_access_level` (`ACCESSLEVELKEY`
  req; all others opt — the doc marks `TIMESPECGROUPKEY` required but its own example omits it),
  `delete_access_level` (`ACCESSLEVELKEY`); `add_access_level_group` (`NAME` req; `DESCRIPTION`,
  `PARTITIONKEY`, `SYSTEMGROUP` opt; `ACCESSLEVELS` opt array of `{ NAME?, KEY?, PARTITIONKEY? }` →
  `<ACCESSLEVELS><ACCESSLEVEL>…`), `modify_access_level_group` (`ACCESSLEVELGROUPKEY` req; `NAME`,
  `DESCRIPTION`, `ACCESSLEVELS` opt), `delete_access_level_group` (`ACCESSLEVELGROUPKEY`).
  [verify: schema + wire-shape tests]
- R16. Persons: `add_person` (`LASTNAME` req; `PERSONID`, `FIRSTNAME`, `MIDDLENAME`, `NOTES`,
  `EXPDATE`, `ACTDATE`, `UDF1`…`UDF20`, `PIN`, `BADGELAYOUT`, `CONTACTPHONE`, `CONTACTEMAIL`,
  `CONTACTSMSEMAIL`, `CONTACTLOCATION`, `OTHERCONTACTNAME`, `OTHERCONTACTPHONE1`,
  `OTHERCONTACTPHONE2` opt; `ACCESSLEVELS` opt array whose items are either a string (name syntax)
  or `{ ACCESSLEVELNAME, DELETE?, ACTDATE?, EXPDATE?, AUTOREMOVE? }` (alternative syntax) — mixing
  the two in one call is a client-side error; `VEHICLES` opt array of `{ VEHICLECOLOR?,
  VEHICLEMAKE?, VEHICLEMODEL?, VEHICLESTATE?, VEHICLELICNUM?, VEHICLETAGNUM? }`), `modify_person`
  (`PERSONID` req; everything in `add_person` opt except `LASTNAME` also opt; plus `PERSONPURGE`,
  `DELETED`, `ALLPARTITIONS` opt; `VEHICLE` items may also carry `DELETE`), `remove_person`
  (`PERSONID`). `PICTURE`, `PICTUREEXT`, `PICTUREURL`, and the S2-Global-only `PARTITIONKEY` are
  deliberately **not** exposed. The `add_person`/`modify_person` descriptions carry the AD-sync
  caution and the ModifyPerson name-syntax "replaces all access levels" warning. [verify: schema
  tests; description text contains "Active Directory" and "replaces"]
- R17. Credentials: `add_credential` (`PERSONID`, `CARDFORMAT` req; `ENCODEDNUM`, `HOTSTAMP`,
  `WANTCREDENTIALID`, `CARDSTATUS`, `CARDEXPDATE` opt; client-side error unless at least one of
  `ENCODEDNUM`/`HOTSTAMP` is given), `modify_credential` (`PERSONID` req; `CARDFORMAT`, `ENCODEDNUM`, `HOTSTAMP`,
  `CREDENTIALID`, `DISABLED` `'0'|'1'`, `CARDSTATUS`, `CARDEXPDATE` opt; client-side error if both
  `DISABLED` and `CARDSTATUS` are given), `remove_credential` (`PERSONID` req; `CARDFORMAT`,
  `ENCODEDNUM`, `HOTSTAMP`, `CREDENTIALID` opt; client-side error unless `CREDENTIALID` or at least
  one of `ENCODEDNUM`/`HOTSTAMP` is given). [verify: schema + guard tests]
- R18. Threat levels: `set_threat_level` (`LEVELNAME` req), `add_threat_level` (`LEVELNAME` req;
  `SEQNUM`, `COLOR` ∈ {White, Green, Blue, Yellow, Orange, Red} opt), `modify_threat_level` (same
  shape), `remove_threat_level` (`LEVELNAME`), `add_threat_level_group` (`LEVELGROUPNAME` req;
  `LEVELNAMES` string[] opt → `<LEVELNAMES><LEVELNAME>…`), `modify_threat_level_group`
  (`LEVELGROUPNAME`, `LEVELNAMES` string[] req), `remove_threat_level_group` (`LEVELGROUPNAME`).
  [verify: schema + wire-shape tests]
- R19. Events/activity: `trigger_event` (`EVENTNAME` req; `EVENTACTION` ∈ {`ACTIVATE`,
  `DEACTIVATE`} req; `PARTITIONID` opt; routed per R6), `insert_activity` (`ACTIVITYTYPE` ∈
  {`ACCESSGRANTED`, `ACCESSDENIED`, `USERACTIVITY`} req; `DETAILS` ∈ {`DISABLED`, `EXPIRED`,
  `LOCATION`, `PIN`, `TIME`, `UNKNOWN`}, `PORTALKEY`, `ELEVATORKEY`, `FLOORKEY`, `READERKEY`,
  `PERSONID`, `CARDFORMAT`, `ENCODEDNUM`, `ACTIVITYTEXT` opt; client-side error if both `PORTALKEY`
  and `ELEVATORKEY` are given). [verify: schema + routing + guard tests]
- R20. Partitions and UDF lists: `add_partition` (`NAME`, `TIMEZONE` req; `DESCRIPTION` opt),
  `switch_partition` (`PARTITIONKEY` req; description states it changes the partition for **every
  later call in this server process** because the session is cached), `modify_udf_list_items`
  (`UDFLISTKEY` req; `LISTITEMS` array (1–10 items, client-side bound) of `{ ITEMKEY?, ITEMNAME?,
  DELETE '0'|'1' req, CUSTOMKEY? }` → `<LISTITEMS><LISTITEM>…`). [verify: schema + wire + bound
  tests]
- R21. Every tool schema above declares exactly the field names listed here (which are copied from
  the Command reference), marks required/optional as listed, uses `z.enum` where a closed value set
  is documented, and models list-typed parameters as arrays whose wire shape is given in the
  Command reference. No invented, renamed, or passthrough fields. [verify: cross-check each
  registration against the Command reference]

### Composite: managed unlock window
- R22. `schedule_unlock_window` (write) takes `start`, `end` (strings `YYYY-MM-DD HH:MM`,
  controller-local, validated as real calendar date-times), `portalKeys` (optional string[];
  omitted → every portal from a fully paginated `GetPortals`), `acknowledgeSideEffects` (optional
  boolean, default false), `dryRun` (optional boolean, default false). It returns `isError` with a
  one-sentence reason and issues **no write** when: the format is wrong; `end` ≤ `start`; `end` is
  not later than the host's current time; the window is longer than 31 days; `portalKeys` contains
  a key not returned by `GetPortals`; adding the planned holidays would exceed 30 (count taken
  from `GetHolidays`); or the plan needs a segment kind for which no holiday group is configured
  (R23). [verify: handler tests for each rejection assert zero write commands]
- R23. Planning is a pure function of (`start`, `end`, reserved groups `[g1,g2,g3]`, prefix) with
  these rules, where an `end` time of `00:00` is first normalised to `23:59` of the previous date:
  same date → one segment `first` = [`start` time, `end` time] on that date; otherwise `first` =
  [`start` time, `23:59`] on the start date, `last` = [`00:00`, `end` time] on the end date, and
  `middle` = [`00:00`, `23:59`] on the dates strictly between (present only if at least one such
  date exists). Each segment has: holiday `HOLIDAYNAME` = `<prefix> <kind>`, `STARTDATE` = first
  date of the segment at `00:00`, `ENDDATE` = the day **after** the last date of the segment at
  `00:00` (exclusive); time spec `NAME` = `<prefix> <kind>`, `STARTTIME`/`ENDTIME` as above, all
  seven weekday flags `0`, `HOLIDAYGROUPS` = `g1` for `first`, `g2` for `middle`, `g3` for `last`.
  When `NETBOX_UNLOCK_HOLIDAY_GROUPS` configures fewer than three groups, a plan that needs a
  segment kind with no configured group is rejected (`isError`, no write) rather than sharing a
  group between segments — one group permits same-day windows only, two permit windows without a
  `middle` segment — because two segments sharing a group would each unlock on the other's dates.
  Required outputs (groups `8,7,6`, prefix `P`):
  - `2026-10-03 09:00` → `2026-10-03 17:00`: one segment first, holiday `2026-10-03 00:00`→`2026-10-04 00:00`, spec `09:00`–`17:00`, group 8.
  - `2026-10-03 18:00` → `2026-10-04 00:00`: identical to a same-day window ending `23:59` (one segment, spec `18:00`–`23:59`).
  - `2026-10-03 18:00` → `2026-10-04 09:00`: first (`18:00`–`23:59`, holiday 10-03→10-04, g8) and last (`00:00`–`09:00`, holiday 10-04→10-05, g6); no middle.
  - `2026-10-02 17:00` → `2026-10-06 08:30`: first (10-02, `17:00`–`23:59`, g8), middle (holiday 10-03→10-06, spec `00:00`–`23:59`, g7), last (10-06, `00:00`–`08:30`, g6).
  [verify: unit tests assert these four plans exactly]
- R24. Before writing, the tool fetches every time spec (paginating `GetTimeSpecs`) and every
  holiday (`GetHolidays` + `GetHoliday` per key) and computes a side-effect report:
  `suppressedTimeSpecs` = time specs whose `NAME` is not `Never`, does not carry the managed prefix,
  and whose `HOLIDAYGROUPS` (comma-split) lacks at least one group the plan uses;
  `overlappingHolidays` = non-managed holidays whose `[STARTDATE, ENDDATE)` intersects
  `[first segment STARTDATE, last segment ENDDATE)`. If `suppressedTimeSpecs` is non-empty and
  `acknowledgeSideEffects` is not `true`, the tool returns `isError` listing them (key, name,
  groups) and writes nothing. If `dryRun` is `true`, the tool returns the plan and the report and
  writes nothing, regardless of acknowledgement. [verify: fake-client tests with a spec lacking a
  group (blocked, then allowed with the flag) and with `dryRun`]
- R25. Apply order (each step's NBAPI calls in this sequence; a failure at any step stops the
  apply, runs the R26 cleanup of managed holidays and time specs — so no partial window can remain
  active — and returns `isError` naming the failed step, the controller's message, and what the
  cleanup removed):
  1. Resolve targets: paginate `GetPortals`; validate `portalKeys`.
  2. Managed time spec group: find by exact `NAME` = `<prefix> time specs` in paginated
     `GetTimeSpecGroups`; if absent `AddTimeSpecGroup(NAME="<prefix> time specs",
     DESCRIPTION="Managed by s2-netbox-mcp; do not edit")`. (It must not share the portal group's
     name — group names are unique across group types on this controller, see Context.)
  3. Managed holidays and time specs: for each planned segment, if a holiday / time spec with that
     exact `NAME` exists, `ModifyHoliday` / `ModifyTimeSpec` it to the planned values, else
     `AddHoliday` / `AddTimeSpec`.
  4. `ModifyTimeSpecGroup(TIMESPECGROUPKEY=managed, TIMESPECKEYS=<planned segment keys>)`.
  5. For each **unplanned** managed segment name (`<prefix> first|middle|last` left over from a
     previous window): `DeleteTimeSpec` then `DeleteHoliday` (after step 4 so the spec is no longer
     referenced by the managed group).
  6. Managed portal group: find by exact `NAME` = prefix in paginated `GetPortalGroups`; if absent
     `AddPortalGroup(NAME=prefix, DESCRIPTION as above, UNLOCKTIMESPECGROUPKEY=managed TSG,
     PORTALKEYS=targets)`; else `ModifyPortalGroup(PORTALGROUPKEY, PORTALKEYS=targets,
     UNLOCKTIMESPECGROUPKEY=managed TSG)` — both with the wrapped `<PORTALKEYS><PORTALKEY>…`
     shape (see the Context finding on membership).
  7. Read back (`GetPortalGroup`; the managed group's entry in paginated `GetTimeSpecGroups`
     filtered by `TIMESPECGROUPKEY` — not `GetTimeSpecGroup`, which fails on this controller;
     `GetTimeSpec` and `GetHoliday` per segment) and compare to the plan, normalising
     `TRUE`/`FALSE` ↔ `1`/`0` and `HH:MM:SS` ↔ `HH:MM`; any mismatch → `isError` describing the
     field.
  8. Return JSON `{ window:{start,end}, segments:[{kind, holidayKey, timeSpecKey, holidayGroup,
     STARTDATE, ENDDATE, STARTTIME, ENDTIME}], timeSpecGroupKey, portalGroupKey, portals:[{PORTALKEY,
     NAME}], replacedPreviousWindow:boolean, sideEffects:{suppressedTimeSpecs, overlappingHolidays},
     verified:true }`.
  [verify: fake-client test that records the full command sequence for a first run (adds) and a
  second run with a shorter window (modifies + delete of the leftover segment) and asserts the
  exact order]
- R26. `cancel_unlock_window` (write): resolves the *Never* time spec group by exact `NAME`
  `Never` (fails clearly if absent); **if** the managed portal group exists, sets its
  `UNLOCKTIMESPECGROUPKEY` to *Never* via `ModifyPortalGroup` (re-sending its current `PORTALKEYS`
  from `GetPortalGroup`); then — whether or not that portal group exists — deletes every managed
  holiday (`<prefix> first|middle|last`), then attempts `ModifyTimeSpecGroup(managed TSG,
  TIMESPECKEYS=[])` followed by `DeleteTimeSpec` for each managed time spec — if the controller
  refuses to empty the group or delete a spec, the tool still returns success (the portal group,
  if any, points at *Never* and no managed holiday exists, so nothing can unlock) and lists what
  was left behind under `leftBehind`. Only when no managed object of any kind (portal group,
  holiday, time spec) exists does it return a normal result saying there was nothing to cancel. `get_unlock_window` (read,
  always registered) returns the managed portal group (key, portals, unlock TSG key and whether it
  is the managed TSG), the managed time spec group's members (from paginated `GetTimeSpecGroups`,
  see the controller quirk in Context), the managed time specs and holidays, the derived window (earliest holiday
  `STARTDATE` + `first` spec `STARTTIME` … latest holiday `ENDDATE`-1 day + `last`/`first` spec
  `ENDTIME`), and `activeNow` computed against the host clock. [verify: fake-client tests for
  cancel order, the tolerated-refusal path, the nothing-to-cancel path, and `get_unlock_window`
  on a populated and an empty controller]
- R27. The composite tools never `Modify`/`Delete` a holiday, time spec, time spec group, or portal
  group whose `NAME` is not exactly the prefix, `<prefix> time specs`, or
  `<prefix> first|middle|last`; a user-created
  object with one of those names is treated as managed (names are the identity). [verify: code
  review of the executor; test that a non-prefixed holiday overlapping the window is reported, not
  touched]
- R28. `schedule_unlock_window` is idempotent: calling it twice with identical arguments issues
  only Modify/Get calls on the second run (no Add, no Delete) and returns the same keys. [verify:
  fake-client test]

### Live verification
- R29. `scripts/live-check.ts` additionally exercises every R8 read tool (chaining a real
  `TIMESPECKEY`, `TIMESPECGROUPKEY`, `HOLIDAYKEY` (parsed from the comma string), `PORTALGROUPKEY`,
  `READERGROUPKEY`, `UDFLISTKEY` from the list responses; treating `NOT FOUND` and a bare
  `ERRMSG="NOT FOUND"`/`"No configured UDF LISTS"` on an empty collection as PASS, and treating
  `GetTimeSpecGroup`'s `ERRMSG="NOT FOUND"` for a key that `GetTimeSpecGroups` just listed as the
  accepted controller quirk documented in Context) and still issues **no** write command. [verify: run with the real `.env`, expect PASS for all 34 read tools (16
  existing + 18 new) and
  exit 0; grep the script for write command constants]
- R30. `npm run test:live:write` runs `scripts/live-check-write.ts`, which: (a) prints one
  "skipped" line and exits 0 without any network call unless the three credential vars,
  `NETBOX_ENABLE_WRITES=true`, and `NETBOX_LIVE_TEST_PORTALKEY` are all set; (b) otherwise, under
  a distinct prefix `MCP livecheck`, round-trips add → get → modify → get → delete for a time spec,
  a time spec group, a holiday, a reader group, and a portal group, asserting each read-back;
  (b2) estimates the controller's current time as the `DTTM` of the newest `GetAccessHistory`
  record (`MAXRECORDS` `1`), prints both clocks, and if it differs from the host clock by more than
  2 minutes prints `[FAIL] controller clock skew: controller <HH:MM:SS> vs host <HH:MM:SS>` and
  does not run phase (c) (exit non-zero). There is no "stale record" exemption — a large delta is
  indistinguishable from a wrong clock, so any delta above 2 minutes fails closed; the failure
  message tells the operator to badge any reader and re-run if the site has simply been quiet. Only
  a controller with **no** access records at all prints a warning and continues;
  (c) then — only after the operator running the check has notified the user (push notification
  plus a chat message giving the exact unlock and relock clock times) and received a go-ahead,
  because the user observes the door in person — prints `HEADS-UP: scheduling a 2-minute unlock
  of portal <NAME> (key <K>): unlock <HH:MM>, relock <HH:MM>` and calls the real
  `schedule_unlock_window` executor with `portalKeys=[test portal]`,
  `start` = now + 2 min, `end` = now + 4 min (host clock, `YYYY-MM-DD HH:MM`),
  `acknowledgeSideEffects=true`, asserts `verified:true`, prints `OBSERVE: portal <NAME> should
  unlock at <HH:MM> and relock at <HH:MM> — confirm on Monitor → Portal Status`, polls
  `get_unlock_window` every 30 s printing `activeNow` until `end` + 1 min, then calls
  `cancel_unlock_window` and asserts the portal group's `UNLOCKTIMESPECGROUPKEY` is *Never*'s key
  and no managed holiday remains; (d) never touches persons, credentials, access levels, threat
  levels, outputs, events, partitions, or UDF lists (those have unit tests only); (e) never prints
  the password; (f) exits non-zero on any assertion failure and, on failure after step (c) began,
  still attempts `cancel_unlock_window` before exiting. `npm test` never runs this script.
  [verify: run once with the vars unset (one line, exit 0) and once for real; the user records in
  the completion note whether the portal was observed unlocked during the window and locked
  after it]

### Documentation and packaging
- R31. `README.md`: the "read-only"/"structurally incapable" claims are replaced by a "Write
  access" section describing the two gates and the destructive tier; the environment-variable
  table gains the R7 variables; the tools table is split into read tools and write tools (each
  row: tool, command, required params); the sentence calling `find_portals` "the one composite
  tool" is replaced by a list of all composite tools (`find_portals`, `set_portals_state`,
  `schedule_unlock_window`, `cancel_unlock_window`, `get_unlock_window`); a section titled exactly
  "Scheduled unlock windows"
  explains the holiday + time spec + portal group mechanism, the reserved holiday groups, the
  side-effect check and `acknowledgeSideEffects`, the single-managed-window model and how to
  cancel, the 31-day cap, the ≤ 60 s midnight relock, the timezone assumption, and that the
  physical unlock is not observable through the NBAPI; "Controller prerequisites" states that
  writes need a role with **Read-Write** API privilege; the AD-sync caution moves next to the
  person tools; `trigger_event` is marked "unverified live on 6.x; `NETBOX_EVENT_API_PATH`
  override available". [verify: read the README for each item]
- R32. `.env.example` documents every new variable with placeholder values; `CHANGELOG.md` gains a
  `[0.3.0]` entry (Added/Changed) referencing the GitHub issue and absorbing the `find_portals`
  bullet currently under `[Unreleased]` (which is left empty); `STATUS.md` reflects the new state;
  `package.json` `version` is `0.3.0` and has the `test:live:write` script. [verify: read each file]
- R33. `npm test` (all unit tests, no network), `npm run typecheck`, and `npm run build` all
  succeed; the unit suite covers R1–R7, R10, R22–R28 as itemised in their verify clauses and has a
  schema-key test for every R8–R20 tool. [verify: run the three commands; list test names]

## Out of scope
- `GetPicture` and photo upload (`PICTURE`/`PICTUREEXT`/`PICTUREURL` parameters) — still deferred.
- `StreamEvents` / `/appdevent/nbapi/event` — persistent connection, still deferred.
- MAC authentication; S2 Global API variant; the deprecated commands.
- Multiple concurrent managed windows, per-window naming, or any persistence on the MCP host.
- Resolving portals by **name** in the composite tools (keys only; `get_portals` maps names).
- Automatically deleting the managed portal group or time spec group on cancel (they stay,
  pointing at *Never* / empty, and are reused).
- Any scheduler on the host (Windows Task Scheduler, in-process timers) — the controller is the
  only scheduler.
- Confirmation prompts inside the server (the MCP host's permission model and the env gates are
  the controls).
- Creating the GitHub issue, branch, or PR — done by the build step under git-policies.

## Constraints
- TypeScript/Node, `@modelcontextprotocol/sdk` stdio, zod, fast-xml-parser, undici — no new
  runtime dependencies.
- No secrets in tracked files; `.env` stays gitignored; live scripts never print
  `NETBOX_PASSWORD`; no test fixture or README example contains the real host, user, or password.
- XML element names uppercase, attributes lowercase (unchanged); every NBAPI field stays a string.
- Default behaviour with no new env vars set is byte-for-byte the v0.2.0 tool surface plus the
  R8 read tools and `get_unlock_window` (read-only remains the default posture).
- Composite tools issue only commands present in `NBAPI_COMMANDS`; no command-name literal outside
  `src/commands.ts`.
- "Fully paginated" means following `NEXTKEY` with the stop rules of `src/portalSearch.ts` (`-1`,
  missing or repeated key, 100-page cap); reuse or generalise that helper rather than writing a
  second loop.
- Managed object names: `<prefix>` for the portal group; `<prefix> time specs` for the time spec
  group (never the same name as the portal group — group names are unique across group types);
  `<prefix> first`, `<prefix> middle`, `<prefix> last` for holidays and time specs; all ≤ 64
  characters (so the prefix is capped at 40).
- Live write checks run only via `npm run test:live:write`, never from `npm test`.

## Acceptance rubric
- C1 (R1): PASS iff registration tests show the exact expected tool sets for writes-off and
  writes-on, and no write-capable tool exists with writes off.
- C2 (R2): PASS iff the 11 destructive tools appear only with both flags truthy, and
  `modify_person` with `DELETED=TRUE`/`PERSONPURGE=TRUE` and `modify_udf_list_items` with a
  `DELETE=1` item each return `isError` naming `NETBOX_ENABLE_DESTRUCTIVE` and issue no command
  when that flag is off.
- C3 (R3): PASS iff every write tool description starts with `WRITE:`/`DESTRUCTIVE:` and every
  write success text contains `SUCCESS`.
- C4 (R4): PASS iff `NBAPI_COMMANDS` equals the 80-command set, the rewritten allowlist test
  passes, and a grep of `src/` and `scripts/` finds no command literal outside `src/commands.ts`
  and none of the forbidden/deprecated names anywhere.
- C5 (R5): PASS iff the six listed serialisations are produced byte-for-byte and nested values are
  escaped.
- C6 (R6): PASS iff a captured `TriggerEvent` request URL uses the event path (default = API path;
  override honoured with `/` added) while another command's URL is unchanged.
- C7 (R7): PASS iff config tests show the defaults, accepted overrides, and one-line rejections
  for bad `NETBOX_UNLOCK_HOLIDAY_GROUPS` and over-long `NETBOX_UNLOCK_NAME_PREFIX`.
- C8 (R8): PASS iff each of the 18 read tools has exactly the listed schema keys and calls its
  command with them, and `npm run test:live` reports PASS for each against the live controller.
- C9 (R9–R20): PASS iff every listed write tool exists with exactly the listed schema keys and
  required/optional status, list parameters serialise to the stated wire shapes, and each
  client-side guard (both reader keys; ENCODEDNUM/HOTSTAMP; DISABLED vs CARDSTATUS; portal vs
  elevator; mixed ACCESSLEVELS syntaxes; 1–10 list items) returns `isError` without a command.
- C10 (R10): PASS iff the three-outcome `set_portals_state` test yields the stated JSON shape with
  `isError` only when `failed` is non-empty, and the all-portals path paginates `GetPortals`.
- C11 (R21): PASS iff no tool schema contains a field name absent from the Command reference for
  its command.
- C12 (R22): PASS iff each of the seven rejection cases returns `isError` with zero write commands.
- C13 (R23): PASS iff the four required plans are produced exactly.
- C14 (R24): PASS iff a time spec lacking a used group blocks the call without writes, the flag
  unblocks it, `dryRun` never writes, and overlapping holidays are reported.
- C15 (R25): PASS iff the recorded command sequences for a first run and a shrinking second run
  match the eight-step order, and a read-back mismatch produces `isError`.
- C16 (R26): PASS iff cancel issues the stated sequence, tolerates refusal of the last two steps
  while still reporting the *Never* assignment and holiday deletion, and `get_unlock_window`
  reports the derived window and `activeNow` correctly for a populated and an empty fixture.
- C17 (R27): PASS iff no code path modifies or deletes a non-prefixed object and the overlapping
  non-managed holiday in the R24 test is untouched.
- C18 (R28): PASS iff the second identical run issues no Add/Delete commands.
- C19 (R29): PASS iff the extended `npm run test:live` prints PASS for all 34 read tools and exit
  0 against the live controller, and the script contains no write command constant.
- C20 (R30): PASS iff `npm run test:live:write` skips cleanly without the vars, and with them
  completes the CRUD round-trips and the 2-minute window on `NETBOX_LIVE_TEST_PORTALKEY` with
  `verified:true`, ends with the portal group on *Never* and no managed holiday, exits 0, never
  prints the password — and the user, notified before the window was scheduled, has recorded
  that the portal was observed (in person or on Portal Status) unlocked during the window and
  locked afterwards.
- C21 (R31): PASS iff `README.md` contains every item listed in R31, including the exact heading
  "Scheduled unlock windows".
- C22 (R32): PASS iff `.env.example`, `CHANGELOG.md` (`[0.3.0]`), `STATUS.md`, and `package.json`
  (`0.3.0`, `test:live:write`) are updated as stated.
- C23 (R33): PASS iff `npm test`, `npm run typecheck`, and `npm run build` all exit 0 and the
  listed coverage exists.
- C-final: PASS iff a security-conscious reviewer familiar with the NBAPI documentation and with
  this controller's GRAND OPENING configuration would accept the write tools and the managed
  unlock window as safe, correctly scoped, and faithful to the documented commands without
  substantive changes.

## Command reference (verified against the primary source — authoritative field names)
Printed page numbers refer to doc #API-UG-14 (PDF index = printed + 5). Response fields live
inside `<DETAILS>`. List-typed PARAMS show their wire shape.

Actions
- **ActivateOutput** (p. 41) / **DeactivateOutput** (p. 65) — PARAMS `OUTPUTKEY`. Response `OUTPUTKEY`. FAIL: "Invalid output key", "Output not online or reachable", "Output state not changed".
- **LockPortal** (p. 145) / **UnlockPortal** (p. 195) / **MomentaryUnlockPortal** (p. 176) / **DogOnNextExitPortal** (p. 73) — PARAMS `PORTALKEY`. Response `PORTALKEY`. FAIL: "Invalid portal key", "Portal not online or reachable", "Portal state not changed" (+ "Command not supported for this device type" for DogOnNextExit). UnlockPortal = *Extended Unlock* until LockPortal; MomentaryUnlock duration comes from the portal definition.
- **SetThreatLevel** (p. 189) — PARAMS `LEVELNAME`. Response: none.

Time specs / groups
- **AddTimeSpec** (p. 62) — PARAMS `NAME`, `DESCRIPTION`, `STARTTIME` `HH:MM`, `ENDTIME` `HH:MM`, `MONDAY`…`SUNDAY` (`1`/`0`), `HOLIDAYGROUPS` (comma list of 1–8). Response `TIMESPECKEY`.
- **ModifyTimeSpec** (p. 170) — PARAMS `TIMESPECKEY` + same optionals. Response: none. FAIL includes "Cannot modify timespecs ALWAYS or NEVER".
- **DeleteTimeSpec** (p. 71) — PARAMS `TIMESPECKEY`. Response `TIMESPECKEY`. FAIL includes "Delete Failed: May be referenced elsewhere".
- **AddTimeSpecGroup** (p. 64) — PARAMS `NAME`, `DESCRIPTION`. Response `TIMESPECGROUPKEY` (the doc example shows it directly under RESPONSE; parse it from DETAILS or RESPONSE).
- **ModifyTimeSpecGroup** (p. 172) — PARAMS `TIMESPECGROUPKEY`, `NAME` opt, `DESCRIPTION` opt, `TIMESPECKEYS` → `<TIMESPECKEYS><TIMESPECKEY>k</TIMESPECKEY>…</TIMESPECKEYS>`; **replaces** all members. Response: none.
- **DeleteTimeSpecGroup** (p. 72) — PARAMS `TIMESPECGROUPKEY`. Response `TIMESPECGROUPKEY`.
- **GetTimeSpec** (p. 129) — PARAMS `TIMESPECKEY`. Response `TIMESPEC` {`TIMESPECKEY`, `NAME`, `DESCRIPTION`, `STARTTIME`, `ENDTIME`, `MONDAY`…`SUNDAY` (live: `TRUE`/`FALSE`), `HOLIDAYGROUPS`}.
- **GetTimeSpecs** (p. 131) — PARAMS `STARTFROMKEY` opt. Response `TIMESPECS`/`TIMESPEC`[…], `NEXTKEY` (`-1` = end).
- **GetTimeSpecGroup** (p. 133) — PARAMS `TIMESPECGROUPKEY`. Response `TIMESPECGROUP` {`TIMESPECGROUPKEY`, `NAME`, `DESCRIPTION`, `TIMESPECKEYS`/`TIMESPECKEY`[…]}.
- **GetTimeSpecGroups** (p. 135) — PARAMS `STARTFROMKEY` opt. Response `TIMESPECGROUPS`/`TIMESPECGROUP`[…], `NEXTKEY`.

Holidays
- **AddHoliday** (p. 49) — PARAMS `HOLIDAYNAME` (≤ 64), `HOLIDAYGROUPS`, `STARTDATE`, `ENDDATE` (`YYYY-MM-DD HH:MM`; ENDDATE exclusive). Response `HOLIDAYKEY`. FAIL includes "Cannot exceed count of 30 Holidays per partition", "Duplicate".
- **ModifyHoliday** (p. 157) — PARAMS `HOLIDAYKEY`, `HOLIDAYNAME`, `HOLIDAYGROUPS`, `STARTDATE`, `ENDDATE`. Response: none.
- **DeleteHoliday** (p. 68) — PARAMS `HOLIDAYKEY`. Response `HOLIDAYKEY`.
- **GetHoliday** (p. 103) — PARAMS `HOLIDAYKEY`. Response `HOLIDAY` {`NAME`, `HOLIDAYGROUPS`, `STARTDATE`, `ENDDATE`} (live: `YYYY-MM-DD HH:MM:SS`).
- **GetHolidays** (p. 104) — PARAMS `STARTFROMKEY` opt. Response `HOLIDAYS` = comma-separated key string (live: `"1"`), `NEXTKEY` may be absent.

Portal groups / reader groups
- **AddPortalGroup** (p. 56) — PARAMS `NAME` (≤ 64), `DESCRIPTION`, `UNLOCKTIMESPECGROUPKEY`, `THREATLEVELGROUPKEY` opt, `PORTALKEYS` → `<PORTALKEYS><PORTALKEY>k</PORTALKEY>…</PORTALKEYS>`. Response `PORTALGROUPKEY`. FAIL includes "Duplicate".
- **ModifyPortalGroup** (p. 165) — PARAMS `PORTALGROUPKEY`, `NAME` opt, `DESCRIPTION` opt, membership (the doc says `PORTALKEY` required and its example sends repeated top-level `<PORTALKEY>` siblings — **live 6.2.0: that shape is ignored and the group ends up empty; send `<PORTALKEYS><PORTALKEY>…</PORTALKEYS>` exactly as AddPortalGroup does**), `UNLOCKTIMESPECGROUPKEY` opt, `THREATLEVELGROUPKEY` opt. Response: none. Membership is replaced by whatever list is parsed — always send the complete list.
- **DeletePortalGroup** (p. 69) — PARAMS `PORTALGROUPKEY`. Response `PORTALGROUPKEY`.
- **GetPortalGroup** (p. 114) — PARAMS `PORTALGROUPKEY`. Response `PORTALGROUP` {`PORTALGROUPKEY`, `NAME`, `DESCRIPTION`, `PORTALS`/`PORTAL`[{`PORTALKEY`, `NAME`}], `UNLOCKTIMESPECGROUPKEY`, `THREATLEVELGROUPKEY`}.
- **GetPortalGroups** (p. 116) — PARAMS `STARTFROMKEY` opt. Response `PORTALGROUPS`/`PORTALGROUP`[…], `NEXTKEY`.
- **AddReaderGroup** (p. 58) — PARAMS `NAME`, `DESCRIPTION`, `READERKEYS` → `<READERKEYS><READERKEY>k</READERKEY>…</READERKEYS>`. Response `READERGROUPKEY`.
- **ModifyReaderGroup** (p. 167) — PARAMS `READERGROUPKEY`, `NAME` opt, `DESCRIPTION` opt, `READERKEYS` (doc: opt; **live 6.2.0: omitting it clears the membership**, so always send the complete list). Response: none.
- **DeleteReaderGroup** (p. 70) — PARAMS `READERGROUPKEY`. Response `READERGROUPKEY`. FAIL includes "Cannot Delete: May be referenced by an Access Level".
- **GetReaderGroup** (p. 124) — PARAMS `READERGROUPKEY`. Response `READERGROUP` {`READERGROUPKEY`, `NAME`, `DESCRIPTION`, `READERS`/`READER`[{`READERKEY`, `NAME`}]}.
- **GetReaderGroups** (p. 126) — PARAMS `STARTFROMKEY` opt. Response `READERGROUPS`/`READERGROUP`[…], `NEXTKEY`.
- **GetOutputs** (p. 105) — PARAMS `STARTFROMKEY` opt. Response `OUTPUTS`/`OUTPUT`[{`NAME`, `OUTPUTKEY`}], `NEXTKEY`.

Access levels
- **AddAccessLevel** (p. 42) — PARAMS `ACCESSLEVELNAME` (≤ 64), `ACCESSLEVELDESCRIPTION`, `READERKEY` opt, `READERGROUPKEY` opt (only one of the two), `TIMESPECGROUPKEY` (required), `THREATLEVELGROUPKEY` opt. Response `ACCESSLEVELKEY`.
- **ModifyAccessLevel** (p. 148) — PARAMS `ACCESSLEVELKEY` + the same optionals (doc says TIMESPECGROUPKEY required; its example omits it). Response: none.
- **DeleteAccessLevel** (p. 66) — PARAMS `ACCESSLEVELKEY`. Response `ACCESSLEVELKEY`.
- **AddAccessLevelGroup** (p. 44) — PARAMS `NAME`, `DESCRIPTION`, `PARTITIONKEY` opt or `SYSTEMGROUP` opt (`1`), `ACCESSLEVELS` → `<ACCESSLEVELS><ACCESSLEVEL><NAME>…</NAME>|<KEY>…</KEY>[<PARTITIONKEY>…</PARTITIONKEY>]</ACCESSLEVEL>…</ACCESSLEVELS>`. Response `ACCESSLEVELGROUPKEY`.
- **ModifyAccessLevelGroup** (p. 152) — PARAMS `ACCESSLEVELGROUPKEY`, `NAME` opt, `DESCRIPTION` opt, `ACCESSLEVELS` opt (replaces). Response `ACCESSLEVELGROUPKEY` or none.
- **DeleteAccessLevelGroup** (p. 67) — PARAMS `ACCESSLEVELGROUPKEY`. Response: none.
- **GetAccessLevelNames** (p. 85) — PARAMS `PARTITIONKEY` opt (only `0` allowed), `STARTFROMNAME` opt. Response `ACCESSLEVELS`/`ACCESSLEVEL`[name | {`NAME`, `PARTITIONKEY`}], `NEXTNAME`.

Persons / credentials
- **AddPerson** (p. 52) — PARAMS `PERSONID` opt, `LASTNAME` (required), `FIRSTNAME`, `MIDDLENAME`, `NOTES`, `EXPDATE`, `ACTDATE`, `UDF1`…`UDF20`, `PIN`, `ACCESSLEVELS` (two syntaxes, see Context), `PICTURE`/`PICTUREEXT`/`PICTUREURL` (not exposed), `BADGELAYOUT`, `CONTACTPHONE`, `CONTACTEMAIL`, `CONTACTSMSEMAIL`, `CONTACTLOCATION`, `OTHERCONTACTNAME`, `OTHERCONTACTPHONE1`, `OTHERCONTACTPHONE2`, `VEHICLES` → `<VEHICLES><VEHICLE><VEHICLECOLOR>…<VEHICLEMAKE>…<VEHICLEMODEL>…<VEHICLESTATE>…<VEHICLELICNUM>…<VEHICLETAGNUM>…</VEHICLE>…</VEHICLES>`, `PARTITIONKEY` (S2 Global only; not exposed). Response `PERSONID`. FAIL includes "Duplicate", "Missing Last Name".
- **ModifyPerson** (p. 159) — PARAMS `PERSONID` (required) + AddPerson's optionals, `PERSONPURGE` (`TRUE`), `DELETED` (`TRUE`/`FALSE`), `ALLPARTITIONS` (`TRUE`), `VEHICLE` items may carry `DELETE` (`1`). Name-syntax `ACCESSLEVELS` **replaces** all access levels; alternative syntax is additive. Response `PERSONID`.
- **RemovePerson** (p. 180) — PARAMS `PERSONID`. Response: none.
- **AddCredential** (p. 47) — PARAMS `PERSONID`, `CARDFORMAT`, `ENCODEDNUM` and/or `HOTSTAMP` (one required), `WANTCREDENTIALID` opt (`1`), `CARDSTATUS` opt, `CARDEXPDATE` opt. Response `CREDENTIALID` when requested.
- **ModifyCredential** (p. 154) — PARAMS `PERSONID`, `CARDFORMAT`, `ENCODEDNUM`, `HOTSTAMP` opt, `CREDENTIALID` (alternative identifier), `DISABLED` (`1`/`0`) xor `CARDSTATUS`, `CARDEXPDATE`. Response: none. FAIL includes "At least one of Disabled, Hotstamp, Card Status or Card Expiration date parameters must be specified."
- **RemoveCredential** (p. 178) — PARAMS `PERSONID`, `CARDFORMAT`, `ENCODEDNUM`/`HOTSTAMP`, or `CREDENTIALID`. Response: none.

Threat levels
- **AddThreatLevel** (p. 60) — PARAMS `LEVELNAME`, `SEQNUM` opt, `COLOR` opt (White/Green/Blue/Yellow/Orange/Red). Response: none. (Six defaults; two more may be added.)
- **ModifyThreatLevel** (p. 168) — PARAMS `LEVELNAME`, `SEQNUM`, `COLOR`. Response: none.
- **RemoveThreatLevel** (p. 181) — PARAMS `LEVELNAME`. Response: none.
- **AddThreatLevelGroup** (p. 61) — PARAMS `LEVELGROUPNAME`, `LEVELNAMES` opt → `<LEVELNAMES><LEVELNAME>…</LEVELNAME>…</LEVELNAMES>`. Response: none.
- **ModifyThreatLevelGroup** (p. 169) — PARAMS `LEVELGROUPNAME`, `LEVELNAMES` (replaces). Response: none.
- **RemoveThreatLevelGroup** (p. 182) — PARAMS `LEVELGROUPNAME`. Response: none.

Events / activity / utility
- **TriggerEvent** (p. 194) — PARAMS `EVENTNAME`, `EVENTACTION` (`ACTIVATE`/`DEACTIVATE`), `PARTITIONID` opt (Master assumed). Doc address `/appd/nbapi`; requires sessionid. Response: none.
- **InsertActivity** (p. 140) — PARAMS `ACTIVITYTYPE` (`ACCESSGRANTED`/`ACCESSDENIED`/`USERACTIVITY`), `DETAILS` (`DISABLED`/`EXPIRED`/`LOCATION`/`PIN`/`TIME`/`UNKNOWN`), `PORTALKEY` xor `ELEVATORKEY`, `FLOORKEY` (with ELEVATORKEY), `READERKEY`, `PERSONID`, `CARDFORMAT`, `ENCODEDNUM`, `ACTIVITYTEXT` (≤ 255). Response: none.
- **PingApp** (p. 177) — PARAMS none. Response: none.
- **GetPartitions** (p. 107) — PARAMS none. Response `PARTITIONS`/`PARTITION`[{`PARTITIONKEY`, `NAME`, `DESCRIPTION`}] (live: `NEXTKEY` `-1` also present).
- **AddPartition** (p. 51) — PARAMS `NAME`, `DESCRIPTION`, `TIMEZONE`. Response `PARTITIONKEY`. Requires full system setup privilege.
- **SwitchPartition** (p. 192) — PARAMS `PARTITIONKEY`. Response: none; all subsequent commands in the session apply to that partition.
- **GetUDFLists** (p. 137) — PARAMS none. Response `UDFLISTS`/`UDFLIST`[{`UDFLISTKEY`, `NAME`, `DESCRIPTION`}]. FAIL "No configured UDF LISTS" when empty.
- **GetUDFListItems** (p. 138) — PARAMS `UDFLISTKEY`. Response `UDFLISTKEY`, `NAME`, `LISTITEMS`/`LISTITEM`[{`ITEMKEY`, `ITEMNAME`, `CUSTOMKEY`}].
- **ModifyUDFListItems** (p. 174) — PARAMS `UDFLISTKEY`, `LISTITEMS` → `<LISTITEMS><LISTITEM><ITEMKEY>…<DELETE>0|1</DELETE><ITEMNAME>…<CUSTOMKEY>…</LISTITEM>…</LISTITEMS>` (max 10; all-or-nothing). Response: none.
- **GetElevators** (p. 98) — PARAMS `STARTFROMKEY` opt. Response `ELEVATORS`/`ELEVATOR`[{`KEY`, `NAME`}], `NEXTKEY`.
- **GetFloors** (p. 101) — PARAMS `STARTFROMKEY` opt. Response `FLOORS`/`FLOOR`[{`NAME`, `KEY`, `SEQUENCE`}], `NEXTKEY`.

## Open questions
(none)
