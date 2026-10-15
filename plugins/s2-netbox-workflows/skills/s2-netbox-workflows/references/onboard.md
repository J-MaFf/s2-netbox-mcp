# Onboard a new hire

Creates a person record, gives it access levels, and issues a card.
Read `get_guide` topics `write-safety` and `credentials-and-card-formats`
first.

## Gather from the user

- First and last name. Ask for an email or other identifier too if the site
  uses one.
- The card's number, as an encoded number or a hot stamp (the number printed
  on the card), and its card format if known. Never invent or guess a card
  number.
- Which access levels to grant, by name. If the user describes access
  ("warehouse days", "same as Jane"), find the matching names in the next
  step and confirm them. Never infer a level from a description alone.

## Steps

1. **Check for a duplicate.** Call `search_person_data` with `LASTNAME` and
   `FIRSTNAME`, using `CASEINSENSITIVE` and `DELETED: "ALL"`. If a match turns
   up, show it and ask whether this is the same person:
   - An active match means modify it rather than create a second record.
   - A deleted match is a soft-deleted former record (see
     `credentials-and-card-formats`). Ask whether to reuse it via
     `modify_person` or create a new one.
2. **Resolve the access levels.** Call `get_access_level_names`, paging with
   `STARTFROMNAME` until it's done. Match the requested levels to exact names.
   To copy an existing person, read their levels from `get_person` instead.
   Show the final list.
3. **Resolve the card format.** Call `get_card_formats` and match the format
   the user gave. If they didn't give one, list the formats and ask. A wrong
   format makes the card unreadable (BIT MISMATCH).
4. **Confirm, then create the person.** Tell the user the person you'll
   create and the access levels they'll get. Call `add_person` with the name
   fields and `ACCESSLEVELS` as a list of `{ ACCESSLEVELNAME }` blocks. Add
   `EXPDATE` per block for a temporary hire. Record the `PERSONID` returned
   with `SUCCESS`.
5. **Confirm, then add the card.** Call `add_credential` with that
   `PERSONID`, `CARDFORMAT`, `ENCODEDNUM` or `HOTSTAMP`, and
   `WANTCREDENTIALID: "1"`. Add `CARDEXPDATE` if the access is temporary.
6. **Verify.** Call `get_person` with `PERSONID` and `WANTCREDENTIALID` and
   show the record, levels, and card. If you have the encoded number, also
   call `get_card_access_details` with `ENCODEDNUM` + `CARDFORMAT`.

## Watch for

- **AD sync.** If the site syncs people from Active Directory, fields AD owns
  are overwritten on its next sync (see the `add_person` description). Ask
  before writing them, because the person may need to be created in AD
  instead.
- **Access level syntax.** A plain list of names in `ACCESSLEVELS` replaces
  every level the person has. This doesn't matter for a new record, but always
  use the block form when adding levels to an existing person with
  `modify_person`.

## Undo

- Take back a level: `modify_person` with
  `{ ACCESSLEVELNAME, DELETE: "1" }`.
- Turn off the card: `modify_credential` with `DISABLED: "1"`.

Both can be reversed. Removing the card or person outright is the offboard
workflow's destructive step. Don't use it to undo an onboarding mistake unless
the user asks.
