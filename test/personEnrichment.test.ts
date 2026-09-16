import { describe, expect, it } from 'vitest';
import { enrichWithPersonNames } from '../src/personEnrichment.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NetboxClient } from '../src/netboxClient.js';

/**
 * Unit tests for the shared person-name enrichment helper extracted from
 * `readerAccessHistory.ts` (see `specs/archive/get-access-history-resolve-names.md`
 * R5/R6) — used by both `get_reader_access_history` and
 * `get_access_history`'s `RESOLVENAMES: true` path.
 */

interface TestRecord {
  PERSONID: string;
  LOGID: string;
}

function record(personId: string, logId: string): TestRecord {
  return { PERSONID: personId, LOGID: logId };
}

describe('enrichWithPersonNames (R5)', () => {
  it('calls GetPerson exactly once per distinct non-empty PERSONID, never once per record', async () => {
    const calls: Array<{ command: string; params: unknown }> = [];
    const client = {
      call: async (command: string, params: unknown) => {
        calls.push({ command, params });
        const personId = (params as { PERSONID: string }).PERSONID;
        return {
          notFound: false,
          data: { PERSONID: personId, FIRSTNAME: `First${personId}`, LASTNAME: `Last${personId}`, NOTES: `Notes${personId}` },
        };
      },
    } as unknown as NetboxClient;

    // 3 records, 2 distinct PERSONIDs ('1' appears twice).
    const records = [record('1', 'a'), record('2', 'b'), record('1', 'c')];
    const result = await enrichWithPersonNames(client, records);

    const personCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON);
    expect(personCalls).toHaveLength(2);
    expect(result).toEqual([
      expect.objectContaining({ LOGID: 'a', FIRSTNAME: 'First1', LASTNAME: 'Last1', FULLNAME: 'First1 Last1', NOTES: 'Notes1' }),
      expect.objectContaining({ LOGID: 'b', FIRSTNAME: 'First2', LASTNAME: 'Last2', FULLNAME: 'First2 Last2', NOTES: 'Notes2' }),
      expect.objectContaining({ LOGID: 'c', FIRSTNAME: 'First1', LASTNAME: 'Last1', FULLNAME: 'First1 Last1', NOTES: 'Notes1' }),
    ]);
  });

  it("a record whose PERSONID is the empty string gets empty-string fields with zero GetPerson calls made for it", async () => {
    const calls: Array<{ command: string; params: unknown }> = [];
    const client = {
      call: async (command: string, params: unknown) => {
        calls.push({ command, params });
        throw new Error('GetPerson should never be called for an empty PERSONID');
      },
    } as unknown as NetboxClient;

    const result = await enrichWithPersonNames(client, [record('', 'a')]);

    expect(calls).toHaveLength(0);
    expect(result).toEqual([{ PERSONID: '', LOGID: 'a', FIRSTNAME: '', LASTNAME: '', FULLNAME: '', NOTES: '' }]);
  });

  it('a GetPerson failure (thrown error) for one PERSONID yields empty-string fields for that PERSONID only, without throwing or affecting other PERSONIDs', async () => {
    const client = {
      call: async (_command: string, params: unknown) => {
        const personId = (params as { PERSONID: string }).PERSONID;
        if (personId === 'bad') throw new NbapiFailError('NOT PERMITTED');
        return { notFound: false, data: { PERSONID: personId, FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: 'VIP' } };
      },
    } as unknown as NetboxClient;

    const result = await enrichWithPersonNames(client, [record('bad', 'a'), record('good', 'b')]);

    expect(result).toEqual([
      expect.objectContaining({ LOGID: 'a', PERSONID: 'bad', FIRSTNAME: '', LASTNAME: '', FULLNAME: '', NOTES: '' }),
      expect.objectContaining({ LOGID: 'b', PERSONID: 'good', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', FULLNAME: 'Joey Maffiola', NOTES: 'VIP' }),
    ]);
  });

  it('a GetPerson not-found-shaped result also yields empty-string fields without throwing', async () => {
    const client = {
      call: async () => ({ notFound: true, data: undefined }),
    } as unknown as NetboxClient;

    const result = await enrichWithPersonNames(client, [record('x', 'a')]);

    expect(result).toEqual([expect.objectContaining({ FIRSTNAME: '', LASTNAME: '', FULLNAME: '', NOTES: '' })]);
  });
});

describe('enrichWithPersonNames FULLNAME computation (R6)', () => {
  it("FULLNAME is the empty string when both FIRSTNAME and LASTNAME are empty", async () => {
    const client = {
      call: async () => ({ notFound: false, data: { FIRSTNAME: '', LASTNAME: '', NOTES: '' } }),
    } as unknown as NetboxClient;

    const [enriched] = await enrichWithPersonNames(client, [record('1', 'a')]);

    expect(enriched.FULLNAME).toBe('');
  });

  it('FULLNAME is the non-empty name alone (no extra whitespace) when exactly one of FIRSTNAME/LASTNAME is empty', async () => {
    const client = {
      call: async () => ({ notFound: false, data: { FIRSTNAME: '', LASTNAME: 'Maffiola', NOTES: '' } }),
    } as unknown as NetboxClient;

    const [enriched] = await enrichWithPersonNames(client, [record('1', 'a')]);

    expect(enriched.FULLNAME).toBe('Maffiola');
  });

  it('FULLNAME is "FIRSTNAME LASTNAME" (single space) when both are non-empty', async () => {
    const client = {
      call: async () => ({ notFound: false, data: { FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: '' } }),
    } as unknown as NetboxClient;

    const [enriched] = await enrichWithPersonNames(client, [record('1', 'a')]);

    expect(enriched.FULLNAME).toBe('Joey Maffiola');
  });
});
