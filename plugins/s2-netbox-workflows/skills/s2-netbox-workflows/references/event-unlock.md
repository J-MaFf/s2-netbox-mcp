# Unlock doors for an event

Schedules doors to unlock for a date and time range, enforced by the
controller itself. Uses the scheduled composite tools, never a raw
`unlock_portal` or Extended Unlock. Read `get_guide` topics `write-safety`
and `unlock-windows` first.

## Pick the tool

| The request | Tool | Undo |
|---|---|---|
| One continuous window ("Friday 08:00 to 17:00", "Sat 18:00 to Sun 02:00") | `schedule_unlock_window` | `cancel_unlock_window` |
| The same hours every day across a date range ("09:00 to 17:00 daily, 3 to 7 Nov") | `schedule_daily_unlock_window` | `cancel_daily_unlock_window` |

A daily window can't cross midnight. Use the continuous tool for an
overnight event. The two windows are independent and can both be active.

## Steps

1. **Pin down the request.** Get the doors, start and end, and confirm
   controller-local times. Turn a relative date ("Friday") into
   `YYYY-MM-DD` and repeat it back.
2. **Resolve the doors.** Call `find_portals` with the user's words ("lobby",
   "front entrance"). Show each match's portal name, key, and reader
   description, and have the user pick the exact set. Never schedule a door
   the user hasn't confirmed by name.
3. **Check what's already scheduled.** Call `get_unlock_window` (or
   `get_daily_unlock_window`). There's only one managed window of each kind,
   and scheduling a new one replaces the existing one. If one is already set,
   show its doors and times and ask whether to replace it or merge the door
   lists and times into a single window.
4. **Dry run.** Call the schedule tool with `portalKeys` set to the confirmed
   keys and `dryRun: true`. Always pass `portalKeys`, because leaving it out
   unlocks every portal. Show the plan, including any time specs the report
   says would be suppressed on those dates.
5. **Confirm, then schedule.** State which doors, which window, that the
   controller relocks them on its own, and that the undo is the matching
   cancel tool. If the dry run reported suppressed time specs, the user has
   to accept that effect specifically before you pass
   `acknowledgeSideEffects: true`. Then call the tool without `dryRun`.
6. **Verify.** Re-read with `get_unlock_window` (or
   `get_daily_unlock_window`) and show the doors, the window, and whether it's
   active now.

## Undo

`cancel_unlock_window` or `cancel_daily_unlock_window` takes no parameters and
cancels the whole managed window. It doesn't cancel single doors. To drop one
door from a window, schedule it again with the reduced `portalKeys` list.
Never delete the underlying holidays or time specs by hand (see
`write-safety`).

## Watch for

- **Midnight relock.** A multi-day continuous window may relock for up to 60
  seconds at each midnight. Mention this if the event runs overnight.
- **Length limits.** If the schedule tool refuses because the window is too
  long or ends in the past, report the refusal. Don't split the event into
  several calls on your own.
- **Right now.** For "unlock it right now for a minute", this workflow
  doesn't apply. That's a single `momentary_unlock_portal` call, still
  confirmed under `write-safety`.
