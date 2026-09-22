import type { GuideTopic } from './types.js';

/**
 * R6 (write-safety): elaborates the R2 instructions paragraph -- name the
 * target and effect, wait for explicit confirmation, prefer scheduled tools,
 * and know how to reverse every write. Generic S2 NetBox domain knowledge
 * only.
 */
export const writeSafetyTopic: GuideTopic = {
  title: 'Write safety',
  summary:
    'Name the target and effect, wait for explicit confirmation, prefer scheduled tools over standing changes, and know how to reverse every write.',
  content: `Write safety

Before any lock/unlock, portal-state, unlock-window, or destructive call:
name the exact target -- the door, record, or group being changed -- and the
effect the call will have, in plain language, before making it. Then wait for
the user's explicit yes before calling the tool; do not proceed on an
ambiguous or implied go-ahead.

For anything beyond an immediate, one-off need, prefer the scheduled
composite tools over a raw unlock_portal/lock_portal or an Extended Unlock:
the controller enforces a scheduled window itself, with nothing needing to
stay alive to relock the doors, and it is far easier to reason about and
reverse than a manually-tracked standing change.

Know how to reverse what you are about to do, and say so before doing it:
lock_portal reverses unlock_portal (and reverses an Extended Unlock
generally); a momentary or dog-on-next-exit action self-reverses. Reverse a
scheduled window through its matching cancel_unlock_window or
cancel_daily_unlock_window composite tool, never by deleting the underlying
holiday/time-spec objects by hand -- the cancel tools know which objects are
managed and clean them up correctly.`,
};
