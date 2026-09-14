# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] — 2026-09-14
### Added
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
  environment variables, validated by `loadConfigFromEnv` and reserved for the managed
  unlock-window feature landing in a follow-up release
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).

### Changed
- `scripts/live-check.ts` now exercises all 34 read tools (16 pre-existing + the 18 added above);
  verified 34/34 PASS against the live NetBox 6.2.0 controller, issuing no write command
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).
- README's "read-only"/"structurally incapable" framing is replaced by a "Write access" section
  describing the two gates and the destructive tier; the tools table is split into read tools and
  write tools; the AD-sync caution moves next to the person/credential tools
  ([#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8)).

## [0.2.0] — 2026-09-14
### Added
- `NETBOX_API_PATH` environment variable, defaulting to the verified NetBox 6.x NBAPI path
  `/nbws/goforms/nbapi`; a non-empty override is honoured verbatim (with a leading `/` added if
  missing) — the documented `/goforms/nbapi` remains available as an explicit pre-6.x override
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).
- A "Controller prerequisites" section in `README.md` documenting the *Data Integration* tab
  checkboxes required for session-login auth, plus troubleshooting entries for "Login succeeds
  but every other command returns APIERROR 5" and "HTTP 410 Gone"
  ([#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4)).

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

## [0.1.0] — 2026-09-14
### Added
- Initial read-only S2 NetBox MCP server: 15 tools covering persons/credentials, access levels,
  portals/readers, and event/access history, backed by a session-login NBAPI client with
  retry-once-on-expired-session handling, a closed 17-command allowlist, and a mocked-HTTP unit
  test suite ([#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2),
  [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3)).
