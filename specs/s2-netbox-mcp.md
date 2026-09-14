# Spec: S2 NetBox MCP Server (Read-Only)

## Goal
Build a local MCP server that exposes read-only S2 NetBox NBAPI operations (persons/credentials, access levels, portals/readers, events/history) as Claude-callable tools, so NetBox data can be queried conversationally instead of hand-built XML/HTTP calls.

## Context
- The target system is LenelS2's **S2 NetBox** physical access-control appliance — not the unrelated open-source "NetBox" DCIM/IPAM tool (netboxlabs.com), which already has its own MCP server that has nothing to do with this project.
- Its integration surface is the **NBAPI**: XML-over-HTTP, documented in "Web-Based API for S2 NetBox and S2 Global" (LenelS2, February 2020, doc #API-UG-14; current with S2 NetBox Release 5.0 / S2 Global 2.0.12). The Overview, Calling the API, Authentication, and full Command Reference table of contents were reviewed directly from the official PDF for this spec.
- Verified (checked the official PDF): request/response structure, endpoint paths, both auth modes, XML uppercase-*element*-tag requirement (attribute values like `sessionid=`/`name=`/`num=`/`dateformat=` stay lowercase, per the documented examples — the doc's "all XML tags must be uppercase" note refers to element names, not attributes), error model (`APIERROR` vs `CODE`/`FAIL`/`ERRMSG`/`NOT FOUND`), and the full list of ~90 documented commands with page numbers.
- Verified (checked the official PDF's Command Reference section directly, in detail, for every command this spec uses): exact PARAMS and response field names for `Login`, `Logout`, `GetAPIVersion`, `GetPerson`, `SearchPersonData`, `GetCardAccessDetails`, `GetCardFormats`, `GetAccessLevel(s)`, `GetAccessLevelGroup(s)`, `GetPortals`, `GetReader(s)`, `GetEventHistory`, `ListEvents`, `GetAccessHistory`. Notably: **there is no command named `GetPortal` (singular)** — only `GetPortals` exists, and its only parameter is `STARTFROMKEY` (pagination cursor); it cannot be filtered to a single portal. `GetReader` (singular) does exist and takes a required `READERKEY`. The PDF is saved locally at `C:\Users\jmaffiola\.claude\projects\C--Users-jmaffiola-Documents-Tasks\9b02c63b-5b70-42ba-8ef1-bd9e89371a6e\tool-results\webfetch-1789396815900-v6cg0d.pdf` (an image-rendered PDF; printed page label + 5 = the Read tool's page index, verified stable through the whole Command Reference section) for anyone who needs to re-check a field name against the primary source.
- Verified (web search, 2026-09-14): no existing MCP server wraps the S2 NetBox NBAPI. This is a from-scratch build.
- Endpoint used by every command in scope: `http(s)://<host>[:port]/goforms/nbapi`. (The `/appd/nbapi` and `/appdevent/nbapi/event` endpoints are for event triggering and event streaming, both out of scope for v1 — see below.)
- Auth: v1 targets **session-login authentication only** — `Login` with username/password returns a `sessionid`, reused via `<NETBOX-API sessionid="...">` on every subsequent call, released via `Logout`. The documented MAC-authentication alternative (a `<MAC>` HMAC-style element, no login step) is out of scope for v1: the user's live test controller uses session login, and NetBox's *Data Integration* config only allows one mode at a time.
- User has a live S2 NetBox controller available for manual/integration testing, reachable from the machine that will run this server, configured for session-login auth. Host/username/password are supplied at runtime via environment variables — never given to or stored by an agent, never committed.
- Repo convention on this machine: personal tooling repos live one-per-folder under `C:\Users\jmaffiola\Documents\Scripts\<name>` (e.g. `homelab`, `PowerShellScripts`, `clickup_api`), each an independent git repo with its own `CLAUDE.md`. This project's deliverable is a new repo at `C:\Users\jmaffiola\Documents\Scripts\s2-netbox-mcp` (this spec file already lives at `specs/s2-netbox-mcp.md` inside that path).
- The global `CLAUDE.md` (`C:\Users\jmaffiola\.claude\CLAUDE.md`) secrets-hygiene rule applies: no API keys/passwords/tokens/internal identifiers in any tracked file. Its git-policies (issue-first workflow, branch naming, signed commits, PR conventions, squash & merge) apply once implementation starts creating the repo/branches/PRs — that happens in the forge/build step, not in this spec.
- Important operational note carried from the NBAPI doc: if this or any NetBox instance syncs person/access-level data from Active Directory, NBAPI writes to those fields get silently overwritten on the next AD sync. Not directly relevant to a read-only server, but worth carrying into the README as a caution for anyone later adding write tools.

## Deliverable
A new project directory at `C:\Users\jmaffiola\Documents\Scripts\s2-netbox-mcp\` containing:
- `package.json`, `tsconfig.json` — Node/TypeScript project using `@modelcontextprotocol/sdk` (stdio transport)
- `src/index.ts` — MCP server entrypoint; registers all tools and handles startup/shutdown
- `src/netboxClient.ts` — NBAPI XML request/response client: session login/logout, XML building/parsing, error mapping, retry-once-on-expired-session logic
- `src/tools/person.ts`, `src/tools/accessLevel.ts`, `src/tools/portal.ts`, `src/tools/events.ts` — one module per tool category from the list in Requirements
- `.env.example` — documents required/optional environment variables with placeholder values only
- `.gitignore` — excludes `node_modules`, `.env`, `dist`
- `README.md` — setup steps, environment variable reference, and the exact Claude Code MCP server config JSON snippet needed to register this server
- `test/` — automated unit tests against a mocked HTTP layer (no live controller needed to run `npm test`)

## Requirements

### Transport & protocol
- R1. The server implements the MCP stdio transport via `@modelcontextprotocol/sdk` and starts cleanly with `node dist/index.js` (or `npm start`), no CLI arguments required. [verify: run the command, confirm the process starts and stays alive without throwing, and responds to an MCP `list_tools` request]
- R2. Every NBAPI request is built as XML matching the documented `<NETBOX-API sessionid="..."><COMMAND name="..." num="1"><PARAMS>...</PARAMS></COMMAND></NETBOX-API>` structure verbatim: every XML *element* name (`NETBOX-API`, `COMMAND`, `PARAMS`, and per-field element names like `PERSONID`) is uppercase, while attribute *values* (`sessionid="..."`, `name="..."`, `num="1"`, `dateformat="..."`) stay lowercase exactly as documented — do not uppercase attribute names or values. [verify: capture the outgoing request for one tool call and diff it against this documented structure, including attribute casing]
- R3. The NetBox base URL, credentials, and TLS behavior are read from environment variables (`NETBOX_BASE_URL`, `NETBOX_USERNAME`, `NETBOX_PASSWORD`, optional `NETBOX_ALLOW_INSECURE_TLS` for self-signed on-prem certs) at startup; if `NETBOX_BASE_URL`, `NETBOX_USERNAME`, or `NETBOX_PASSWORD` is missing, the server exits with a one-line actionable error, not a stack trace. [verify: start the server with one required var unset and confirm the error message and non-zero exit code]

### Session management
- R4. On the first tool call, the client sends `Login` with the configured credentials, caches the returned `sessionid`, and reuses it on subsequent calls rather than re-authenticating every time. [verify: with request logging on, make two sequential tool calls in one server run and confirm exactly one `Login` request was sent]
- R5. If a call fails with `APIERROR` 5 (authentication failure) or an equivalent session-expired signal, the client transparently re-logs-in once and retries the original command before surfacing anything to the caller. [verify: in a test, force an invalid/expired sessionid and confirm the client re-authenticates once and the original tool call still succeeds]
- R6. On process shutdown (SIGINT/SIGTERM), the client sends `Logout` for any active session before the process exits. [verify: start the server, make one tool call, send SIGINT, confirm a `Logout` request was sent before exit]

### Error handling
- R7. An NBAPI-level failure (an `<APIERROR>` element in the response) is surfaced as an MCP tool error whose message includes both the numeric code and its documented meaning (e.g. "2: The API is not enabled on the system"). [verify: simulate each of the six documented APIERROR codes in a test and confirm each maps to its documented text in the tool error]
- R8. A command-level failure (`<CODE>FAIL</CODE>`) is surfaced as an MCP tool error that includes the `ERRMSG` text when the response provides one. [verify: simulate a FAIL response with an ERRMSG in a test and confirm it appears verbatim in the tool error]
- R9. A `<CODE>NOT FOUND</CODE>` response (e.g. querying a person ID that doesn't exist) is returned as a normal, non-error MCP tool result stating "not found," not thrown as an exception. [verify: call `get_person` with a PERSONID that doesn't exist, against the live controller or a mocked NOT FOUND response, and confirm the tool returns a normal result rather than an error]

### Read-only enforcement
- R10. The only NBAPI commands the server is capable of issuing, anywhere in the source, are: `Login`, `Logout`, `GetAPIVersion`, `GetPerson`, `SearchPersonData`, `GetCardAccessDetails`, `GetCardFormats`, `GetAccessLevel`, `GetAccessLevels`, `GetAccessLevelGroup`, `GetAccessLevelGroups`, `GetPortals`, `GetReader`, `GetReaders`, `GetEventHistory`, `ListEvents`, `GetAccessHistory` (17 total; note there is no `GetPortal` singular command — only `GetPortals` exists, see Context). No command that adds, modifies, deletes, removes, activates/deactivates, locks/unlocks, sets, or triggers anything (e.g. `AddPerson`, `ModifyAccessLevel`, `UnlockPortal`, `SetThreatLevel`, `TriggerEvent`) is implemented or reachable through any tool. [verify: grep the source tree for NBAPI command-name string literals passed as the `name` attribute of a `COMMAND` element and confirm the set matches this list exactly]

### Tools exposed
One MCP tool per NBAPI command below (15 user-facing tools; `Login`/`Logout` are internal to the client, not separate tools), each a thin pass-through of that command's documented parameters and response fields:
- R11. `check_connection` (wraps `GetAPIVersion`) returns the NBAPI version string and confirms authentication succeeded. [verify: call it against the live test controller and confirm a version string is returned]
- R12. `get_person` (`GetPerson`) returns the full person record for a given `PERSONID`. [verify: call against the live controller with a known valid PERSONID and confirm returned fields match the NetBox UI for that person]
- R13. `search_person_data` (`SearchPersonData`) returns matching person records for the documented search criteria. [verify: call with a known partial last name against the live controller and confirm the expected person is in the results]
- R14. `get_card_access_details` and `get_card_formats` (`GetCardAccessDetails`, `GetCardFormats`) return credential and card-format data per the documented response shape. [verify: call each against the live controller and confirm the response includes the documented fields, e.g. configured card format names]
- R15. `get_access_level`, `get_access_levels`, `get_access_level_group`, `get_access_level_groups` return access level and access level group data. [verify: call `get_access_levels` against the live controller and confirm the returned list matches what's configured in the NetBox UI]
- R16. `get_portals` (`GetPortals`, paginated via `STARTFROMKEY`/`NEXTKEY`, no single-portal filter — returns portals each with their nested readers), `get_reader` (`GetReader`, required `READERKEY`), `get_readers` (`GetReaders`) return portal/door and reader configuration data. [verify: call `get_portals` against the live controller and confirm returned portal names match the NetBox UI]
- R17. `get_event_history`, `list_events`, `get_access_history` return historical event and access data for the documented filter parameters (e.g. date range, person). [verify: call `get_event_history` with a recent date range against the live controller and confirm returned events match the NetBox UI's event log for that window]
- R18. Every tool's registered MCP input schema documents each parameter's name, type, and required/optional status, using exactly the field names given in the "Command reference (verified against the primary source)" section below — no invented, renamed, or guessed field names. [verify: read each tool registration and cross-check its declared parameters against that section's list for the corresponding command]

### Command reference (verified against the primary source — authoritative, use these exact field names)
Field names below are copied from the official NBAPI Command Reference (see Context). A tool's PARAMS must use exactly these element names inside `<PARAMS>`; response parsing must expect exactly these DETAILS field names. Do not invent, rename, or guess a field name not listed here.

- **Login** — PARAMS: `USERNAME` (required), `PASSWORD` (required). On SUCCESS there is no sessionid field inside the response body — the session id is the `sessionid` *attribute* on the outer `<NETBOX>` response element itself, to be reused as the `sessionid` attribute on every subsequent `<NETBOX-API>` call. On FAIL: `APIERROR` 5.
- **Logout** — PARAMS: none. Response: `CODE` only.
- **GetAPIVersion** — PARAMS: none. Response: `APIVERSION`.
- **GetPerson** — PARAMS: `PERSONID` (required), `ALLPARTITIONS` (optional), `ACCESSLEVELDETAILS` (optional), `WANTCREDENTIALID` (optional). Response: `PERSONID`, `FIRSTNAME`, `LASTNAME`, `MIDDLENAME`, `EXPDATE`, `ACTDATE`, `NOTES`, `UDF1`–`UDF20`, `DELETED`, `ACCESSLEVELS` (list of `ACCESSLEVEL`), `ACCESSCARDS` (list of `ACCESSCARD`: `ENCODEDNUM`, `HOTSTAMP`, `CREDENTIALID`, `CARDFORMAT`, `DISABLED`, `CARDSTATUS`, `CARDEXPDATE`), `PICTUREURL`.
- **SearchPersonData** — PARAMS (all optional filters; omit all to return every record): `PERSONID`, `LASTNAME`, `FIRSTNAME`, `MIDDLENAME`, `UDF1`–`UDF20`, `HOTSTAMP`, `WANTCREDENTIALID`, `ACCESSLEVEL`, `OLDESTLASTMOD`, `NEWESTLASTMOD`, `DELETED` (`ALL`/`TRUE`/`FALSE`), `ALLPARTITIONS`, `CASEINSENSITIVE`, `WILDCARDSEARCH`, `ACCESSLEVELDETAILS`, `RAWCARDNUMBER`. Response: `PEOPLE` (list of `PERSON`, same shape as GetPerson plus `PIN`/`LASTEDIT`/contact fields/`VEHICLES`), `NEXTKEY`.
- **GetCardAccessDetails** — PARAMS: `ENCODEDNUM` (required), `CARDFORMAT` (required), `MAXRECORDS` (optional), `OLDESTDTTM` (optional). Response: `PersonID`, `Disabled`, `expdate`, `Accesses` (list of `Access`: `DTTM`, `NODEDTTM`, `TYPE`, `PORTALNAME`, `REASON`, `PORTALKEY`, `READERKEY`, `LOGID`), `NEXTLOGID`.
- **GetCardFormats** — PARAMS: none. Response: `CARDFORMATS` (list of `CARDFORMAT`).
- **GetAccessLevel** — PARAMS: `ACCESSLEVELKEY` (required). Response: `ACCESSLEVELNAME`, `ACCESSLEVELDESCRIPTION`, `READERGROUPKEY`, `TIMESPECGROUPKEY`, `THREATLEVELGROUPKEY`.
- **GetAccessLevels** — PARAMS: `STARTFROMKEY` (optional), `STARTFROMNAME` (optional), `WANTKEY` (optional). Response: `ACCESSLEVELS` (list of `ACCESSLEVEL`), `NEXTKEY`, `NEXTNAME`.
- **GetAccessLevelGroup** — PARAMS: `ACCESSLEVELGROUPKEY` (required). Response: `ACCESSLEVELGROUPKEY`, `NAME`, `DESCRIPTION`, `ACCESSLEVELS` (list of `ACCESSLEVEL`: `KEY`, `NAME`).
- **GetAccessLevelGroups** — PARAMS: `STARTFROMKEY` (optional). Response: `ACCESSLEVELGROUPS` (list of `ACCESSLEVELGROUP`: `KEY`, `NAME`), `NEXTKEY`, `NEXTNAME`.
- **GetPortals** — PARAMS: `STARTFROMKEY` (optional pagination cursor) — this is the *only* parameter; there is no single-portal filter. Response: `PORTALS` (list of `PORTAL`: `NAME`, `PORTALKEY`, `READERS` (list of `READER`: `READERKEY`, `NAME`, `DESCRIPTION`, `PORTALORDER`)), `NEXTKEY`.
- **GetReader** — PARAMS: `READERKEY` (required). Response: `READER` (`READERKEY`, `NAME`, `DESCRIPTION`).
- **GetReaders** — PARAMS: `STARTFROMKEY` (optional) — no portal-id or other filter. Response: `READERS` (list of `READER`: `READERKEY`, `NAME`, `DESCRIPTION`).
- **GetEventHistory** — PARAMS: `EVENTNAME` (optional), `STARTDTTM` (optional), `ENDDTTM` (optional), `NEXTKEY` (optional, pagination continuation). Response: CSV-formatted event list (`LogID`, `Time`, `EventName`, `Type`, `Reason`), `NEXTKEY`.
- **ListEvents** — PARAMS: none. Response: `EVENTS` (list of `EVENT`: `NAME`, `PARTITIONID`, `ACTIONS`).
- **GetAccessHistory** — PARAMS (all optional): `STARTLOGID`, `AFTERLOGID`, `ORDER`, `MAXRECORDS`, `ENCODEDNUM`, `HOTSTAMP`, `CARDFORMAT`, `OLDESTDTTM`, `NEWESTDTTM`. Response: `ACCESSES` (list of `ACCESS`: `LOGID`, `PERSONID`, `READER`, `DTTM`, `NODEDTTM`, `TYPE`, `REASON`, `READERKEY`, `PORTALKEY`), `NEXTLOGID`.

### Secrets & logging
- R19. No log line, error message, or test fixture ever contains the literal value of `NETBOX_PASSWORD`. [verify: grep all source and test files for the password env var and confirm it only ever flows into the login request body, never into a log/console/error statement]

## Out of scope
- Any write/control command, including but not limited to: `AddPerson`, `ModifyPerson`, `RemovePerson`, `Add/Modify/DeleteAccessLevel(Group)`, `LockPortal`, `UnlockPortal`, `MomentaryUnlockPortal`, `Activate/DeactivateOutput`, `Set/Add/Modify/RemoveThreatLevel(Group)`, `TriggerEvent`, `Add/Modify/DeleteHoliday`, `Add/Modify/DeleteTimeSpec(Group)`, `Add/Modify/RemoveCredential`, `AddPartition`, `SwitchPartition`, `InsertActivity`, `ModifyUDFListItems`.
- Photo ID handling (`GetPicture` and photo upload) — separate binary/Base64 concern, deferred.
- `StreamEvents` and the `/appdevent/nbapi/event` push feed — architecturally a persistent connection rather than request/response; deferred to a future version.
- MAC-based authentication — session-login only for v1.
- S2 Global's API variant — this spec targets S2 NetBox only.
- Any GUI, dashboard, or interface beyond the MCP tool surface.
- Publishing/packaging the server (e.g. to npm) — local use only for now.
- CI/CD pipeline setup.
- Creating the git repo, GitHub issue, branches, or PRs — that happens in the build/forge step under this user's git-policies, not in this spec.

## Constraints
- Language/runtime: TypeScript on Node.js, using `@modelcontextprotocol/sdk`.
- Transport: stdio (how Claude Code registers local MCP servers).
- No secrets committed to the repo; `.env` is gitignored; `.env.example` contains placeholders only.
- Must run on Windows 11 natively, without requiring WSL.
- Must follow this user's global `CLAUDE.md` secrets-hygiene and injection-defense rules.
- XML element names must be uppercase per the NBAPI spec; attribute names/values stay lowercase as documented (see R2).
- Optional `NETBOX_ALLOW_INSECURE_TLS` must default to `false`/unset (reject self-signed certs by default); enabling it is an explicit opt-in, not a silent fallback.

## Acceptance rubric
- C1 (from R1): PASS iff the server starts via the documented command and responds to `list_tools` without error.
- C2 (from R2): PASS iff a captured request for at least one tool call matches the documented `NETBOX-API`/`COMMAND`/`PARAMS` XML structure, with element names uppercase and attribute names/values (`sessionid`, `name`, `num`, `dateformat`) lowercase exactly as documented.
- C3 (from R3): PASS iff starting the server with a required env var unset produces a one-line actionable error and a non-zero exit code, with no stack trace printed.
- C4 (from R4): PASS iff two sequential tool calls within one server run produce exactly one `Login` request.
- C5 (from R5): PASS iff a simulated session-expiry causes exactly one automatic re-login and the original call still succeeds.
- C6 (from R6): PASS iff sending SIGINT or SIGTERM to a running server triggers a `Logout` request before the process exits.
- C7 (from R7): PASS iff each of the six documented `APIERROR` codes, when simulated, surfaces as an MCP tool error containing its documented description.
- C8 (from R8): PASS iff a simulated `FAIL` response carrying an `ERRMSG` surfaces as an MCP tool error containing that `ERRMSG` text verbatim.
- C9 (from R9): PASS iff a `NOT FOUND` response returns a normal (non-error) tool result stating not-found.
- C10 (from R10): PASS iff a grep of the source tree for NBAPI command-name literals used as a `COMMAND name=` value turns up only the 17 commands listed in R10, with no write/control verb among them and no non-existent command (e.g. no literal `GetPortal`).
- C11 (from R11–R17): PASS iff all 15 tools (`check_connection`, `get_person`, `search_person_data`, `get_card_access_details`, `get_card_formats`, `get_access_level`, `get_access_levels`, `get_access_level_group`, `get_access_level_groups`, `get_portals`, `get_reader`, `get_readers`, `get_event_history`, `list_events`, `get_access_history`) are callable against the live test controller and each returns data matching what the NetBox web UI shows for the same query.
- C12 (from R18): PASS iff each tool's registered input schema's parameter names and required/optional status match exactly the "Command reference (verified against the primary source)" section's list for that command — no invented, renamed, or guessed field name anywhere.
- C13 (from R19): PASS iff a grep for the `NETBOX_PASSWORD` usage across `src/` and `test/` shows it only ever flows into the login request body, never into a log/console/error call.
- C-final: PASS iff a security-conscious reviewer familiar with the NBAPI documentation would accept this server as a safe, correctly-scoped, read-only NetBox integration without substantive changes.

## Open questions
(none)
