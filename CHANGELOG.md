# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Added `docs/reference/`: `NetBox_API_V1.pdf` (doc #API-UG-22, April 2024),
  `NetBox_API_V2.pdf` (doc #API2-UG-8, April 2025), `Data_Operations.pdf`
  (doc #DOPS-UG-22, April 2025), and `NetBox_Hardening_Guide.pdf` (doc
  NB-HG-03, May 2025) — LenelS2's official NetBox guides, as reference
  documentation. Downloaded from a NetBox controller's help portal; all are
  generic vendor content with no site-specific data, reviewed page-by-page
  before committing. This server's tools were built against an earlier NBAPI
  v1 edition (doc #API-UG-14, 2020); neither newer NBAPI edition has yet been
  diffed against the current command reference
  ([#75](https://github.com/J-MaFf/s2-netbox-mcp/issues/75)).
- Added `get_threat_levels` (wraps NBAPI `GetThreatLevels`, optional `ALLPARTITIONS` filter),
  always registered regardless of the write gates, like every other read tool. Found via a full
  conformance review of `docs/reference/NetBox_API_V2.pdf` against the 81-command allowlist: the
  command was documented (doc p.198) but had no `NBAPI_COMMANDS` entry or tool at all, leaving
  `set_threat_level`/`add_threat_level`/etc. with no way to list existing threat levels first.
  `src/tools/threatLevel.ts`'s module comment previously (and incorrectly) claimed no such read
  command existed in the Command reference -- it does; it just wasn't wired in
  ([#77](https://github.com/J-MaFf/s2-netbox-mcp/issues/77)).
- `search_person_data` gains nine filter fields documented for NBAPI `SearchPersonData` (doc p.262)
  but previously absent from the tool's schema: `CONTACTEMAIL`, `MOBILEPHONE`, `CARDFORMAT`,
  `CARDSTATUS`, `MSUENABLED`, `BLUEDIAMONDENABLED`, `NOTES`, `VEHICLELICNUM`, `VEHICLETAGNUM`.
  Found via the same `docs/reference/NetBox_API_V2.pdf` conformance review as `get_threat_levels`
  above -- this repo's original implementation was written against an older Feb-2020 NBAPI v1 doc
  revision that didn't yet document these fields
  ([#78](https://github.com/J-MaFf/s2-netbox-mcp/issues/78)).
- `add_person`/`modify_person` gain seven fields documented for NBAPI `AddPerson`/`ModifyPerson`
  (doc pp.89/235) but previously entirely absent: `USERNAME`, `PASSWORD`, `ROLE`, `AUTHTYPE`
  (closed enum `DB`/`LDAP`/`SSO`), `MOBILEPHONE`, `MSUENABLED`, `BLUEDIAMONDENABLED`. The doc marks
  `USERNAME`/`ROLE`/`AUTHTYPE` "required," and `AddPerson`'s own FAIL list confirms it — but
  `scripts/live-check-write.ts`'s `AddPerson` round-trip already succeeds against a real NetBox
  6.2.0 controller without them, and `ModifyPerson`'s FAIL list has no matching error. All seven
  are modeled as optional (closing the "can't set them at all" gap) rather than required, pending
  live confirmation of when the requirement actually applies — most likely only once `USERNAME` is
  set, i.e. only for a person who should also get a NetBox login account
  ([#79](https://github.com/J-MaFf/s2-netbox-mcp/issues/79)).
- `get_portal_groups` gains a `RESOLVEGROUPNAMES: boolean` parameter (default `true`/on, the exact
  same flag name and opt-*out* default as the singular `get_portal_group`'s own `RESOLVEGROUPNAMES`
  below -- this is that tool's explicitly-planned follow-on): unless explicitly set to `false`,
  every returned group's bare `UNLOCKTIMESPECGROUPKEY` foreign key is resolved into a new sibling
  `UNLOCKTIMESPECGROUPNAME` field, reusing `src/timeSpecGroupNames.ts`'s `fetchTimeSpecGroupNames`
  as-is. Unlike the singular tool's at-most-one-conditional-fetch shape (a single group carries
  exactly one key), this plural tool builds the `fetchTimeSpecGroupNames` map **once per call**,
  only if at least one group on the page carries a non-empty `UNLOCKTIMESPECGROUPKEY` (zero
  `GetTimeSpecGroups` calls if every key on the page is empty), then looks every group up against
  that same shared map -- the same one-shared-fetch-per-page cost shape as `get_time_spec_groups`'s
  own `RESOLVEMEMBERNAMES`, never one fetch per group. `GetPortalGroups`' list items are already
  flat (`DETAILS.PORTALGROUPS.PORTALGROUP[]`, no per-item `PORTALGROUP` wrapper -- that quirk
  belongs only to the singular `GetPortalGroup` command's own response envelope), so no per-item
  unwrap is applied. The already-human-readable `PORTALS` sub-list (`{PORTALKEY, NAME}` per portal)
  is left completely unchanged on every group. A `GetTimeSpecGroups` fetch failure yields `''` for
  every group's name while every other field (including `PORTALS`) stays intact
  ([#69](https://github.com/J-MaFf/s2-netbox-mcp/issues/69)).
- `get_portal_group` gains a `RESOLVEGROUPNAMES: boolean` parameter (default `true`/on, the exact
  same flag name and opt-*out* default as `get_access_level`'s own `RESOLVEGROUPNAMES` below,
  since it is the identical kind of lookup against the same `GetTimeSpecGroups` table): unless
  explicitly set to `false`, it resolves the response's bare `UNLOCKTIMESPECGROUPKEY` foreign key
  into a new sibling `UNLOCKTIMESPECGROUPNAME` field, via one fixed-cost `GetTimeSpecGroups` fetch
  per call (a single portal group carries exactly one `UNLOCKTIMESPECGROUPKEY`, so this never
  scales with anything). Reuses `src/timeSpecGroupNames.ts`'s `fetchTimeSpecGroupNames` as-is --
  no second, parallel fetch-and-map implementation. The already-human-readable `PORTALS` sub-list
  (`{PORTALKEY, NAME}` per portal) is left completely unchanged. An empty/absent
  `UNLOCKTIMESPECGROUPKEY` skips the fetch entirely and yields `''` for the name; a
  `GetTimeSpecGroups` fetch failure also yields `''` for the name while the primary
  `GetPortalGroup` data (including `PORTALS`) stays intact. `THREATLEVELGROUPKEY` is out of scope
  and never resolved -- no NBAPI read command for threat level groups exists in this server's
  command surface at all
  ([#63](https://github.com/J-MaFf/s2-netbox-mcp/issues/63)).
- `list_events` gains a `RESOLVEPARTITIONNAMES: boolean` parameter (default `true`/on, the same
  opt-*out* default as `get_access_level`'s `RESOLVEGROUPNAMES`/`get_portals`'s
  `RESOLVEDESCRIPTIONS`): unless explicitly set to `false`, each returned event's bare
  `PARTITIONID` is resolved into a new sibling `PARTITIONNAME` field, via one fixed-cost
  `GetPartitions` fetch per call (not per event -- `GetPartitions` takes no `STARTFROMKEY` and
  always answers every partition in a single response, so the cost never scales with how many
  events come back). A new shared module, `src/partitionNames.ts`, exports
  `fetchPartitionNames`, mirroring `src/readerDescriptions.ts`'s never-throws `Map`-returning
  shape exactly: an unmatched `PARTITIONID` resolves to `PARTITIONNAME: ''`, and if the
  underlying `GetPartitions` fetch itself fails, every event's `PARTITIONNAME` resolves to `''`
  while every other field (including `ACTIONS`) stays intact
  ([#65](https://github.com/J-MaFf/s2-netbox-mcp/issues/65)).
- `get_time_spec_groups` gains a `RESOLVEMEMBERNAMES: boolean` parameter (default `true`/on, the
  same opt-*out* default as `get_access_level`'s own `RESOLVEGROUPNAMES`): unless explicitly set
  to `false`, each group's `TIMESPECKEYS.TIMESPECKEY` field -- bare `TIMESPECKEY` string(s) as
  `GetTimeSpecGroups` returns them -- is replaced with a list of `{TIMESPECKEY, NAME}` objects,
  matching this codebase's convention for other group-membership sub-lists NBAPI already returns
  as objects (`get_access_level_group`'s `ACCESSLEVELS`, `get_reader_group`'s `READERS`). An
  unmatched member key (unknown/deleted time spec) resolves to `NAME: ''` rather than being
  omitted. A new shared module, `src/timeSpecNames.ts`, fetches the full paginated `GetTimeSpecs`
  list once per call (never per group/member) and resolves client-side, mirroring
  `src/readerDescriptions.ts`'s never-throws `Map`-returning shape exactly -- a `GetTimeSpecs`
  failure resolves every member's `NAME` to `''` rather than failing the call. Applies only to
  this plural tool, not the singular `get_time_spec_group`, which is verified broken
  (`CODE=FAIL`/`ERRMSG="NOT FOUND"`) on this controller independent of this change. As part of
  this work, `keyList` (the bare-key-collection normalizer this feature reuses for
  `TIMESPECKEYS.TIMESPECKEY`) is relocated from the unlock-window-specific
  `src/unlockWindow/managed.ts` to the general `src/paging.ts`, with no behavior change, so a
  general tool module doesn't need to import from a feature-specific one
  ([#64](https://github.com/J-MaFf/s2-netbox-mcp/issues/64)).
- `get_access_level` gains a `RESOLVEGROUPNAMES: boolean` parameter (default `true`/on, the
  same opt-*out* default as `get_portals`/`get_access_history`/`get_card_access_details`'s own
  `RESOLVEDESCRIPTIONS`): unless explicitly set to `false`, it resolves the response's bare
  `TIMESPECGROUPKEY`/`READERGROUPKEY` foreign keys into new sibling
  `TIMESPECGROUPNAME`/`READERGROUPNAME` fields, via one fixed-cost `GetTimeSpecGroups` fetch and
  one fixed-cost `GetReaderGroups` fetch per call (a single access level carries exactly one of
  each key, so this never scales with anything). Two new shared modules,
  `src/timeSpecGroupNames.ts` and `src/readerGroupNames.ts`, each fetch their full paginated list
  and resolve client-side, mirroring `src/readerDescriptions.ts`'s never-throws `Map`-returning
  shape exactly. `TIMESPECGROUPKEY` is resolved via the paginated `GetTimeSpecGroups` list rather
  than the singular `GetTimeSpecGroup` command, which is verified broken on this controller --
  it returns `CODE=FAIL`/`ERRMSG="NOT FOUND"` even for a genuinely existing group (the same
  finding already documented for `src/unlockWindow/managed.ts`); `READERGROUPKEY` is resolved via
  the paginated `GetReaderGroups` list too, for consistency. An empty/absent key on either axis
  independently skips that axis's fetch and yields `''` for just that axis's name.
  `THREATLEVELGROUPKEY` is out of scope and never resolved -- no NBAPI read command for threat
  level groups exists in this server's command surface at all
  ([#61](https://github.com/J-MaFf/s2-netbox-mcp/issues/61)).

### Fixed
- `get_reader_access_history` no longer drops the native `PORTALNAME` field that
  `GetAccessHistory` already returns on every record -- `PORTALKEY` was kept but `PORTALNAME` was
  silently discarded by this tool's own record transform, unlike `get_access_history`/
  `get_card_access_details`, which already pass it through untouched
  ([#70](https://github.com/J-MaFf/s2-netbox-mcp/issues/70)).

## [0.3.0] — 2026-09-16

### Changed
- README's client registration section, previously "Registering with Claude Code" and
  clone-only, is now "Registering with an MCP client": adds the npm-install JSON variant
  alongside the existing clone-based one, and a table of known client config file locations
  (Claude Code, Antigravity, Gemini CLI) -- all verified working with this server this session
  ([#49](https://github.com/J-MaFf/s2-netbox-mcp/issues/49)).

### Added
- `get_card_access_details` gains an opt-in `RESOLVENAMES: true` parameter (default `false`):
  enriches the response with the card owner's `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` via a
  single `GetPerson` call, reusing `src/personEnrichment.ts`'s `enrichWithPersonNames` as-is
  (a single-element array call). Unlike `get_access_history`'s `RESOLVENAMES` -- one `GetPerson`
  call per distinct `PERSONID` across many records -- `GetCardAccessDetails`' response carries
  exactly one `PERSONID` at the top level, so the four enriched fields land on the **top level**
  of the response, alongside `PERSONID`/`DISABLED`/`EXPDATE`, rather than duplicated onto every
  `ACCESS` record. Independent of the existing `RESOLVEDESCRIPTIONS` flag on the same tool -- either,
  both, or neither may be requested in the same call
  ([#55](https://github.com/J-MaFf/s2-netbox-mcp/issues/55)).
- `get_portals` gains a `RESOLVEDESCRIPTIONS: boolean` parameter (default `true`/on, the same
  opt-*out* default as `get_access_history`/`get_card_access_details`/`get_reader_access_history`'s
  own `RESOLVEDESCRIPTIONS`): unless explicitly set to `false`, it fills in each nested reader's
  own `DESCRIPTION` field -- `GetPortals` never populates it, only `READERKEY`/`NAME`/
  `PORTALORDER` -- via one `GetReaders` full-table fetch per call (not per portal/reader), reusing
  `src/readerDescriptions.ts`'s `fetchReaderDescriptions`. Unlike the sibling tools above, which
  add a new sibling `READERDESCRIPTION` field to flat records, this fills `DESCRIPTION` in
  directly on each nested reader object -- that's the reader's own native `GetReaders` field name,
  and `get_portals`'s readers are nested objects rather than flat records. `find_portals` is
  unchanged and remains the tool for *searching* portals by name/description; this only makes a
  plain `get_portals` listing self-describing ([#57](https://github.com/J-MaFf/s2-netbox-mcp/issues/57)).
- `get_reader_access_history` tool: a single reader's access (grant/deny) history, filtered
  client-side (`GetAccessHistory` has no `READERKEY`/`PORTALKEY` filter) over a bounded
  `SCANWINDOW` of the most recent system-wide records (default 2000) via its own
  `AFTERLOGID`/`NEXTLOGID` pagination loop, seeded by a cheap `MAXRECORDS: '1'` call that
  discovers the current maximum `LOGID` -- a fixed-size record-count window rather than a
  date range, after two rounds of live verification found real date-range filtering
  unworkable on this controller. Each match's `PERSONID` is enriched with a name via one
  `GetPerson` call per distinct person (a lookup failure leaves that record's name blank
  rather than failing the call), and the result is capped at `MAXMATCHES` (default 100) with
  a `truncated` flag ([#46](https://github.com/J-MaFf/s2-netbox-mcp/issues/46)).
- `get_access_history` gains an opt-in `RESOLVENAMES: true` parameter: enriches each returned
  record with the badge-holder's `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` via one `GetPerson`
  call per distinct `PERSONID` found in the result -- the same per-request memoization pattern
  `get_reader_access_history` already used, now extracted into a new shared
  `src/personEnrichment.ts` module both tools call. Defaults to `false`/off, since enabling it
  costs one extra `GetPerson` call per distinct person found in the result. As a side effect of
  the shared-helper refactor, `get_reader_access_history`'s output also gains `FULLNAME`/`NOTES`
  on every match (additive -- `FIRSTNAME`/`LASTNAME` keep their existing meaning and no field is
  removed or renamed).
- `SECURITY.md`: private vulnerability reporting instructions (via GitHub's private
  advisory reporting, now enabled on the repo) and a plain statement of the physical-safety
  blast radius at each configuration level ([#30](https://github.com/J-MaFf/s2-netbox-mcp/issues/30)).
- A prominent `> [!WARNING]` callout near the top of README.md: this connects to a real
  physical security system, read-only by default, writes/destructive are explicit opt-in
  ([#30](https://github.com/J-MaFf/s2-netbox-mcp/issues/30)).
- Enabled secret scanning + push protection on the repo (previously off; Dependabot security
  updates were already on) ([#30](https://github.com/J-MaFf/s2-netbox-mcp/issues/30)).
- New shared `src/readerDescriptions.ts` module (`fetchReaderDescriptions` +
  `enrichWithReaderDescriptions`) -- mirrors `src/personEnrichment.ts`'s shape but does one
  full paginated `GetReaders` fetch per call rather than one lookup per distinct key, since the
  reader table is small and unfiltered (the whole 68-reader table already fetches in exactly 2
  pages, as `find_portals` proved). `get_access_history` and `get_card_access_details` both gain
  a `RESOLVEDESCRIPTIONS: boolean` parameter that enriches each returned record with the
  reader's human-readable `READERDESCRIPTION` alongside its existing `READER`/`PORTALNAME` code
  -- and `get_reader_access_history` gains the same flag but attaches a single **top-level**
  `READERDESCRIPTION` field instead of duplicating it onto every `matches` entry, since every
  match in that tool already shares one caller-supplied `READERKEY` by construction. All three
  default to `true`/on -- the first opt-*out* (rather than opt-in) boolean parameter in this
  codebase, since the underlying `GetReaders` fetch has a fixed cost that doesn't scale with
  result size, unlike `RESOLVENAMES`'s per-person `GetPerson` calls. `RESOLVENAMES` and
  `RESOLVEDESCRIPTIONS` are independent flags on `get_access_history` -- either, both, or
  neither may be requested in the same call
  ([#53](https://github.com/J-MaFf/s2-netbox-mcp/issues/53)).

### Removed
- `get_access_history`'s `OLDESTDTTM`/`NEWESTDTTM` parameters -- they never matched
  `GetAccessHistory`'s real NBAPI date-filter field names (`STARTDATE`/`ENDDATE`), and a live
  controlled A/B test this session found that even the correct names don't work: the controller
  silently ignores them and returns the identical most-recent records regardless of the
  requested range, no error, just no effect. Renaming would have only traded a loud failure for
  a silently wrong one, so the fields are removed rather than fixed, closing
  [#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47).

### Fixed
- README's intro paragraph still said "Claude-callable tools" -- fixed to match the
  client-agnostic wording used everywhere else ([#30](https://github.com/J-MaFf/s2-netbox-mcp/issues/30)).
- README's intro paragraph said "two are composites, `find_portals` and `get_unlock_window`,"
  which predated `get_daily_unlock_window` (`v0.2.0`) and `get_reader_access_history` (this
  release) -- both are read-only composites too, and the README's own "Tools exposed" section
  already correctly said "Nine tools are composites" and named all four
  ([#59](https://github.com/J-MaFf/s2-netbox-mcp/issues/59)).

## [0.2.3] — 2026-09-15

### Changed
- Version-only release to sync npm's published README with GitHub's -- npm snapshots the
  README at publish time and doesn't update it on its own.
  ([#37](https://github.com/J-MaFf/s2-netbox-mcp/pull/37),
  [#39](https://github.com/J-MaFf/s2-netbox-mcp/pull/39))

## [0.2.2] — 2026-09-15

### Added
- `.github/workflows/publish.yml`: publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
  (OIDC from GitHub Actions) on every `v*` tag push -- no long-lived npm token, no
  interactive OTP, automatic provenance attestations. Requires the Trusted Publisher to be
  configured on the package's npmjs.com settings page once the package exists on the
  registry ([#33](https://github.com/J-MaFf/s2-netbox-mcp/issues/33)).
- `.github/workflows/ci.yml`: runs `npm ci`/`typecheck`/`test`/`build` on every push and PR
  against `main` ([#28](https://github.com/J-MaFf/s2-netbox-mcp/issues/28)).
- `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, and
  `.github/PULL_REQUEST_TEMPLATE.md` for outside contributors
  ([#28](https://github.com/J-MaFf/s2-netbox-mcp/issues/28)).
- `server.json` and `package.json`'s `mcpName` field, listing the server on the
  [official MCP Registry](https://registry.modelcontextprotocol.io) as
  `io.github.J-MaFf/s2-netbox-mcp` ([#29](https://github.com/J-MaFf/s2-netbox-mcp/issues/29)).

### Fixed
- README's "Out of scope" list no longer claims "Publishing/packaging this server, or a
  CI/CD pipeline" is out of scope — both now exist (#27, #33)
  ([#28](https://github.com/J-MaFf/s2-netbox-mcp/issues/28)).

## [0.2.1] — 2026-09-15

### Added
- Published to the npm registry: `"private"` flipped to `false`, and `repository`, `bugs`,
  `homepage`, and `keywords` added to `package.json` for npm search/discoverability
  ([#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27)).
- `bin` entry (`s2-netbox-mcp` → `dist/index.js`) plus a `#!/usr/bin/env node` shebang on
  `src/index.ts`, so `npm install -g s2-netbox-mcp` gives a directly runnable
  `s2-netbox-mcp` command instead of requiring `node dist/index.js`
  ([#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27)).
- `files` field in `package.json` scoping the published tarball to `dist/`, `README.md`,
  `LICENSE`, and `CHANGELOG.md` — verified via `npm pack --dry-run` (33 files, no `src/`,
  `scripts/`, `specs/`, or `.env`) ([#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27)).
- README "Setup" section documents the npm install path as an alternative to clone-and-build
  ([#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27)).

### Changed
- `package.json`'s `description` no longer says "Claude-callable tools" — this server has been
  verified working with Gemini/Antigravity too, so the description now says "MCP tools usable
  from any MCP-compatible client" ([#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27)).

## [0.2.0] — 2026-09-15

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
  clock-skew gate, and `--go` door-unlock phase under its own `MCP livecheck daily` prefix
  ([#23](https://github.com/J-MaFf/s2-netbox-mcp/issues/23),
  [#24](https://github.com/J-MaFf/s2-netbox-mcp/pull/24)). Live-verified the same day: a real
  14:15-14:17 window on portal `02OF01A`, unlock/relock confirmed in person, 16/16 steps PASS.

### Fixed
- Documented (README) that `npm run test:live:write[:daily] -- --go` silently drops `--go` on at
  least one PowerShell/npm combination (`npm warn Unknown cli config "--go"`, flag never reaches
  the script); `npx tsx scripts/live-check-write[-daily].ts --go` is the reliable invocation
  ([#23](https://github.com/J-MaFf/s2-netbox-mcp/issues/23)).

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
