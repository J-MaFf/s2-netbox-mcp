import type { GuideTopic } from './types.js';

/**
 * R6 (group-and-name-gotchas): modify_portal_group/modify_reader_group
 * replace the full membership list rather than merging, and
 * modify_access_level always requires TIMESPECGROUPKEY. Generic S2 NetBox
 * domain knowledge only.
 */
export const groupAndNameGotchasTopic: GuideTopic = {
  title: 'Group and name gotchas',
  summary:
    'modify_portal_group/modify_reader_group replace membership wholesale, and modify_access_level always needs TIMESPECGROUPKEY.',
  content: `Group and name gotchas

modify_portal_group and modify_reader_group both replace the group's
entire membership list with whatever key list is sent on that call -- they
do not merge or append. Omitting the key list (or sending an empty one)
empties the group instead of leaving its existing membership unchanged.
Always send the complete desired membership on every call to either tool,
never just the delta you intend to add or remove; read the group's
current members first if you need to add to or remove from an existing
list rather than replace it outright.

modify_access_level requires TIMESPECGROUPKEY on every call, even when the
change being made has nothing to do with the access level's schedule --
changing only the name or another unrelated field still needs the current
TIMESPECGROUPKEY resent, or the call is rejected. Read the access level first
if you don't already have its TIMESPECGROUPKEY at hand.`,
};
