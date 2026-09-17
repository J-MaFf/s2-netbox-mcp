# NBAPI command diff: v1 (April 2024) vs v2 (April 2025) vs this server

**Compiled 2026-09-17** for `specs/archive/nbapi-v2-full-conformance.md` (R13–R16).

Sources, all in this directory, read with `pdftotext -layout`:

- `NetBox_API_V1.pdf` — "Web-Based API for NetBox and Global", April 2024, document #API-UG-22.
- `NetBox_API_V2.pdf` — "NBAPI version 2 Guide for NetBox and Global", April 2025, document #API2-UG-8.
- `Data_Operations.pdf` — "Data Operations" user guide.

Everything below was re-derived from those PDFs for this report. Where the guides contradict
themselves, the resolution used by the code is stated in the row's Note and repeated in the tool
module's own header comment.

---

## How the command sets line up

| Set | Count |
| --- | ----- |
| Commands with a section in the v1-2024 Command Reference | 82 |
| Commands with a section in the v2-2025 Command Reference | 111 |
| Commands deprecated by both guides (listed in a table, never given a section) | 7 |
| **Union of the three — the row count of the table below** | **118** |
| Implemented by this server before `specs/archive/nbapi-v2-full-conformance.md` | 81 |
| Implemented by this server after it | 105 |

Three facts worth stating plainly, because each contradicts a reasonable first guess:

1. **The v1 command set is a strict subset of the v2 command set.** Not one command was removed
   between the two editions; v2 adds 29 and changes the Calling Parameters of nine (see the
   parameter-level section). So "supporting v2" never meant dropping anything.
2. **v1 documents `Login` and `Logout` in its own Command Reference**, alongside `GetPicture` and
   `StreamEvents`. The deprecated `LoginUserName`/`LoginUserPassword` appear only in v1's
   *Deprecated Commands* table (p. 197) — the same table v2 reprints on p. 278. Neither guide gives
   any of the seven deprecated commands a Command Reference section.
3. **`GetAddPartition` is not a command.** It is the mis-typeset heading of the `AddPartition`
   section on v2 p. 88; the body, the PARAMS list and the worked example all say `AddPartition`.
   This report treats it as `AddPartition` throughout, and `src/commands.ts` spells it
   `AddPartition`.

### Reconciling with the spec's estimate

`specs/archive/nbapi-v2-full-conformance.md` R13 predicted "105 documented − 3 artefacts + `Login`/`Logout`
= 104 command rows". That arithmetic does not survive a full heading extraction, so this report
carries **118** rows instead. The difference is entirely accounted for:

- The spec's "105 documented command headings" is exactly the 81 then-implemented commands plus the
  24 it set out to implement. A `pdftotext -layout` pass over the whole v2 Command Reference
  (pages 73–277) finds **111** headings — the same 105 plus six the spec's Context never mentions:
  `AckAlarm`, `AckEvent`, `AlarmClearActions`, `AlarmSetOwner`, `EventClearActions` and
  `StreamEvents`. They are rows in the table below, each marked not implemented with a reason.
- The spec's "− 3 artefacts" double-subtracts. Only `GetAddPartition` is a Command Reference
  artefact, and renaming it to `AddPartition` changes no count. `Enabled` and `LoginResponse` are
  headings in the *Intrusion Panel Integration* API's "Definitions" section (v2 pp. 56–66), not
  commands, and were never in the Command Reference count to begin with.
- The spec's "+ `Login`/`Logout`" double-counts: both already have v2 Command Reference sections
  (pp. 218 and 220).
- The seven deprecated commands are added as rows, per R13.

111 + 7 = 118. No command documented by either guide is omitted from the table.

---

## Command table

Columns: **Command** · **In v1-2024** · **In v2-2025** · **Implemented before this spec** ·
**Implemented after** · **MCP tool name(s)** · **Note**.

"Implemented" means the command name is in `src/commands.ts`'s closed `NBAPI_COMMANDS` allowlist and
at least one tool can issue it. A tool listed here may still be gated off at run time by
`NETBOX_ENABLE_WRITES` / `NETBOX_ENABLE_DESTRUCTIVE` — see the README's tool tables for the tier of
each one. `Login`/`Logout` are implemented but deliberately exposed as no tool: session lifecycle is
handled inside `src/netboxClient.ts`.

| Command | In v1-2024 | In v2-2025 | Implemented before this spec | Implemented after | MCP tool name(s) | Note |
| ------- | ---------- | ---------- | ---------------------------- | ----------------- | ---------------- | ---- |
| `AckAlarm` | No | Yes | No | No | — | Not implemented. Alarm-queue workflow command (acknowledge an alarm); out of scope for this project, which reads alarms but does not drive an operator queue. |
| `AckEvent` | No | Yes | No | No | — | Not implemented. Alarm-queue workflow command (acknowledge an alarm event); same reason as AckAlarm. |
| `ActivateOutput` | Yes | Yes | Yes | Yes | `activate_output` | — |
| `AddAccessLevel` | Yes | Yes | Yes | Yes | `add_access_level` | — |
| `AddAccessLevelGroup` | Yes | Yes | Yes | Yes | `add_access_level_group` | — |
| `AddCredential` | Yes | Yes | Yes | Yes | `add_credential` | — |
| `AddDutyLog` | No | Yes | No | Yes | `add_duty_log` | Added by this spec. |
| `AddHoliday` | Yes | Yes | Yes | Yes | `add_holiday` | — |
| `AddMercuryPanel` | No | Yes | No | Yes | `add_mercury_panel` | Added by this spec. |
| `AddNetworkNode` | No | Yes | No | Yes | `add_network_node` | Added by this spec. |
| `AddPartition` | Yes | Yes | Yes | Yes | `add_partition` | Typeset in the v2 Command Reference as the heading `GetAddPartition` (page 88); the section body, its PARAMS and its worked example are all AddPartition. Treated as AddPartition throughout this report. |
| `AddPerson` | Yes | Yes | Yes | Yes | `add_person` | v2 adds PERSONID, USERNAME, PASSWORD, ROLE, AUTHTYPE, MOBILEPHONE, MSUENABLED and BLUEDIAMONDENABLED. See issue #79. |
| `AddPortalGroup` | Yes | Yes | Yes | Yes | `add_portal_group` | — |
| `AddReaderGroup` | Yes | Yes | Yes | Yes | `add_reader_group` | — |
| `AddSio` | No | Yes | No | Yes | `add_sio` | Added by this spec. |
| `AddThreatLevel` | Yes | Yes | Yes | Yes | `add_threat_level` | — |
| `AddThreatLevelGroup` | Yes | Yes | Yes | Yes | `add_threat_level_group` | — |
| `AddTimeSpec` | Yes | Yes | Yes | Yes | `add_time_spec` | — |
| `AddTimeSpecGroup` | Yes | Yes | Yes | Yes | `add_time_spec_group` | — |
| `AddVirtualCredentialRequest` | No | Yes | No | Yes | `add_virtual_credential_request` | Added by this spec. |
| `AlarmClearActions` | No | Yes | No | No | — | Not implemented. Clears the actions an alarm triggered; alarm-queue workflow, out of scope. |
| `AlarmSetOwner` | No | Yes | No | No | — | Not implemented. Assigns an alarm to an operator; alarm-queue workflow, out of scope. |
| `DeactivateOutput` | Yes | Yes | Yes | Yes | `deactivate_output` | — |
| `DeleteAccessLevel` | Yes | Yes | Yes | Yes | `delete_access_level` | — |
| `DeleteAccessLevelGroup` | Yes | Yes | Yes | Yes | `delete_access_level_group` | — |
| `DeleteHoliday` | Yes | Yes | Yes | Yes | `delete_holiday` | — |
| `DeleteMercuryPanel` | No | Yes | No | Yes | `delete_mercury_panel` | Added by this spec. |
| `DeleteNetworkNode` | No | Yes | No | Yes | `delete_network_node` | Added by this spec. |
| `DeletePortalGroup` | Yes | Yes | Yes | Yes | `delete_portal_group` | — |
| `DeleteReaderGroup` | Yes | Yes | Yes | Yes | `delete_reader_group` | — |
| `DeleteSio` | No | Yes | No | Yes | `delete_sio` | Added by this spec. The guide’s worked example sends NODEKEY; its Calling Parameters list says SIOKEY. The tool follows the Calling Parameters list. |
| `DeleteTimeSpec` | Yes | Yes | Yes | Yes | `delete_time_spec` | — |
| `DeleteTimeSpecGroup` | Yes | Yes | Yes | Yes | `delete_time_spec_group` | — |
| `DogOnNextExitPortal` | Yes | Yes | Yes | Yes | `dog_on_next_exit_portal` | — |
| `EditPerson` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: AddPerson and ModifyPerson. |
| `EditThreatLevel` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: AddThreatLevel and ModifyThreatLevel. |
| `EditThreatLevelGroup` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: AddThreatLevelGroup and ModifyThreatLevelGroup. |
| `EventClearActions` | No | Yes | No | No | — | Not implemented. Clears the actions an event triggered; alarm/event workflow, out of scope. |
| `GetAccessCardDetails` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: GetCardAccessDetails. |
| `GetAccessDataLog` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: GetAccessHistory. |
| `GetAccessHistory` | Yes | Yes | Yes | Yes | `get_access_history` | — |
| `GetAccessLevel` | Yes | Yes | Yes | Yes | `get_access_level` | — |
| `GetAccessLevelGroup` | Yes | Yes | Yes | Yes | `get_access_level_group` | — |
| `GetAccessLevelGroups` | Yes | Yes | Yes | Yes | `get_access_level_groups` | — |
| `GetAccessLevelNames` | Yes | Yes | Yes | Yes | `get_access_level_names` | — |
| `GetAccessLevels` | Yes | Yes | Yes | Yes | `get_access_levels` | — |
| `GetAlarms` | No | Yes | No | Yes | `get_alarms` | Added by this spec. |
| `GetAPIVersion` | Yes | Yes | Yes | Yes | `check_connection` | — |
| `GetCardAccessDetails` | Yes | Yes | Yes | Yes | `get_card_access_details` | — |
| `GetCardFormats` | Yes | Yes | Yes | Yes | `get_card_formats` | — |
| `GetElevators` | Yes | Yes | Yes | Yes | `get_elevators` | Read-only by necessity: neither guide documents any Add/Modify/Delete command for elevators. See "Elevators and floors" below. |
| `GetEventHistory` | Yes | Yes | Yes | Yes | `get_event_history` | — |
| `GetFloors` | Yes | Yes | Yes | Yes | `get_floors` | Read-only by necessity: neither guide documents any Add/Modify/Delete command for floors. See "Elevators and floors" below. |
| `GetHoliday` | Yes | Yes | Yes | Yes | `get_holiday` | — |
| `GetHolidays` | Yes | Yes | Yes | Yes | `get_holidays` | — |
| `GetLocations` | No | Yes | No | Yes | `get_locations` | Added by this spec. STARTFROMKEY is not in the Calling Parameters list but appears in the documented FAIL messages (`Invalid STARTFROMKEY`), so the tool accepts it. |
| `GetMercuryPanel` | No | Yes | No | Yes | `get_mercury_panel` | Added by this spec. |
| `GetMercuryPanels` | No | Yes | No | Yes | `get_mercury_panels` | Added by this spec. |
| `GetNetworkNode` | No | Yes | No | Yes | `get_network_node` | Added by this spec. |
| `GetNetworkNodes` | No | Yes | No | Yes | `get_network_nodes` | Added by this spec. |
| `GetOutputs` | Yes | Yes | Yes | Yes | `get_outputs` | — |
| `GetPartitions` | Yes | Yes | Yes | Yes | `get_partitions` | — |
| `GetPerson` | Yes | Yes | Yes | Yes | `get_person` | — |
| `GetPicture` | Yes | Yes | No | Yes | `get_picture` | Added by this spec. Photo *upload* stays out of scope: it is a multipart POST to `/nbws/goforms/upload`, not an NBAPI XML command. |
| `GetPortalGroup` | Yes | Yes | Yes | Yes | `get_portal_group` | — |
| `GetPortalGroups` | Yes | Yes | Yes | Yes | `get_portal_groups` | — |
| `GetPortals` | Yes | Yes | Yes | Yes | `get_portals` | No singular `GetPortal` exists in either guide; `get_portals` nests each portal’s readers instead. |
| `GetPortalStates` | No | Yes | No | Yes | `get_portal_states` | Added by this spec. |
| `GetPortalStatuses` | No | Yes | No | Yes | `get_portal_statuses` | Added by this spec. The first NBAPI read of *live* portal state this server has had — everything else reads configuration. |
| `GetReader` | Yes | Yes | Yes | Yes | `get_reader` | — |
| `GetReaderGroup` | Yes | Yes | Yes | Yes | `get_reader_group` | — |
| `GetReaderGroups` | Yes | Yes | Yes | Yes | `get_reader_groups` | — |
| `GetReaders` | Yes | Yes | Yes | Yes | `get_readers` | — |
| `GetSio` | No | Yes | No | Yes | `get_sio` | Added by this spec. The guide’s worked example sends MERCURYKEY; its Calling Parameters list says SIOKEY. The tool follows the Calling Parameters list. |
| `GetSios` | No | Yes | No | Yes | `get_sios` | Added by this spec. |
| `GetThreatLevels` | No | Yes | Yes | Yes | `get_threat_levels` | v2-only; added to this server by issue #61 (unreleased) and live-verified by this spec’s R9 check. |
| `GetTimeSpec` | Yes | Yes | Yes | Yes | `get_time_spec` | — |
| `GetTimeSpecGroup` | Yes | Yes | Yes | Yes | `get_time_spec_group` | Live quirk on NetBox 6.2.0: returns CODE=FAIL/ERRMSG="NOT FOUND" for every key, including keys GetTimeSpecGroups just listed. Use the plural. |
| `GetTimeSpecGroups` | Yes | Yes | Yes | Yes | `get_time_spec_groups` | — |
| `GetTimeSpecs` | Yes | Yes | Yes | Yes | `get_time_specs` | — |
| `GetUDFListItems` | Yes | Yes | Yes | Yes | `get_udf_list_items` | — |
| `GetUDFLists` | Yes | Yes | Yes | Yes | `get_udf_lists` | — |
| `GetVirtualCredentialRequest` | No | Yes | No | Yes | `get_virtual_credential_request` | Added by this spec. |
| `InsertActivity` | Yes | Yes | Yes | Yes | `insert_activity` | — |
| `ListEvents` | Yes | Yes | Yes | Yes | `list_events` | — |
| `LockPortal` | Yes | Yes | Yes | Yes | `lock_portal` | — |
| `Login` | Yes | Yes | Yes | Yes | — | Session lifecycle; handled inside `src/netboxClient.ts`, not exposed as a tool. |
| `LoginUserName` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: N/A. |
| `LoginUserPassword` | Deprecated table only | Deprecated table only | No | No | — | Deprecated, intentionally unimplemented. Replace with: N/A. |
| `Logout` | Yes | Yes | Yes | Yes | — | Session lifecycle; handled inside `src/netboxClient.ts` and `src/shutdown.ts`, not exposed as a tool. |
| `ModifyAccessLevel` | Yes | Yes | Yes | Yes | `modify_access_level` | — |
| `ModifyAccessLevelGroup` | Yes | Yes | Yes | Yes | `modify_access_level_group` | — |
| `ModifyCredential` | Yes | Yes | Yes | Yes | `modify_credential` | — |
| `ModifyHoliday` | Yes | Yes | Yes | Yes | `modify_holiday` | — |
| `ModifyMercuryPanel` | No | Yes | No | Yes | `modify_mercury_panel` | Added by this spec. MERCURYKEY is absent from the bullet list but present in the worked example, so the tool requires it. |
| `ModifyNetworkNode` | No | Yes | No | Yes | `modify_network_node` | Added by this spec. NODEKEY is absent from the bullet list but required by the command’s own description, so the tool requires it. |
| `ModifyPerson` | Yes | Yes | Yes | Yes | `modify_person` | v2 adds USERNAME, PASSWORD, ROLE, AUTHTYPE, MOBILEPHONE, MSUENABLED, BLUEDIAMONDENABLED, TRACE and TRACEMESSAGE. See issue #79 and the parameter-level section. |
| `ModifyPortalGroup` | Yes | Yes | Yes | Yes | `modify_portal_group` | — |
| `ModifyReaderGroup` | Yes | Yes | Yes | Yes | `modify_reader_group` | — |
| `ModifySio` | No | Yes | No | Yes | `modify_sio` | Added by this spec. |
| `ModifyThreatLevel` | Yes | Yes | Yes | Yes | `modify_threat_level` | — |
| `ModifyThreatLevelGroup` | Yes | Yes | Yes | Yes | `modify_threat_level_group` | — |
| `ModifyTimeSpec` | Yes | Yes | Yes | Yes | `modify_time_spec` | — |
| `ModifyTimeSpecGroup` | Yes | Yes | Yes | Yes | `modify_time_spec_group` | — |
| `ModifyUDFListItems` | Yes | Yes | Yes | Yes | `modify_udf_list_items` | — |
| `MomentaryUnlockPortal` | Yes | Yes | Yes | Yes | `momentary_unlock_portal` | — |
| `PingApp` | Yes | Yes | Yes | Yes | `ping_app` | — |
| `RemoveCredential` | Yes | Yes | Yes | Yes | `remove_credential` | — |
| `RemovePerson` | Yes | Yes | Yes | Yes | `remove_person` | — |
| `RemoveThreatLevel` | Yes | Yes | Yes | Yes | `remove_threat_level` | — |
| `RemoveThreatLevelGroup` | Yes | Yes | Yes | Yes | `remove_threat_level_group` | — |
| `RemoveVirtualCredentialRequest` | No | Yes | No | Yes | `remove_virtual_credential_request` | Added by this spec. |
| `SearchPersonData` | Yes | Yes | Yes | Yes | `search_person_data` | v2 adds nine filters (CARDFORMAT, CARDSTATUS, MSUENABLED, BLUEDIAMONDENABLED, CONTACTEMAIL, MOBILEPHONE, NOTES, VEHICLELICNUM, VEHICLETAGNUM), all modelled and live-verified by this spec’s R9 check. |
| `SetThreatLevel` | Yes | Yes | Yes | Yes | `set_threat_level` | LOCATIONKEYS is v2-only and was added by issue #88 (unreleased). Live-exercised only through the supervised `--action set_threat_level_locations`. |
| `StreamEvents` | Yes | Yes | No | No | — | Not implemented, deliberately. Opens a long-lived streaming connection, which does not fit the request/response MCP tool model; recorded in the README Out-of-scope list. |
| `SwitchPartition` | Yes | Yes | Yes | Yes | `switch_partition` | — |
| `TriggerEvent` | Yes | Yes | Yes | Yes | `trigger_event` | — |
| `UnlockPortal` | Yes | Yes | Yes | Yes | `unlock_portal` | — |

**118 command rows.**

---

## Elevators and floors

**Neither guide documents any `Add`, `Modify` or `Delete` command for elevators or floors.** The
complete elevator/floor surface in both editions is:

| Command | v1-2024 | v2-2025 | Calling Parameters |
| ------- | ------- | ------- | ------------------ |
| `GetElevators` |  Yes (p. 100) | Yes (p. 149) | `STARTFROMKEY` (optional) |
| `GetFloors` |  Yes (p. 103) | Yes (p. 153) | `STARTFROMKEY` (optional) |
| `InsertActivity` | Yes | Yes | accepts `ELEVATORKEY` and `FLOORKEY` to attribute an activity record to an elevator/floor |

That is all. There is no `AddElevator`, `ModifyElevator`, `DeleteElevator`, `AddFloor`,
`ModifyFloor` or `DeleteFloor` in either Command Reference, and no elevator/floor block inside any
other command's PARAMS that would let one be created indirectly. Elevators and floors are configured
through the NetBox web UI only.

This settles, definitively, the open question that stood as item 2 of `STATUS.md`'s "Natural Next
Steps": `get_elevators` and `get_floors` are read-only here **because the API is read-only for these
objects**, not because the project chose not to write them. Nothing further can be built without a
vendor API that does not exist. The README's Out-of-scope list now records this so the question is
not reopened.

---

## Protocol

**The server already speaks NBAPI v2. Nothing needs re-architecting.**

- **Same endpoint.** v2 posts to `http://<NetBox IP address>/nbws/goforms/nbapi` (v2 p. 2, repeated
  in the worked examples on pp. 177, 267 and 276). That is byte-for-byte the path
  `src/netboxClient.ts` already posts to, and the same path v1 documents. The NetBox Global variant,
  `/global/goforms/nbapi`, is out of scope for this project.
- **Same envelope.** Requests are `<NETBOX-API sessionid="…"><COMMAND name="…" num="…"><PARAMS>…`;
  responses are `<NETBOX …><RESPONSE command="…"><CODE>…</CODE><DETAILS>…</DETAILS></RESPONSE>`.
  Identical in both editions, and identical to what `src/xml.ts` builds and parses.
- **Same switch.** "Enable V2" on the controller's **Network Controller : Data Integration** page is
  what selects the v2 command set (v2 p. 2; restated inside the `GetPortalStatuses` section on
  p. 185). The README already requires that checkbox, so an existing deployment needs no change.
- **The End-of-Support notice does not affect this server.** v2 p. 1 states that NBAPI version 1 was
  deprecated from NetBox 5.6 (November 2022) and retired in NetBox 6.0. This server has only ever
  issued v2 commands against a v2-enabled controller (the reference controller runs NetBox 6.2.0),
  so the retirement is a non-event here. It is worth recording only because the v1 PDF is still in
  this directory and could otherwise be mistaken for a live reference.

The one wire-level difference worth knowing is not a protocol change at all: **v2's "boolean"
parameters are the literal strings `TRUE`/`FALSE`**, not XML booleans. `src/xml.ts` serialises
scalars with `String(value)`, so a JavaScript `true` would go out as `true` and be rejected. Every
doc-"boolean" parameter in this codebase is therefore a `z.enum(['TRUE','FALSE'])` string.

---

## Parameter-level diff, v1-2024 vs v2-2025

One row per command that this server implemented **before**
`specs/archive/nbapi-v2-full-conformance.md` — all 81, each appearing exactly once. Parameters were
extracted from each command's "Calling Parameters" bullet list in both PDFs and set-diffed.

The 24 commands added by that spec are omitted here for the obvious reason: every one of them is
v2-only, so there is no v1 edition to diff against. Their parameters are documented in
`src/tools/hardware.ts`, `src/tools/alarm.ts`, `src/tools/portal.ts` and `src/tools/person.ts`, and
pinned by the per-tool schema tests in `test/hardwareTools.test.ts`, `test/alarmTools.test.ts`,
`test/portalStateTools.test.ts` and `test/personV2Tools.test.ts`.

| Command | v1-2024 → v2-2025 |
| ------- | ----------------- |
| `ActivateOutput` | identical Calling Parameters (1 parameter) |
| `AddAccessLevel` | identical Calling Parameters (6 parameters) |
| `AddAccessLevelGroup` | identical Calling Parameters (6 parameters) |
| `AddCredential` | identical Calling Parameters (7 parameters). v2 appends a prose NOTE line to the list ("CARDSTATUS AND CARDEXPDATE ARE NOT SUPPORTED FOR THE NETBOX GLOBAL API"), which is not a parameter — see below |
| `AddHoliday` | identical Calling Parameters (4 parameters) |
| `AddPartition` | identical Calling Parameters (3 parameters) |
| `AddPerson` | **added in v2:** `AUTHTYPE`, `BLUEDIAMONDENABLED`, `MOBILEPHONE`, `MSUENABLED`, `PASSWORD`, `PERSONID`, `ROLE`, `USERNAME` |
| `AddPortalGroup` | identical Calling Parameters (5 parameters) |
| `AddReaderGroup` | identical Calling Parameters (3 parameters) |
| `AddThreatLevel` | identical Calling Parameters (3 parameters) |
| `AddThreatLevelGroup` | identical Calling Parameters (2 parameters) |
| `AddTimeSpec` | identical Calling Parameters (5 parameters) |
| `AddTimeSpecGroup` | **added in v2:** `TIMESPECKEY` |
| `DeactivateOutput` | identical Calling Parameters (1 parameter) |
| `DeleteAccessLevel` | identical Calling Parameters (1 parameter) |
| `DeleteAccessLevelGroup` | identical Calling Parameters (ACCESSLEVELGROUPKEY; v2 prints the bullet as a bare description line rather than a named bullet, but the parameter and the worked example are unchanged) |
| `DeleteHoliday` | identical Calling Parameters (1 parameter) |
| `DeletePortalGroup` | identical Calling Parameters (1 parameter) |
| `DeleteReaderGroup` | identical Calling Parameters (1 parameter) |
| `DeleteTimeSpec` | identical Calling Parameters (1 parameter) |
| `DeleteTimeSpecGroup` | identical Calling Parameters (1 parameter) |
| `DogOnNextExitPortal` | identical Calling Parameters (1 parameter) |
| `GetAccessHistory` | identical Calling Parameters (9 parameters) |
| `GetAccessLevel` | identical Calling Parameters (1 parameter) |
| `GetAccessLevelGroup` | identical Calling Parameters (1 parameter) |
| `GetAccessLevelGroups` | identical Calling Parameters (0 parameters) |
| `GetAccessLevelNames` | identical Calling Parameters (2 parameters) |
| `GetAccessLevels` | identical Calling Parameters (4 parameters) |
| `GetAPIVersion` | identical Calling Parameters (0 parameters) |
| `GetCardAccessDetails` | identical Calling Parameters (4 parameters) |
| `GetCardFormats` | identical Calling Parameters (0 parameters) |
| `GetElevators` | identical Calling Parameters (1 parameter) |
| `GetEventHistory` | identical Calling Parameters (4 parameters) |
| `GetFloors` | identical Calling Parameters (1 parameter) |
| `GetHoliday` | identical Calling Parameters (1 parameter) |
| `GetHolidays` | identical Calling Parameters (0 parameters) |
| `GetOutputs` | identical Calling Parameters (1 parameter) |
| `GetPartitions` | identical Calling Parameters (0 parameters) |
| `GetPerson` | **added in v2:** `AUTHTYPE`, `ROLE`, `USERNAME` |
| `GetPortalGroup` | identical Calling Parameters (1 parameter) |
| `GetPortalGroups` | identical Calling Parameters (1 parameter) |
| `GetPortals` | identical Calling Parameters (1 parameter) |
| `GetReader` | identical Calling Parameters (1 parameter) |
| `GetReaderGroup` | identical Calling Parameters (1 parameter) |
| `GetReaderGroups` | identical Calling Parameters (1 parameter) |
| `GetReaders` | identical Calling Parameters (1 parameter) |
| `GetThreatLevels` | **v2-only command** — not in the v1 guide at all. v2 Calling Parameters: `ALLPARTITIONS` |
| `GetTimeSpec` | identical Calling Parameters (1 parameter) |
| `GetTimeSpecGroup` | identical Calling Parameters (1 parameter) |
| `GetTimeSpecGroups` | identical Calling Parameters (1 parameter) |
| `GetTimeSpecs` | identical Calling Parameters (1 parameter) |
| `GetUDFListItems` | identical Calling Parameters (1 parameter) |
| `GetUDFLists` | identical Calling Parameters (0 parameters) |
| `InsertActivity` | identical Calling Parameters (9 parameters) |
| `ListEvents` | identical Calling Parameters (0 parameters) |
| `LockPortal` | identical Calling Parameters (1 parameter) |
| `Login` | identical Calling Parameters (2 parameters) |
| `Logout` | identical Calling Parameters (0 parameters) |
| `ModifyAccessLevel` | identical Calling Parameters (7 parameters) |
| `ModifyAccessLevelGroup` | identical Calling Parameters (v2 drops the nested `KEY` bullet from the ACCESSLEVELS block's own sub-list, but the block, its worked example and the wire shape are unchanged) |
| `ModifyCredential` | identical Calling Parameters (8 parameters). v2 appends a prose NOTE line to the list ("CARDSTATUS AND CARDEXPDATE ARE NOT SUPPORTED FOR THE NETBOX GLOBAL API"), which is not a parameter — see below |
| `ModifyHoliday` | identical Calling Parameters (5 parameters) |
| `ModifyPerson` | **added in v2:** `AUTHTYPE`, `BLUEDIAMONDENABLED`, `MOBILEPHONE`, `MSUENABLED`, `PASSWORD`, `ROLE`, `TRACE`, `TRACEMESSAGE`, `USERNAME` |
| `ModifyPortalGroup` | identical Calling Parameters (6 parameters) |
| `ModifyReaderGroup` | identical Calling Parameters (4 parameters) |
| `ModifyThreatLevel` | identical Calling Parameters (3 parameters) |
| `ModifyThreatLevelGroup` | identical Calling Parameters (3 parameters) |
| `ModifyTimeSpec` | identical Calling Parameters (6 parameters) |
| `ModifyTimeSpecGroup` | identical Calling Parameters (4 parameters) |
| `ModifyUDFListItems` | identical Calling Parameters (5 parameters) |
| `MomentaryUnlockPortal` | identical Calling Parameters (1 parameter) |
| `PingApp` | identical Calling Parameters (0 parameters) |
| `RemoveCredential` | identical Calling Parameters (5 parameters) |
| `RemovePerson` | identical Calling Parameters (1 parameter) |
| `RemoveThreatLevel` | identical Calling Parameters (1 parameter) |
| `RemoveThreatLevelGroup` | identical Calling Parameters (1 parameter) |
| `SearchPersonData` | **added in v2:** `BLUEDIAMONDENABLED`, `CARDFORMAT`, `CARDSTATUS`, `CONTACTEMAIL`, `MOBILEPHONE`, `MSUENABLED`, `NOTES`, `VEHICLELICNUM`, `VEHICLETAGNUM` |
| `SetThreatLevel` | **added in v2:** `LOCATIONKEYS` |
| `SwitchPartition` | identical Calling Parameters (1 parameter) |
| `TriggerEvent` | identical Calling Parameters (3 parameters) |
| `UnlockPortal` | identical Calling Parameters (1 parameter) |

### Notes on the nine commands whose parameters changed

- **`AddPerson` / `ModifyPerson`** — v2 adds the NetBox-login fields (`USERNAME`, `PASSWORD`,
  `ROLE`, `AUTHTYPE`), the mobile-credential flags (`MSUENABLED`, `BLUEDIAMONDENABLED`),
  `MOBILEPHONE`, and on `ModifyPerson` also `TRACE`/`TRACEMESSAGE`. `AddPerson` additionally accepts
  a caller-chosen `PERSONID`. All of these except `TRACE`/`TRACEMESSAGE` are modelled — see
  "Deliberately not modelled" below.
- **`SearchPersonData`** — v2 adds nine filters: `CARDFORMAT`, `CARDSTATUS`, `MSUENABLED`,
  `BLUEDIAMONDENABLED`, `CONTACTEMAIL`, `MOBILEPHONE`, `NOTES`, `VEHICLELICNUM`, `VEHICLETAGNUM`.
  All nine are modelled and all nine are now exercised against the live controller by
  `scripts/live-check.ts`. **Live finding:** `CARDSTATUS` is validated against the controller's
  configured card statuses — an invented value answers `FAIL` with
  `Card status does not exist: …`, so the live check reuses a status read off a real card.
- **`GetPerson`** — v2 adds `USERNAME`, `ROLE` and `AUTHTYPE` as alternative lookup keys. Not
  modelled; see below.
- **`SetThreatLevel`** — v2 adds `LOCATIONKEYS`, which scopes a threat-level change to specific
  locations instead of the whole partition. Modelled (issue #88), and exercisable live through the
  supervised `npx tsx scripts/live-check-write.ts --action set_threat_level_locations --value <name>`.
- **`GetThreatLevels`** — v2-only; there is no v1 edition of this command. Modelled (issue #61).
- **`AddTimeSpecGroup`** — v2 adds the `TIMESPECKEYS` wrapper and its `TIMESPECKEY` children, so a
  group's membership can be seeded at creation rather than filled in by a follow-up
  `ModifyTimeSpecGroup`. Modelled as `TIMESPECKEYS: string[]`, serialised through
  `wrapList('TIMESPECKEYS', 'TIMESPECKEY', …)`.
- **`AddCredential` / `ModifyCredential`** — **no real parameter change.** v2 appends a prose note to
  the Calling Parameters list ("NOTE: CARDSTATUS AND CARDEXPDATE ARE NOT SUPPORTED FOR THE NETBOX
  GLOBAL API"), which a naive bullet extraction reads as a parameter named `NOTE`. It is not one,
  and nothing was added to either tool. Recorded here so the next person diffing these PDFs does not
  chase it.
- **`DeleteAccessLevelGroup` / `ModifyAccessLevelGroup`** — no real parameter change either; v2 only
  re-typesets an existing bullet (`ACCESSLEVELGROUPKEY`, and the nested `KEY` inside the
  `ACCESSLEVELS` block). Both commands' worked examples are unchanged between editions.

### Deliberately not modelled

Every v2 parameter listed above that is **not** in the corresponding tool's zod schema, with the
reason:

| Command | Parameter(s) | Reason |
| ------- | ------------ | ------ |
| `GetPerson` | `USERNAME`, `ROLE`, `AUTHTYPE` | Alternative lookup keys for fetching *one* person. This server keeps a clean split: `get_person` is the by-`PERSONID` read, and `search_person_data` is the filtered search — and `search_person_data` already covers finding people by attribute. Adding three more identifiers to `get_person` would give it two mutually exclusive calling conventions with no error when both are supplied. Revisit if a caller actually needs a by-username lookup. |
| `GetPerson`, `AddPerson`, `ModifyPerson`, `AddAccessLevelGroup`, `ModifyAccessLevelGroup`, `GetAccessLevels`, `GetAccessLevelNames` | `PARTITIONKEY` (where the guide marks it "NetBox Global API Only") | NetBox Global is out of scope for this server (README Out-of-scope). Note this is only the *Global-only* occurrences: the plain-NetBox `PARTITIONKEY` filters on `GetAccessLevels` and `GetAccessLevelGroups` **are** modelled, and are live-verified by `scripts/live-check.ts`. |
| `ModifyPerson` | `TRACE`, `TRACEMESSAGE` | Turning on person tracing changes what the controller writes to the activity log for every badge read by that person — a monitoring-side-effect setting, not a person attribute. It has never been exercised against the reference controller, and a write tool that silently changes audit behaviour is the wrong default. Out of scope; file an issue if it is wanted. |
| `AddPerson`, `ModifyPerson` | `PICTURE`, `PICTUREEXT`, `PICTUREURL` | Photo *upload* is out of scope (see below and the README). `get_picture` covers the read direction. |

No other parameter documented in v2 for a pre-existing command is missing from its tool's schema.

---

## Data Operations

`Data_Operations.pdf` describes a **web-UI and NAS feature with no API of its own**. There is nothing
to wrap, and **no Data Operations tooling was built**.

What the guide actually describes:

- **Import** — a CSV or TSV file is either uploaded by hand on **Administration : Data Operations**,
  or dropped into a pre-configured **NAS location** that Data Operations polls on a user-defined
  schedule.
- **Export** — an export file is produced on that same page and downloaded from it, or written to a
  NAS location for another system (e.g. NetBox Global's Central Data Manager) to collect.
- **Import-file format** — each data row begins with an "API command" (`AddPerson`, `ModifyPerson`,
  …) followed by person-record columns. This is the one place the guide uses the word "API", and it
  is a *column value inside a CSV*, not an HTTP call. Nothing about it is reachable over
  `/nbws/goforms/nbapi`.
- **Photos** — the guide is explicit that Data Operations can upload pictures only from a NAS
  storage location, reinforcing that the file-transfer half of this feature is filesystem-based.

Consequently there is no import-file builder, no export parser and no NAS/upload automation in this
server, and none is planned. The finding is recorded here so the question is not reopened; the
README's Out-of-scope list carries a one-line version.

---

## Footnotes

1. **Excluded as PDF artefacts.** Three strings that look like command headings are not commands and
   are not rows in the table above:
   - `GetAddPartition` — the mis-typeset heading of the `AddPartition` section (v2 p. 88). Counted
     once, as `AddPartition`.
   - `Enabled` — a field heading inside the Intrusion Panel Integration "Definitions" section
     (v2 pp. 56–66), not a Command Reference heading.
   - `LoginResponse` — likewise an Intrusion Panel Integration definition (v2 p. 62), describing the
     REST login response object. Distinct from the `Login` command, which is a real Command
     Reference section (v2 p. 218) and is a row above.
2. **Intrusion Panel Integration.** v2 pp. 25–66 document a *REST* API for intrusion panels, with
   JSON bodies and its own endpoints. It is not part of the XML NBAPI command set, is not in the
   Command Reference, and is out of scope for this server; none of its operations appear in the
   table above.
3. **`StreamEvents`.** Documented in both editions (v1 p. 191, v2 p. 270) and implemented in
   neither. It holds a long-lived HTTP connection open and pushes event XML as it happens, which
   does not map onto a request/response MCP tool. `list_events` plus `get_event_history` cover the
   polling equivalent.
