# Work out why a badge was denied

A read-only diagnosis that makes no write calls. Start from the actual denial
record and use its reason to decide which link in the chain to check. Don't
walk the whole chain blindly. Read `get_guide` topics `access-model` and
`credentials-and-card-formats` first.

## Steps

1. **Find the denial.** Use whichever the user gave you:
   - **The card or person.** Get the card's `ENCODEDNUM` (or `HOTSTAMP`) and
     `CARDFORMAT` from `get_person` with `WANTCREDENTIALID: "1"`. Then call
     `get_access_history` for that card with a `MAXRECORDS` big enough to
     reach the attempt.
   - **The door.** Call `find_portals` to get its reader's `READERKEY`, then
     `get_reader_access_history` for that reader.

   Pick the denied attempt that matches the time the user described, and show
   it: when, which reader, and the denial reason the record gives. If there's
   no matching record, say so. The attempt may not have reached the
   controller (a reader or panel problem, see step 3), or it's older than the
   history you scanned.
2. **Branch on the reason.**

   | The reason points at | Check | Where |
   |---|---|---|
   | Card format or bit length (BIT MISMATCH) | The card's format isn't one the controller will decode. The NBAPI can't confirm this. | `credentials-and-card-formats`: send the user to the NetBox web UI |
   | Unknown or unassigned card | The number on the card doesn't match any credential. Compare the number read with the card numbers on the person's record. | `search_person_data` with `HOTSTAMP`, or `get_person` |
   | Card disabled, expired, or not yet valid | The card's status, `DISABLED`, and expiry date | `get_person` with `WANTCREDENTIALID: "1"` |
   | No access at this reader, or the wrong time | Access levels and schedules, below | Step 3 |
   | Anything else, or the reason is unclear | Work through steps 3a to 3d in order | Step 3 |

3. **Follow the access chain** (the WHAT and WHEN in `access-model`):
   1. **Does the person hold any active level?** Read their levels from
      `get_person` with `ACCESSLEVELDETAILS`. Look at each level's activation
      and expiry dates. If no level is active, that's the answer.
   2. **Does a level cover this reader?** Map each level name to its key with
      `get_access_levels`, paging to the end. Then call `get_access_level`
      with `RESOLVEGROUPNAMES`. A level applies to a single `READERKEY` or a
      `READERGROUPKEY`. For a group, check its members with
      `get_reader_group`. If no level covers the denying reader, that's the
      answer. Name the levels that do cover that reader, from
      `get_access_levels`, as a suggestion only.
   3. **Was the level's schedule active at that time?** Read the level's
      `TIMESPECGROUPKEY` with `get_time_spec_group`, then each member's
      `get_time_spec`. Check the weekday and time of the attempt against
      them. If a holiday was in effect on that date (`get_holidays`), check
      whether the time spec ticks that holiday's group. A day covered by a
      holiday the spec doesn't tick is a common cause of "worked yesterday,
      denied today".
   4. **Is the door itself OK?** Call `get_portal_statuses` (and
      `get_portal_states`). An offline reader or panel, or a door locked down
      by a threat level, denies everyone. Use `get_threat_levels` if a threat
      level is in play.
4. **Report.** Give one finding: the link that failed, the record that shows
   it, and the fix. Example: "Jane's 'Warehouse' level covers the reader
   group 'Dock Doors', which doesn't include this reader." State the fix as a
   suggestion for the user to decide, such as granting a level, re-enabling
   a card, or editing a reader group. If they want it done, it's a separate
   write under `write-safety`. For an access level change, use the onboard
   workflow's block syntax.

## Watch for

- **Paging.** `get_access_levels`, `get_access_level_names`, and the history
  tools return one page per call. A level or record missing from the first
  page isn't proof it doesn't exist (`api-quirks`).
- **Clock and time zone.** History timestamps and time specs are both in the
  controller's local time. Compare them in the same zone.
