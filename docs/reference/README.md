# Vendor documentation

Reference copies of LenelS2's official NetBox documentation, kept here so
contributors don't need controller access to consult them. All are generic
vendor manuals bundled with every NetBox install — no site-specific data.
Each was reviewed page-by-page before being committed to confirm that.

- **`NetBox_API_V1.pdf`** — *Web-Based API for NetBox and NetBox Global*
  (LenelS2, April 2024, Document #API-UG-22). NBAPI **v1**, current with
  NetBox Release 5.4.x / Global 2.19.
- **`NetBox_API_V2.pdf`** — *NBAPI version 2 Guide, For NetBox and NetBox
  Global* (LenelS2, April 2025, Document #API2-UG-8). NBAPI **v2**, current
  with NetBox Release 5.4.x / Global 2.19.
- **`Data_Operations.pdf`** — *Data Operations Guide, For NetBox and NetBox
  Global* (LenelS2, April 2025, Document #DOPS-UG-22). Describes the CSV/TSV
  bulk import/export feature for person records — a separate mechanism from
  the NBAPI's `AddPerson`/`ModifyPerson`/etc. commands, relevant background
  for anything in this server that touches person-record data at scale.
- **`NetBox_Hardening_Guide.pdf`** — *NetBox Hardening Guide* (LenelS2, May
  2025, Document NB-HG-03). Vendor security-hardening guidance (accounts/
  passwords, TLS, ports, VLAN isolation) — relevant background for this
  project's own [`SECURITY.md`](../../SECURITY.md), which already treats
  this server as connecting to a live physical security system.

All four downloaded from a NetBox controller's own help portal (Getting
Started > Guides and Technical Notes > Programming Guides).

Alongside them, **`nbapi-command-diff.md`** is this project's own analysis of
the two API guides against the server's implemented command set — see below.

This server's specs and tools were originally built against an earlier NBAPI
v1 edition (LenelS2 doc #API-UG-14, February 2020, current with S2 NetBox
Release 5.0), per [README.md](../../README.md) — a different, older revision
of the same v1 command set than `NetBox_API_V1.pdf` above. NBAPI v1 was
deprecated in NetBox 5.6 (November 2022) and retired in NetBox 6.0 in favor
of v2 — see the End-of-Support Notice on page 1 of `NetBox_API_V2.pdf`.

That diff pass is **done**, on 2026-09-17:
[**`nbapi-command-diff.md`**](nbapi-command-diff.md) in this directory is a
command-by-command and parameter-by-parameter comparison of the v1-2024
guide, the v2-2025 guide and this server's tool surface, with a row for every
command either guide documents. It also records three findings that close
long-standing questions: neither guide has any Add/Modify/Delete command for
elevators or floors, this server already speaks v2 over the same
`/nbws/goforms/nbapi` endpoint (so the End-of-Support Notice is a non-event
here), and `Data_Operations.pdf` describes a UI/NAS feature with no API to
wrap. Every command it lists as unimplemented is unimplemented on purpose,
with the reason in its row.

©2025 Honeywell International Inc. All Rights Reserved. Included here as
LenelS2's standard customer-facing product documentation, not modified from
the original.
