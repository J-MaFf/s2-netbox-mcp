# Spec: NBAPI v2 full conformance — remaining commands, live verification, doc diff, STATUS refresh

## Goal
Bring `s2-netbox-mcp` to full command-level conformance with LenelS2's April-2025 NBAPI v2 guide by
wiring in the 24 documented commands it still lacks, live-verify the unreleased conformance batch
already on `main`, record the three-document command diff, and refresh `STATUS.md`/`README.md` so
they describe the server as it actually is.

## Context

### Where this builds on
- Repo: `s2-netbox-mcp` (GitHub `J-MaFf/s2-netbox-mcp`), `main` at `3e99a15`, clean, `v0.3.0`
  tagged plus 19 unreleased commits (issues #61–#88: enrichment flags, `get_threat_levels`, field
  additions, three required-field tightenings, two fixes — see `CHANGELOG.md` `[Unreleased]`).
  662 unit tests in 33 files pass; `npm run typecheck` and `npm run build` are clean.
- Cutting the release is **not** part of this spec (the maintainer deferred it). Do not bump
  `package.json`/`server.json` versions or tag.
- Existing conventions to extend, not replace (all verified by reading the files):
  - `src/commands.ts` — the closed `NBAPI_COMMANDS` map, currently **81** entries; the only file
    allowed to contain NBAPI command-name string literals. `test/commandAllowlist.test.ts` asserts
    the exact count (81) and the confinement rule.
  - `test/registration.test.ts` asserts tool counts **38 / 77 / 88** (writes off / writes on /
    writes + destructive on).
  - `src/tools/<category>.ts` modules export `registerXxxTools(server, client, gate)`; read tools
    are registered unconditionally, then `if (!gate.writesEnabled) return;`, then destructive tools
    inside `if (gate.destructiveEnabled)`. Every `src/tools/*.ts` module is wired in
    `src/index.ts`. Reference implementation: `src/tools/threatLevel.ts`.
  - `src/toolHelpers.ts`: `runNbapiTool(client, command, params, formatter?)`, `mergeParams`,
    `formatWriteSuccess`, `wrapList(wrapperKey, itemKey, items)`, `ToolGateFlags`.
  - `src/xml.ts` `buildParamsXml` serialises nested objects as nested elements and arrays as
    repeated sibling elements; scalars via `String(value)`, so a JS `true` becomes `true`, **not**
    `TRUE`. Existing tools therefore model doc-"boolean" params as strings; this spec follows suit
    with `z.enum(['TRUE','FALSE'])`.
  - Tool descriptions prefix `WRITE:` / `DESTRUCTIVE:` and cite the wrapped command; param
    descriptions start with `Required.`/`Optional.` (see `threatLevel.ts`).
  - `README.md` "Tools exposed" has two tables: "Read tools (always registered)" (line ~278) and
    "Write tools and Destructive tools" (line ~579) with columns Tool / Wraps NBAPI command /
    Required params (/ Tier). README "Out of scope" (line ~1090) currently lists
    "Photo ID handling (`GetPicture` and photo upload)".
  - `scripts/live-check.ts` (`npm run test:live`, read-only): `runCheck(client, name, command,
    params, opts?)` with `acceptEmptyCollectionFail`, `chainedSingleCheck`, and bespoke
    `runXxxCheck` functions for enrichment flags; `main()` pushes `CheckResult`s and prints N/N.
  - `scripts/live-check-write.ts` (`npm run test:live:write`): `step(name, fn)` CRUD round-trips
    under the `MCP livecheck` name prefix, a supervised `--action <name> [--value]` mode, and a
    `--go` door phase (never run by the loop). `scripts/liveCheckWriteHelpers.ts` holds its
    unit-tested pure helpers (`test/liveCheckWrite.test.ts`).
  - `STATUS.md` structure: "What This Is" → "Current State — <date>" → "Previous State" sections →
    "Components" table → "Resolved Issues" table → "Open Issues" → "Natural Next Steps" →
    "Prerequisites to Run". `docs/reference/README.md` describes the four vendor PDFs.

### Verified facts from the vendor docs (`pdftotext -layout` over `docs/reference/*.pdf`)
- The v2 guide (`NetBox_API_V2.pdf`, #API2-UG-8) documents **105** command headings. Set-diffed
  against the 81 implemented commands, and discarding three PDF artefacts (`Enabled`,
  `LoginResponse`, `GetAddPartition` — the latter is a mis-typeset heading for `AddPartition`),
  exactly **24** documented commands are unimplemented:
  - Reads (12): `GetPortalStates`, `GetPortalStatuses`, `GetLocations`, `GetAlarms`, `GetPicture`,
    `GetMercuryPanels`, `GetMercuryPanel`, `GetNetworkNodes`, `GetNetworkNode`, `GetSios`,
    `GetSio`, `GetVirtualCredentialRequest`.
  - Non-destructive writes (8): `AddDutyLog`, `AddVirtualCredentialRequest`, `AddMercuryPanel`,
    `ModifyMercuryPanel`, `AddNetworkNode`, `ModifyNetworkNode`, `AddSio`, `ModifySio`.
  - Destructive (4): `RemoveVirtualCredentialRequest`, `DeleteMercuryPanel`, `DeleteNetworkNode`,
    `DeleteSio`.
- The April-2024 v1 guide (`NetBox_API_V1.pdf`, #API-UG-22) documents 80 commands = the 81
  implemented minus `Login`/`Logout` plus the deprecated `LoginUserPassword`. Every one of the 24
  above is v2-only. **Neither guide documents any Add/Modify/Delete command for elevators or
  floors** — this answers `STATUS.md` "Natural Next Steps" item 2 definitively.
- v2's "Deprecated Commands" table (p.278): `EditPerson`, `EditThreatLevel`,
  `EditThreatLevelGroup`, `GetAccessDataLog`, `GetAccessCardDetails`, `LoginUserName`,
  `LoginUserPassword`. None are implemented; keep it that way.
- Protocol: v2 uses the same XML envelope and the same `/nbws/goforms/nbapi` path the server
  already posts to; "Enable V2" on the controller's Data Integration page is the switch the README
  already requires. The server therefore already speaks NBAPI v2; the v1 end-of-support notice does
  not affect it. Record this, do not re-architect anything.
- `Data_Operations.pdf` describes a **UI/NAS feature with no API**: import files are uploaded on
  the Administration → Data Operations page or picked up from a configured NAS share on a
  schedule; export files are downloaded from the same page. The maintainer decided **not** to
  build any Data Operations tooling. Record the finding only.
- Per-command calling parameters for the 24 (from v2's Calling Parameters + worked examples):
  - `GetPortalStates`: optional `PORTALSTATES` (TRUE/FALSE — all partitions). Returns `STATEKEY`/`STATENAME` list.
  - `GetPortalStatuses`: optional `ALLPARTITIONS`, `PORTALKEY`, `STATEKEY`, `PARTITIONKEY`, `LOCATIONKEY`. Returns `PORTALSTATUS` blocks with `PORTALKEY`, `PORTALNAME`, `STATEKEY`, `STATENAME`, `THREATLEVELNAME`, `LOCATIONKEY`, `LOCATIONNAME`, `TYPEKEY`, `PARTITIONKEY`. This is the first NBAPI read of live portal state the server will have.
  - `GetLocations`: optional `ALLPARTITIONS`. Returns `LOCATIONKEY`, `PARTITIONKEY`, `PARENTLOCATION{PARENTKEY,NAME}`. FAIL includes `Invalid STARTFROMKEY`, so `STARTFROMKEY` is also accepted (optional).
  - `GetAlarms`: optional `ALLPARTITIONS`, `PARTITIONKEY`, `ID`, `EVENTID`, `ACTIVITYID`, `OWNERID`. Returns `ALARMS/ALARM[]`.
  - `GetPicture`: required `PERSONID`. Returns `PICTURE` (Base64 JPEG) plus `PICTUREURL`, `LASTNAME`, `FIRSTNAME`, `LASTMOD`.
  - `GetMercuryPanels`: optional `ALLPARTITIONS` (TRUE/FALSE), `PARTITIONKEY`, `MERCURYKEY`, `NAME`. `GetMercuryPanel`: required `MERCURYKEY`.
  - `GetNetworkNodes`: optional `ALLPARTITIONS`, `PARTITIONKEY`, `NODEKEY`, `UNIQUEIDENTIFIER`, `NAME`. `GetNetworkNode`: required `NODEKEY`, optional `PARTITIONKEY`.
  - `GetSios`: required `MERCURYKEY` (response carries `NEXTKEY`). `GetSio`: required `SIOKEY` (the doc's example wrongly sends `MERCURYKEY`; follow Calling Parameters).
  - `GetVirtualCredentialRequest` / `AddVirtualCredentialRequest` / `RemoveVirtualCredentialRequest`: required `PERSONID`, `CARDFORMAT`.
  - `AddDutyLog`: required `PERSONID`, `LOGTEXT`; optional `ACTIVITYID`, `PARTITIONKEY`.
  - `AddMercuryPanel`: required `NAME`, `TYPE` (enum: `EP/LP1501`, `EP/LP1502`, `EP/LP2500`, `EP/LP4502`, `M5-IC`, `MP1501`, `MP1502`, `MP2500`, `MP4502`, `MS-ICS`, `PIM400-1501`, `PW6K1IC`, `Pro4200`), `ENABLED` (TRUE/FALSE), `PARTITIONKEY`, nested `NETWORK{IPADDRESS (required), TLSSECURE (required TRUE/FALSE), RETRYCOUNT, POLLDELAY, REPLYTIMEOUT, RETRYINTERVAL (optional)}`; optional `TIMEZONE`, nested `SIOCHANNELSETTINGS{SIOCHANNEL0..SIOCHANNEL3}`. Success returns `MERCURYKEY`.
  - `ModifyMercuryPanel`: required `MERCURYKEY` (present in the worked example though omitted from the bullet list), same fields as Add with `TYPE`/`PARTITIONKEY` documented as unchangeable (still accepted, optional).
  - `DeleteMercuryPanel`: required `MERCURYKEY`.
  - `AddNetworkNode`: required `NAME`, `TYPE` (enum, case-sensitive: `M1-3200`, `MicroNode Plus`, `Node`, `MicroNode`, `NanoNode`), `ENABLED`, `PARTITIONKEY`, `UNIQUEIDENTIFIER` (16 hex chars), `DHCPENABLED`; optional `TIMEZONE`, `REALTIMEDISKPOLICYENABLED`, `IPADDRESS`, `NETMASK`, `GATEWAY`, `CONFIGLOCKEDENABLED`, `AUTODISCOVERENABLED`, `NETWORKCONTROLLERIPADDRESS`, `SECONDARYCONTROLLERIPADDRESS`. Success returns `NODEKEY`.
  - `ModifyNetworkNode`: required `NODEKEY`; every other Add field optional (`UNIQUEIDENTIFIER`/`TYPE`/`PARTITIONKEY` omitted — not documented as modifiable).
  - `DeleteNetworkNode`: required `NODEKEY`.
  - `AddSio`: required `MERCURYKEY`, `NAME`, `MODEL`, `CHANNEL`, `ADDRESS` (0–31), `REVINPUT` (TRUE/FALSE); optional `IPADDRESS`, `HOSTNAME`, `USERNAME`, `PASSWORD`.
  - `ModifySio`: required `SIOKEY`, `NAME`, `REVINPUT`; optional `CHANNEL`, `ADDRESS`, `IPADDRESS`, `HOSTNAME`, `USERNAME`, `PASSWORD` (`MODEL` not modifiable — omit).
  - `DeleteSio`: required `SIOKEY` (the doc example wrongly sends `NODEKEY`; follow Calling Parameters).
- Live-verification gaps in the unreleased batch (checked against both live scripts):
  - `scripts/live-check.ts` has **no** check for `get_threat_levels`, for `PARTITIONKEY` on
    `get_access_levels`/`get_access_level_groups`, for the nine new `search_person_data` filters,
    or for the now-parameterless `get_holidays`.
  - `scripts/live-check-write.ts` already covers `add_holiday` with `HOLIDAYGROUPS`,
    `add_portal_group` with `UNLOCKTIMESPECGROUPKEY`, and `modify_threat_level` with `COLOR`
    (positive paths). It does **not** cover `modify_time_spec` `NAME` (rename),
    `add_time_spec_group` `TIMESPECKEYS` (seeded membership), `add_person` with
    `USERNAME`/`ROLE`/`AUTHTYPE` (the open question from #79 — when is `USERNAME` actually
    required?), or `set_threat_level` `LOCATIONKEYS`.
- Controller facts (from `bd memories`): NetBox 6.2.0, single partition `Master`, 67 portals,
  OSDP doors, no Mercury panels known, `GetTimeSpecGroup` by key always fails NOT FOUND (use the
  plural), and the maintainer's test portal is `NETBOX_LIVE_TEST_PORTALKEY` (02OF01A, key 56).

### Live-run policy (decided by the maintainer)
- The forge loop **may** run `npm run test:live` (read-only) against the controller using the
  `.env` already present, and must do so to close the read-side criteria.
- The loop must **not** run `npm run test:live:write`, `npm run test:live:write:daily`, any
  `--action`, or any `--go` phase. It extends the write script, unit-tests the helpers, then
  **pauses and asks the maintainer** to run `npx tsx scripts/live-check-write.ts` and paste the
  output. The loop resumes from the pasted output. Never fabricate a live result.

## Deliverable
All in the repo, one feature branch (`feat/nbapi-v2-full-conformance`), one GitHub issue, one PR:
1. `src/commands.ts` — 24 new `NBAPI_COMMANDS` entries (total **105**).
2. New tool modules `src/tools/hardware.ts` (Mercury panel / SIO / network node tools) and
   `src/tools/alarm.ts` (`get_alarms`, `add_duty_log`); `get_portal_states`, `get_portal_statuses`,
   `get_locations` added to `src/tools/portal.ts`; `get_picture` and the three virtual-credential
   tools added to `src/tools/person.ts`; both new modules wired in `src/index.ts`.
3. Unit tests: `test/commandAllowlist.test.ts` (105), `test/registration.test.ts` (50 / 97 / 112),
   and per-tool tests for every new tool (one XML-shape test per tool at minimum, mirroring
   `test/threatLevelTools.test.ts`).
4. `scripts/live-check.ts` — checks for the 12 new read tools and the four unreleased read gaps.
5. `scripts/live-check-write.ts` (+ `scripts/liveCheckWriteHelpers.ts` and its tests as needed) —
   steps for the four unreleased write gaps and for `add_duty_log`; **no** hardware CRUD or
   virtual-credential steps.
6. `docs/reference/nbapi-command-diff.md` — the three-way command diff report.
7. Doc updates: `README.md` (tool tables, Out of scope, the "not yet diffed" note at the top),
   `docs/reference/README.md` (diff done, link to the report), `CHANGELOG.md` `[Unreleased]`,
   `STATUS.md` (new Current State section, Components, Resolved Issues, Open Issues, Natural Next
   Steps).

## Requirements

### A. Allowlist and tool surface
- R1. `src/commands.ts` gains exactly the 24 commands listed in Context, spelled exactly as the v2
  guide spells them, grouped under comments by category; the map has 105 entries and no command
  literal appears outside this file. [verify: `test/commandAllowlist.test.ts` updated to 105 and
  passing; `grep -rn "'GetPortalStatuses'" src` hits only `commands.ts`]
- R2. Twelve read tools are registered regardless of gates, named by snake_casing the command
  (`get_portal_states`, `get_portal_statuses`, `get_locations`, `get_alarms`, `get_picture`,
  `get_mercury_panels`, `get_mercury_panel`, `get_network_nodes`, `get_network_node`, `get_sios`,
  `get_sio`, `get_virtual_credential_request`), each a thin pass-through via `runNbapiTool` whose
  zod schema declares exactly the Calling Parameters listed in Context with the stated
  required/optional split. [verify: `test/registration.test.ts` writes-off count is 50 and names
  include all twelve; per-tool XML-shape tests assert the PARAMS element set]
- R3. Eight write tools (`add_duty_log`, `add_virtual_credential_request`, `add_mercury_panel`,
  `modify_mercury_panel`, `add_network_node`, `modify_network_node`, `add_sio`, `modify_sio`) are
  registered only when `gate.writesEnabled`, use `formatWriteSuccess`, carry a `WRITE:` description
  prefix, and declare the required/optional split from Context. [verify: registration count 97
  with writes on; tests assert absence with writes off]
- R4. Four destructive tools (`remove_virtual_credential_request`, `delete_mercury_panel`,
  `delete_network_node`, `delete_sio`) are registered only when both gates are on, carry a
  `DESTRUCTIVE:` prefix, and take exactly one required key each (`PERSONID`+`CARDFORMAT` for the
  virtual-credential removal). [verify: registration count 112 with both gates; tests assert
  absence with only writes on]
- R5. `add_mercury_panel`/`modify_mercury_panel` model `NETWORK` and `SIOCHANNELSETTINGS` as nested
  zod objects that serialise to nested `<NETWORK>…</NETWORK>` / `<SIOCHANNELSETTINGS>…` elements
  (never flattened); `TYPE` on `add_mercury_panel` and `add_network_node` is a closed `z.enum` of
  the doc's values; every doc-"boolean" param is `z.enum(['TRUE','FALSE'])`. [verify: XML-shape
  tests assert `<NETWORK><IPADDRESS>` nesting and that `ENABLED` renders `TRUE`, not `true`]
- R6. `get_picture`'s description states the response contains a Base64 JPEG under `PICTURE` and
  may be large; the tool passes the payload through unmodified. [verify: description text; test
  asserts `PICTURE` field survives `formatAsJson`]
- R7. Module header comments in `hardware.ts`/`alarm.ts` cite the v2 doc as the source and note
  that hardware CRUD is not live-verified (no Mercury hardware on the reference controller).
  [verify: read the comments]

### B. Live verification
- R8. `scripts/live-check.ts` gains checks for all 12 new read tools. Collection reads
  (`get_mercury_panels`, `get_network_nodes`, `get_locations`, `get_alarms`, `get_portal_states`,
  `get_portal_statuses`) use `acceptEmptyCollectionFail: true`; `get_mercury_panel`/`get_sios`/
  `get_sio`/`get_network_node` chain off their list and SKIP-pass when the list is empty;
  `get_picture` uses the first `PERSONID` from `search_person_data` and PASSes on either SUCCESS or
  a documented FAIL (`No picture URL for this person ID` / `Picture file does not exist`);
  `get_virtual_credential_request` uses that person plus the first `get_card_formats` name and
  PASSes on SUCCESS or the documented `CARDFORMAT NOT FOUND`. [verify: run `npm run test:live`;
  output lists each name with PASS/SKIPPED, never FAIL]
- R9. `scripts/live-check.ts` gains checks for the unreleased read gaps: `get_threat_levels`
  (expects the six default levels, i.e. ≥1 `LEVELNAME`), `get_access_levels` and
  `get_access_level_groups` with `PARTITIONKEY: '0'`, `search_person_data` issued once with each
  of the nine new filters set to a harmless value that must not error (e.g. `CARDSTATUS`), and
  `get_holidays` asserting an empty `PARAMS` block was sent. [verify: `npm run test:live` shows
  these four names PASS]
- R10. `npm run test:live` is run by the loop after R8/R9 and its N/N summary line is recorded in
  `STATUS.md` with the date. [verify: STATUS.md line matches the pasted script output]
- R11. `scripts/live-check-write.ts` gains steps, each following the existing `step()`/round-trip
  pattern and cleaning up after itself: (a) `modify_time_spec` renames the temp time spec via
  `NAME` and `get_time_specs` reflects the new name; (b) `add_time_spec_group` with
  `TIMESPECKEYS=[tempSpecKey]` and `get_time_spec_groups` shows the seeded member; (c)
  `add_person` **without** `USERNAME`/`ROLE`/`AUTHTYPE` still succeeds (regression guard for #79)
  and a second `add_person` **with** `USERNAME` but without `ROLE`/`AUTHTYPE` records whichever of
  SUCCESS or FAIL+ERRMSG the controller returns as an informational finding (both outcomes PASS
  the step; the ERRMSG text is printed); (d) `set_threat_level` with `LOCATIONKEYS` from
  `get_locations` (SKIP-pass if no locations) is added as a supervised `--action`, not a default
  step; (e) `add_duty_log` with the `PERSONID` of the temp person and `LOGTEXT` prefixed
  `MCP livecheck`, PASS on SUCCESS or the documented FAIL messages. [verify: unit tests for any new
  helpers; script typechecks; the maintainer's pasted run shows steps a, b, c, e PASS]
- R12. The loop does not execute any write live script; it requests the maintainer run it and
  records the pasted N/N summary and the #79 finding text in `STATUS.md` and, for the #79 finding,
  in `CHANGELOG.md`'s `add_person`/`modify_person` entry (replacing "pending live confirmation").
  [verify: no shell history/log of the loop invoking `live-check-write`; STATUS.md and CHANGELOG
  carry the maintainer-provided result]

### C. Command diff report
- R13. `docs/reference/nbapi-command-diff.md` contains one table with a row per command in the
  union of (v1 April-2024, v2 April-2025, implemented set), columns: Command · In v1-2024 · In
  v2-2025 · Implemented before this spec · Implemented after · MCP tool name(s) · Note. The three
  PDF artefacts are listed in a footnote as excluded, and the seven deprecated commands are rows
  marked "deprecated, intentionally unimplemented". [verify: row count = 105 documented − 3
  artefacts + `Login`/`Logout` = 104 command rows, spot-check 10 rows against the PDFs]
- R14. The report has a section "Elevators and floors" stating that neither guide documents any
  Add/Modify/Delete command for elevators or floors, and a section "Protocol" stating the server
  already posts v2's XML to `/nbws/goforms/nbapi` and that the v1 end-of-support notice does not
  affect it. [verify: sections present; claims match the PDFs]
- R15. The report has a section "Parameter-level diff, v1-2024 vs v2-2025" that, for each of the
  81 previously-implemented commands, states either "identical Calling Parameters" or lists the
  differing parameters; any parameter present in v2 but missing from the corresponding tool's
  schema is either added in this spec (with a test) or listed under a "Deliberately not modelled"
  sub-heading with a one-line reason. [verify: every implemented command appears exactly once;
  `grep` the tool schemas for each listed v2 parameter]
- R16. The report has a section "Data Operations" stating the guide describes a UI/NAS feature
  with no API and that no tooling was built. [verify: section present]

### D. Documentation refresh
- R17. `README.md`: every new read tool appears in the read table and every new write/destructive
  tool in the write table with its tier and required params; the top-of-file note "have not yet
  been diffed against either newer edition" is replaced by a sentence linking the diff report; the
  Out-of-scope bullet for `GetPicture` is rewritten to exclude only photo **upload** (multipart
  `/nbws/goforms/upload`), and new bullets record that elevator/floor writes do not exist in NBAPI
  and that Data Operations has no API. [verify: table rows count 12 + 12; grep for the old note
  returns nothing]
- R18. `docs/reference/README.md`: the final paragraph's "that has not been done yet" is replaced
  with a link to `nbapi-command-diff.md` and the date. [verify: grep]
- R19. `CHANGELOG.md` `[Unreleased]` gains "Added" bullets for the 24 tools (grouped by category,
  each citing the issue), a "Changed" bullet for the README out-of-scope change, and the #79
  resolution text from R12; the `docs/reference/` bullet's "neither newer NBAPI edition has yet
  been diffed" clause is updated to point at the report. [verify: read the section]
- R20. `STATUS.md` gains a new "Current State — <date>" section (previous one demoted to
  "Previous State") describing this work, with tool counts 50 / 97 / 112, allowlist 105, the unit
  test total from `npx vitest run`, and the live-run lines from R10/R12; the Components table gains
  rows for `hardware.ts`, `alarm.ts`, and `nbapi-command-diff.md`; Resolved Issues gains this
  spec's issue/PR; "Natural Next Steps" is rewritten to drop the answered items (elevators/floors,
  doc diff) and to list, at minimum: cut the release, Smithery listing, MAC auth still blocked on
  the undocumented checksum, and optionally using `get_portal_statuses` for unlock-window
  read-back. [verify: read the file; counts match the tests]
- R21. Existing behaviour is untouched: all 662 pre-existing unit tests still pass unmodified
  except the two count assertions, `npm run typecheck` and `npm run build` are clean. [verify:
  run all three]

## Out of scope
- Cutting v0.3.1/v0.4.0, bumping `package.json`/`server.json`, tagging, npm/MCP Registry publish.
- Any Data Operations tooling (import-file builder, export parser, NAS/upload automation).
- Photo upload (`/nbws/goforms/upload` multipart), `StreamEvents`, MAC authentication, S2 Global,
  the seven deprecated commands.
- Live-exercising hardware CRUD (`Add/Modify/DeleteMercuryPanel`, `Add/Modify/DeleteNetworkNode`,
  `Add/Modify/DeleteSio`) or virtual-credential writes; a supervised `--action` for them.
- Integrating `get_portal_statuses` into the unlock-window executors' read-back (note it as a
  next step only).
- Enrichment flags (`RESOLVE*`) on the new tools; composite tools built on them.
- The `--go` door phase and `test:live:write:daily`.
- Smithery listing, Antigravity setup for the second user (bead `s2-netbox-mcp-xx7`).

## Constraints
- Follow `~/.claude/skills/git-policies` and the repo `CLAUDE.md`: open a GitHub issue first,
  branch `feat/nbapi-v2-full-conformance`, signed commits, PR with `Fixes #N`, `--assignee J-MaFf
  --label enhancement`, stop at the merge gate (never auto-merge). `bd dolt push` after bead
  updates.
- Node ≥18.17 / TypeScript / zod / vitest as already configured; no new runtime dependencies.
- Windows host: run live scripts as `npx tsx scripts/live-check.ts` (npm swallows extra flags on
  this host's PowerShell — README already documents this).
- Never commit `.env` or controller credentials; redact hostnames in any pasted live output that
  lands in the repo (the scripts already redact).
- Do not modify `src/xml.ts`, `src/netboxClient.ts`, or `src/paging.ts` unless a new command's
  response shape cannot be handled otherwise; if you must, say why in the PR.
- Keep the live-run policy in Context: read-only runs by the loop, write runs by the maintainer.

## Acceptance rubric
- C1 (R1): PASS iff `NBAPI_COMMANDS` has exactly 105 entries including the 24 named commands and
  `test/commandAllowlist.test.ts` passes with the confinement rule intact.
- C2 (R2): PASS iff with both gates off `registration.test.ts` counts 50 tools and each of the 12
  read tool names is registered with a schema whose keys equal the Context parameter list.
- C3 (R3): PASS iff with writes on the count is 97, the 8 write tools are present, absent with
  writes off, and each description starts with `WRITE:`.
- C4 (R4): PASS iff with both gates on the count is 112, the 4 destructive tools are present,
  absent with only writes on, and each description starts with `DESTRUCTIVE:`.
- C5 (R5): PASS iff a test shows `add_mercury_panel` emitting nested `<NETWORK><IPADDRESS>…`
  and `<ENABLED>TRUE</ENABLED>`, and `TYPE` rejects a value outside the doc enum.
- C6 (R6): PASS iff `get_picture`'s description mentions Base64 and a test shows `PICTURE`
  passed through unmodified.
- C7 (R7): PASS iff both new modules' header comments cite the v2 doc and the not-live-verified
  caveat.
- C8 (R8): PASS iff `npm run test:live` output contains all 12 new tool names with PASS or
  SKIPPED and zero FAIL.
- C9 (R9): PASS iff the same output shows `get_threat_levels`, the two `PARTITIONKEY` checks,
  the `search_person_data` filter check, and the `get_holidays` empty-PARAMS check as PASS.
- C10 (R10): PASS iff `STATUS.md` records the `test:live` N/N line and date matching the run.
- C11 (R11): PASS iff `scripts/live-check-write.ts` contains steps a, b, c, e and the
  `set_threat_level` `--action` variant with `LOCATIONKEYS`, `npm run typecheck` passes, and any
  new helper has a unit test.
- C12 (R12): PASS iff there is no evidence the loop ran a write live script, and `STATUS.md` and
  `CHANGELOG.md` carry the maintainer-pasted write-run summary and the #79 finding. (This
  criterion requires the maintainer's pasted output; the loop must pause for it rather than fail
  or fabricate.)
- C13 (R13): PASS iff the diff table has 104 command rows with the specified columns and a
  10-row spot check against the PDFs finds no error.
- C14 (R14): PASS iff the "Elevators and floors" and "Protocol" sections exist and their claims
  are true per the PDFs.
- C15 (R15): PASS iff every one of the 81 pre-existing commands appears exactly once in the
  parameter-level section and every v2 parameter it lists as missing is either now in a tool
  schema or under "Deliberately not modelled" with a reason.
- C16 (R16): PASS iff the "Data Operations" section exists and says no API / nothing built.
- C17 (R17): PASS iff the README read table has 12 new rows, the write table 12 new rows, the old
  "not yet been diffed" sentence is gone, and the three Out-of-scope changes are present.
- C18 (R18): PASS iff `docs/reference/README.md` no longer says "has not been done yet" and links
  the report.
- C19 (R19): PASS iff `[Unreleased]` lists all 24 tools, the README out-of-scope change, and the
  #79 resolution.
- C20 (R20): PASS iff `STATUS.md` has the new dated Current State with 50/97/112, 105, the test
  total, both live-run lines, the three Components rows, the Resolved Issues row, and a Natural
  Next Steps list containing the four named items.
- C21 (R21): PASS iff `npx vitest run`, `npm run typecheck`, and `npm run build` all succeed and
  the only edits to pre-existing test files are the two count assertions.
- C-final: PASS iff a domain expert reviewing this artifact would accept it without substantive
  changes.

## Open questions
(none — all resolved with the maintainer on 2026-09-17: wire in all 24 commands; loop may run
read-only live checks only; no Data Operations tooling; release deferred.)
