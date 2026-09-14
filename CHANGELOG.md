# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

## [0.1.0] — 2026-09-14
### Added
- Initial read-only S2 NetBox MCP server: 15 tools covering persons/credentials, access levels,
  portals/readers, and event/access history, backed by a session-login NBAPI client with
  retry-once-on-expired-session handling, a closed 17-command allowlist, and a mocked-HTTP unit
  test suite ([#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2),
  [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3)).
