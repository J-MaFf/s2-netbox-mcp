import type { GuideTopic } from './types.js';

/**
 * R6 (access-model): the person -> credential -> access level -> access
 * level group chain, plus the portal-group/time-spec-group name-table
 * collision gotcha. Generic S2 NetBox domain knowledge only -- no
 * deployment-specific portal codes, group keys, or naming schemes.
 */
export const accessModelTopic: GuideTopic = {
  title: 'Access model',
  summary:
    'How person, credential, access level, and group objects combine to grant WHAT/WHERE/WHEN access, and a name-table collision to watch for.',
  content: `Access model

A person holds one or more credentials. Each credential is tied to an access
level, and an access level belongs to one access level group. This chain --
person -> credential -> access level -> access level group -- determines WHAT
a person can access: which doors their credential is allowed to open at all.

Separately, a portal group and its time spec group determine WHERE and WHEN
that access is enforced: which physical doors are grouped together, and the
schedule (day of week, time of day, holiday) during which the group's access
is active. The WHAT axis and the WHERE/WHEN axis are independent inputs to
the same access decision -- a person can be permitted by their access level
and still be refused by the door's schedule, or vice versa.

One gotcha that spans both axes: portal groups and time spec groups
share one name table on the controller. A name already used by a portal
group cannot also be used by a time spec group, and vice versa -- the two
object types collide on name even though they are otherwise unrelated
tables. Keep this in mind when naming any portal group or time spec group
you create or manage.`,
};
