import type { GuideTopic } from './types.js';

/**
 * R6 (credentials-and-card-formats): BIT MISMATCH diagnosis, the NBAPI's
 * inability to report a card format's enabled/disabled state, and
 * remove_person's soft-delete behavior. Generic S2 NetBox domain knowledge
 * only.
 */
export const credentialsAndCardFormatsTopic: GuideTopic = {
  title: 'Credentials and card formats',
  summary:
    'Diagnosing a BIT MISMATCH access-denied event, and remove_person as a soft delete rather than an erasure.',
  content: `Credentials and card formats

A BIT MISMATCH access-denied event means a presented card's bit length
matched no enabled credential format on the controller -- the reader read the
card fine, but nothing in the configured format list is willing to decode a
card of that length. This is a card-format configuration problem, not a
person/access-level problem.

The NBAPI has no command that reports whether a given credential format is
currently enabled or disabled -- get_card_formats lists the formats that
exist, but not which of them are turned on. Diagnosing a BIT MISMATCH
therefore needs the NetBox web UI's Activity Log (or the format configuration
screen itself), not the NBAPI tools alone -- tell the user to check there
rather than trying to infer an enabled/disabled state from an NBAPI response.

remove_person is a soft delete: the person record is not erased. It persists
with DELETED set, and remains visible via get_person -- a lookup against that
same PERSONID still returns the record, now carrying DELETED, rather than
coming back not-found.`,
};
