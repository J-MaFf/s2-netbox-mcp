# Offboard someone

Turns off a departing person's access. The default path is fully reversible:
disable every card, then remove the access levels. Deleting cards or the
person record is a separate destructive step, done only if the user asks for
it. Read `get_guide` topics `write-safety` and `credentials-and-card-formats`
first.

## Steps

1. **Find the person.** Call `search_person_data` with name fields (or
   `HOTSTAMP` if the user has the card in hand) and `WANTCREDENTIALID` set.
   If the search returns more than one match, ask which person. Then call
   `get_person` with that `PERSONID`, `WANTCREDENTIALID: "1"`, and
   `ACCESSLEVELDETAILS`.
2. **Show what will change.** List every card (format, encoded number or hot
   stamp, `CREDENTIALID`, current status) and every access level the person
   holds. This list is the scope of the offboarding. Ask the user to confirm
   it, including any card that should stay active.
3. **Confirm, then disable each card.** For each card, call
   `modify_credential` with `PERSONID`, the card's identifier (`CREDENTIALID`,
   or `CARDFORMAT` + `ENCODEDNUM`/`HOTSTAMP`), and `DISABLED: "1"`. Check
   every result for `SUCCESS` before moving to the next card.
4. **Confirm, then remove the access levels.** Call `modify_person` with
   `ACCESSLEVELS` as a list of `{ ACCESSLEVELNAME, DELETE: "1" }` blocks, one
   per level. Never send an empty or bare-name list to clear access. The bare
   form replaces the whole set, and its behavior with an empty list is not
   something to rely on.
5. **Verify.** Re-read the person with `get_person` and show that every card
   is disabled and no levels remain. For each card, call `get_access_history`
   with `ENCODEDNUM` (or `HOTSTAMP`) + `CARDFORMAT` and show the latest
   records. Any grant after the disable time means something was missed.
   `get_access_history` has no `PERSONID` filter, so query per card.

## Optional: destructive removal

Only if the user explicitly asks to delete the cards or the person record, and
only with `NETBOX_ENABLE_DESTRUCTIVE=true`:

- Before removing anything, name exactly which card or person record will be
  permanently removed and get a separate yes for it.
- **Remove a card:** `remove_credential` with `PERSONID` + `CREDENTIALID` (or
  `CARDFORMAT` + `ENCODEDNUM`/`HOTSTAMP`). This cannot be undone. The card
  would have to be issued again.
- **Remove the person:** `remove_person` with `PERSONID`. This is a soft
  delete (see `credentials-and-card-formats`). The record stays visible with
  `DELETED` set, so reading it again after the call is expected and doesn't
  mean the call failed.

Disabled cards plus no access levels already deny everything, so recommend
stopping before this step unless the user has a reason to delete.

## Watch for

- **AD sync.** If the site syncs people or access levels from Active
  Directory, the next sync may restore what you removed. Tell the user the
  person must also be disabled or removed in AD.
- **Shared or reissued cards.** If a card's number also appears on another
  person's record, stop and ask. Don't touch the other person's record.

## Undo

- Re-enable a card: `modify_credential` with `DISABLED: "0"`.
- Restore access levels: `modify_person` with `{ ACCESSLEVELNAME }` blocks
  for the levels listed in step 2. Keep that list in your reply so it can be
  restored.

A removed credential can't be undone. Issue the card again with
`add_credential`.
