# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Daily recurring unlock window: `schedule_daily_unlock_window`, `cancel_daily_unlock_window`,
  and `get_daily_unlock_window` express "unlock these doors from *dailyStartTime* to
  *dailyEndTime*, every day from *startDate* through *endDate*" as a single managed window —
  which the existing `schedule_unlock_window` cannot express without keeping doors unlocked
  overnight on days strictly between the first and last. Reuses the continuous feature's
  holiday + time spec + portal group mechanism with a single, always-one-segment plan (no
  first/middle/last splitting), a dedicated reserved holiday group
  (`NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP`, default `5`, validated at startup to never collide with
  `NETBOX_UNLOCK_HOLIDAY_GROUPS`) and its own name prefix (`NETBOX_DAILY_UNLOCK_NAME_PREFIX`,
  default `MCP Daily Unlock Window`), so the two features may be scheduled and active at the same
  time. Adds `scripts/live-check-write-daily.ts` (`npm run test:live:write:daily`), the daily
  window's opt-in live write smoke test, mirroring `npm run test:live:write`'s CRUD round-trips,
  clock-skew gate, and `--go` door-unlock phase under its own `MCP livecheck daily` prefix.
  (See the GitHub issue and PR that introduce this feature, opened per this repo's issue-first
  workflow.)

## [0.1.1] — 2026-09-15

### Added
- `LICENSE` (MIT), matching every other licensed repo under this account
  ([#19](https://github.com/J-MaFf/s2-netbox-mcp/issues/19),
  [#20](https://github.com/J-MaFf/s2-netbox-mcp/pull/20)).

### Changed
- Redacted the local Windows username from `specs/archive/*.md` (repo-convention notes and a
  local PDF path carried over from planning) ahead of making the repo public
  ([#19](https://github.com/J-MaFf/s2-netbox-mcp/issues/19),
  [#20](https://github.com/J-MaFf/s2-netbox-mcp/pull/20)).

## [0.1.0] — 2026-09-15

First public release. Everything below shipped incrementally on `main` before any version was
tagged, so it is consolidated here as one release rather than split across the untagged
`0.1.0`/`0.2.0`/`0.3.0` milestones it was originally drafted under.

### Added
- Initial read-only S2 NetBox MCP server: 15 tools covering persons/credentials, access levels,
  portals/readers, and event/access history, backed by a session-login NBAPI client with
  retry-once-on-expired-session handling, a closed 17-command allowlist, and a mocked-HTTP unit
  test suite ([#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2),
  [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3)).
- `NETBOX_API_PATH` environment variable, defaulting to the verified NetBox 6.x NBAPI path
  `/nbws/goforms/nbapi`; a non-empty override is honoured verbatim (with a leading `/` added if
  missing) — the documented `/goforms/nbapi` remains available as an explicit pre-6.x override
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- A "Controller prerequisites" section in `README.md` documenting the *Data Integration* tab
  checkboxes required for session-login auth, plus troubleshooting entries for "Login succeeds
  but every other command returns APIERROR 5" and "HTTP 410 Gone"
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- `find_portals` tool, which finds doors by location or name. Portal names are site codes, so it
  also searches each portal's reader names and reader descriptions (joined in from `GetReaders` by
  `READERKEY`). Every whitespace-separated term must match, case-insensitively. It reads all pages
  of `GetPortals`/`GetReaders`, adds no NBAPI commands, and lists portals whose readers have no
  description ([#6](https://github.com/J-MaFf/s2-netbox-mcp/issues/6),
  [#7](https://github.com/J-MaFf/s2-netbox-mcp/pull/7)).
- 18 new read tools covering time specs, holidays, portal groups, reader groups, outputs, access
  level names, partitions, UDF lists, elevators, floors, and `PingApp` — the `NBAPI_COMMANDS`
  allowlist grows from 17 to 80 commands in support of these plus the write tools below
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- 45 write tools, gated behind the new `NETBOX_ENABLE_WRITES` environment variable (unset by
  default, so the server stays read-only unless explicitly opted in): portal/output actions
  (`lock_portal`, `unlock_portal`, `momentary_unlock_portal`, `dog_on_next_exit_portal`,
  `activate_output`, `deactivate_output`); time specs and time spec groups; holidays; portal
  groups; reader groups; access levels and access level groups; persons and credentials
  (`add_person`, `modify_person`, `add_credential`, `modify_credential`); threat levels and threat
  level groups; `trigger_event`/`insert_activity`; and partitions/UDF list items
  (`add_partition`, `switch_partition`, `modify_udf_list_items`). A further `NETBOX_ENABLE_DESTRUCTIVE`
  variable, required in addition to `NETBOX_ENABLE_WRITES`, gates 11 destructive tools
  (`delete_access_level`, `delete_access_level_group`, `delete_holiday`, `delete_portal_group`,
  `delete_reader_group`, `delete_time_spec`, `delete_time_spec_group`, `remove_credential`,
  `remove_person`, `remove_threat_level`, `remove_threat_level_group`); `modify_person` and
  `modify_udf_list_items` independently refuse a destructive-shaped call (person deletion/purge, a
  `DELETE="1"` list item) when that flag is off. Every write tool's description is
  `WRITE:`/`DESTRUCTIVE:`-prefixed and every success result contains `SUCCESS` plus the
  controller's response data ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- `NETBOX_EVENT_API_PATH` environment variable, so `trigger_event` can be routed to a separate
  Event API path (e.g. the pre-6.x documented `/appd/nbapi`) independently of `NETBOX_API_PATH`
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- Nested `PARAMS` support in `buildParamsXml` (objects and arrays, to any depth), needed for the
  wire shapes the write commands document — e.g. `PORTALKEYS: { PORTALKEY: [...] }` and repeated
  top-level `PORTALKEY` siblings on `ModifyPortalGroup` ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- `NETBOX_UNLOCK_HOLIDAY_GROUPS`, `NETBOX_UNLOCK_NAME_PREFIX`, and `NETBOX_LIVE_TEST_PORTALKEY`
  environment variables, validated by `loadConfigFromEnv`, for the managed unlock-window feature
  and its live write check below ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- `set_portals_state` composite write tool: locks, unlocks (Extended Unlock), or momentarily
  unlocks the given portals — or every portal from a fully paginated `GetPortals` — issuing one
  command per portal sequentially, never aborting on a single failure, and partitioning the result
  into `succeeded`, `alreadyInState` ("Portal state not changed"), and `failed`; the result is an
  error only when `failed` is non-empty ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- Managed unlock windows: `schedule_unlock_window` (write) turns "unlock these doors from *start*
  to *end*" into a Holiday + no-weekday Time Spec + Portal Group that the controller enforces
  itself — the same objects an operator builds by hand — split into up to three segments
  (`first`/`middle`/`last`, one reserved holiday group each) by a pure planner. It validates the
  window (real date-times, `end` after `start` and in the future, at most 31 days, known portal
  keys, the 30-holiday cap), reports the time specs the window's holidays would suppress and the
  non-managed holidays it overlaps, refuses without `acknowledgeSideEffects=true` when anything
  would be suppressed, supports `dryRun`, applies in a fixed eight-step order, reads everything
  back against the plan (`verified: true`), and is idempotent. `cancel_unlock_window` (write)
  points the managed portal group at `Never`, deletes the managed holidays, and best-effort
  empties the managed time spec group and deletes the managed time specs (refusals are reported
  under `leftBehind`). `get_unlock_window` (read, always registered) reports the managed objects,
  the derived window, and `activeNow`. All three identify managed objects by exact name under
  `NETBOX_UNLOCK_NAME_PREFIX` and never modify or delete anything else; time spec group
  membership is read from paginated `GetTimeSpecGroups` because `GetTimeSpecGroup` fails on the
  verified 6.2.0 controller ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- `scripts/live-check-write.ts` / `npm run test:live:write`: an opt-in live write smoke test that
  skips cleanly unless the credentials, `NETBOX_ENABLE_WRITES=true`, and
  `NETBOX_LIVE_TEST_PORTALKEY` are set; round-trips add/get/modify/get/delete for a time spec, time
  spec group, holiday, reader group, and portal group under the `MCP livecheck` prefix; and, only
  with `--go` (after the user has been notified of the exact times), schedules, observes, and
  cancels a real 2-minute unlock of the designated portal, always cancelling before exiting on a
  failure ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- Extended `npm run test:live:write` (the live write smoke test) with round-trips for a person and
  a credential on that person, an access level and an access level group, a threat level and a
  threat level group, `InsertActivity`, a UDF list item, and `SwitchPartition` back to the
  session's own partition — all under the existing `MCP livecheck` prefix, cleaned up on every run.
  `SetThreatLevel`, `AddPartition`, `PERSONPURGE`, and `TriggerEvent` are still never used
  ([#13](https://github.com/J-MaFf/s2-netbox-mcp/issues/13)).
- Two supervised single actions, `trigger_event_activate` and `trigger_event_deactivate`
  (`npm run test:live:write -- --action trigger_event_activate --value <EVENTNAME>`), the only
  live verification path for `TriggerEvent` — the target event must already exist in the NetBox
  UI ([#12](https://github.com/J-MaFf/s2-netbox-mcp/issues/12)).

### Changed
- `scripts/live-check.ts` now exercises all 34 read tools (16 pre-existing + the 18 added above);
  verified 34/34 PASS against the live NetBox 6.2.0 controller, issuing no write command
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- README's "read-only"/"structurally incapable" framing is replaced by a "Write access" section
  describing the two gates and the destructive tier; the tools table is split into read tools and
  write tools; the AD-sync caution moves next to the person/credential tools
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- The `find_portals` NEXTKEY paging loop moved to `src/paging.ts` and is shared by every
  composite tool (`GetPortals`, `GetTimeSpecs`, `GetTimeSpecGroups`, `GetPortalGroups`,
  `GetHolidays`); it can optionally treat the 6.2.0 controller's bare `FAIL`/`NOT FOUND` on an
  unconfigured collection as an empty list ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- `NetboxClient` now merges any RESPONSE-level fields (the doc's `AddTimeSpecGroup` example puts
  `TIMESPECGROUPKEY` directly under `RESPONSE`) into the returned data, with `DETAILS` taking
  precedence ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- README gains a "Scheduled unlock windows" section, lists all five composite tools in place of
  "the one composite tool", adds the composites to the read/write tool tables, and documents
  `npm run test:live:write`; `.env.example` and `STATUS.md` reflect the completed feature
  ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).

### Fixed
- Non-2xx HTTP responses now surface the status code and request path in the tool error; a 410
  specifically names `NETBOX_API_PATH` as the thing to check, instead of a generic HTTP error
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- When a re-login succeeds but the retried command still returns `APIERROR 5`, the tool error now
  names the "Use login username/password for authentication" checkbox — the live-observed symptom
  of the controller being configured for MAC auth instead of session login
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- Removed the undocumented `extraParams` passthrough field from `search_person_data`,
  `get_event_history`, and `get_access_history`'s input schemas; each tool now declares only the
  field names documented in the NBAPI Command Reference, per the read-only server's "no invented
  field names" requirement ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- `npm run test:live` now treats `GetAccessLevelGroups`/`GetAccessLevelGroup` returning
  `CODE=FAIL, ERRMSG="NOT FOUND"` as an accepted no-data outcome rather than a failure — observed
  live against a real controller with zero Access Level Groups configured; the underlying NBAPI
  client's error handling is unchanged ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- The managed time spec group is named `"<prefix> time specs"`, not `"<prefix>"` — group names
  are unique across group types on the verified 6.2.0 controller, so a portal group and a time
  spec group cannot share a name ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- `ModifyPortalGroup`/`ModifyReaderGroup` replace the group's entire membership rather than
  appending, so `schedule_unlock_window`/`cancel_unlock_window` always send the full portal key
  list on every modify, not just the delta ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- `npm run test:live:write`'s door phase now measures controller clock skew against the host
  clock and refuses to proceed when it exceeds 2 minutes, instead of scheduling a window whose
  `start`/`end` were computed against the wrong clock — live-observed on a controller whose clock
  was off by ~4h35m ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
- Documented that `ENDTIME` is inclusive through the end of the stated minute (the built-in
  `Always` time spec covers `00:00`–`23:59`), so a multi-day unlock window has no midnight gap
  between segments; the door instead relocks up to 59 seconds after the stated `end` minute
  (observed live: a window ending `08:27` relocked at `08:27:59` controller time) — the README
  previously described an up-to-60-second relock gap at each midnight, which was wrong
  ([#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9)).
