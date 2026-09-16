# Vendor documentation

Reference copies of LenelS2's official NBAPI documentation, kept here so
contributors don't need controller access to consult them. Both are generic
vendor manuals bundled with every NetBox install — no site-specific data.

- **`NetBox_API_V1.pdf`** — *Web-Based API for NetBox and NetBox Global*
  (LenelS2, April 2024, Document #API-UG-22). NBAPI **v1**, current with
  NetBox Release 5.4.x / Global 2.19.
- **`NetBox_API_V2.pdf`** — *NBAPI version 2 Guide, For NetBox and NetBox
  Global* (LenelS2, April 2025, Document #API2-UG-8). NBAPI **v2**, current
  with NetBox Release 5.4.x / Global 2.19.

Both downloaded from a NetBox controller's own help portal (Getting Started
> Guides and Technical Notes > Programming Guides).

This server's specs and tools were originally built against an earlier NBAPI
v1 edition (LenelS2 doc #API-UG-14, February 2020, current with S2 NetBox
Release 5.0), per [README.md](../../README.md) — a different, older revision
of the same v1 command set than `NetBox_API_V1.pdf` above. NBAPI v1 was
deprecated in NetBox 5.6 (November 2022) and retired in NetBox 6.0 in favor
of v2 — see the End-of-Support Notice on page 1 of `NetBox_API_V2.pdf`. A
diff pass across all three documents' Command Reference sections would
confirm whether any tool in this server needs updating for newer/changed
commands or parameters; that has not been done yet.

©2025 Honeywell International Inc. All Rights Reserved. Included here as
LenelS2's standard customer-facing product documentation, not modified from
the original.
