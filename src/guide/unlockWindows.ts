import type { GuideTopic } from './types.js';

/**
 * R6 (unlock-windows): the holiday + time spec + portal-group
 * UNLOCKTIMESPECGROUPKEY recipe, holiday STARTDATE/ENDDATE and time spec
 * ENDTIME inclusivity rules, and a recommendation to prefer the composite
 * tools over hand-assembling the recipe. Generic S2 NetBox domain knowledge
 * only.
 */
export const unlockWindowsTopic: GuideTopic = {
  title: 'Unlock windows',
  summary:
    'The holiday + time spec + portal group recipe behind a scheduled unlock, its date/time inclusivity rules, and when to prefer the composite tools.',
  content: `Unlock windows

A scheduled unlock window is built from three underlying object types, tied
together by one key: a Holiday marks the eligible dates and belongs to a
holiday group; a Time Spec ticks that same holiday group and carries the
time-of-day window (with no weekdays selected, it is active only on dates
covered by a holiday in that group); and a Portal Group's
UNLOCKTIMESPECGROUPKEY points at the Time Spec Group that contains that time
spec. Combining all three is what produces "these doors unlock on these
dates, during these hours" -- the controller enforces it itself, with no
process needing to stay alive to relock anything.

Two date/time inclusivity rules matter when working with this recipe
directly: a holiday's STARTDATE is inclusive and its ENDDATE is exclusive,
and a time spec's ENDTIME is inclusive through the end of that stated minute
(an ENDTIME of 17:00 covers up through 17:00:59, not up to but excluding
17:00).

For anything beyond a one-off manual test of this mechanism, prefer the
scheduled composite tools over hand-assembling the three objects yourself:
schedule_unlock_window and cancel_unlock_window for a single continuous
window, or schedule_daily_unlock_window and cancel_daily_unlock_window for a
window that recurs every day across a date range. The composite tools apply
the objects in a verified, idempotent order and clean up after themselves;
hand-assembling the same recipe manually is easy to leave in a
partially-applied state.`,
};
