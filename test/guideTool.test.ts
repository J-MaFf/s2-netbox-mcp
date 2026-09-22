import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGuideTool } from '../src/tools/guide.js';
import { GUIDE_TOPICS } from '../src/guide/index.js';
import { FakeServer, byName } from './testUtils.js';

const TOPIC_KEYS = [
  'access-model',
  'unlock-windows',
  'group-and-name-gotchas',
  'credentials-and-card-formats',
  'api-quirks',
  'write-safety',
];

describe('R5/C5: GUIDE_TOPICS structure', () => {
  it('has exactly the six documented keys', () => {
    expect(Object.keys(GUIDE_TOPICS).sort()).toEqual([...TOPIC_KEYS].sort());
  });

  it('every topic has a non-empty title, summary, and content', () => {
    for (const key of TOPIC_KEYS) {
      const topic = GUIDE_TOPICS[key];
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.summary.length).toBeGreaterThan(0);
      expect(topic.content.length).toBeGreaterThan(0);
    }
  });
});

describe('R6/C6: topic content requirements', () => {
  it('access-model: person -> credential -> access level -> access level group chain, and the portal-group/time-spec-group name collision', () => {
    const { content } = GUIDE_TOPICS['access-model'];
    expect(content).toContain('credential');
    expect(content).toContain('access level group');
    expect(content).toContain('portal group');
    expect(content).toContain('time spec group');
    expect(content).toContain('share one name table');
    expect(content).toContain('collide');
  });

  it('unlock-windows: the holiday/time-spec/portal-group UNLOCKTIMESPECGROUPKEY recipe, date/time inclusivity, and the composite tools', () => {
    const { content } = GUIDE_TOPICS['unlock-windows'];
    expect(content).toContain('UNLOCKTIMESPECGROUPKEY');
    expect(content).toContain('STARTDATE');
    expect(content).toContain('inclusive');
    expect(content).toContain('ENDDATE');
    expect(content).toContain('exclusive');
    expect(content).toContain('ENDTIME');
    expect(content).toContain('schedule_unlock_window');
    expect(content).toContain('cancel_unlock_window');
    expect(content).toContain('schedule_daily_unlock_window');
    expect(content).toContain('cancel_daily_unlock_window');
  });

  it('group-and-name-gotchas: modify_portal_group/modify_reader_group replace membership wholesale; modify_access_level always needs TIMESPECGROUPKEY', () => {
    const { content } = GUIDE_TOPICS['group-and-name-gotchas'];
    expect(content).toContain('modify_portal_group');
    expect(content).toContain('modify_reader_group');
    expect(content).toContain('replace');
    expect(content).toContain('empties the group');
    expect(content).toContain('modify_access_level');
    expect(content).toContain('TIMESPECGROUPKEY');
  });

  it('credentials-and-card-formats: BIT MISMATCH diagnosis, the NBAPI/Activity Log limitation, and remove_person as a soft delete', () => {
    const { content } = GUIDE_TOPICS['credentials-and-card-formats'];
    expect(content).toContain('BIT MISMATCH');
    expect(content).toContain('credential format');
    expect(content).toContain('Activity Log');
    expect(content).toContain('remove_person');
    expect(content).toContain('DELETED');
    expect(content).toContain('get_person');
  });

  it('api-quirks: STARTFROMKEY/NEXTKEY paging, the missing singular get_portal, and the SUCCESS check', () => {
    const { content } = GUIDE_TOPICS['api-quirks'];
    expect(content).toContain('STARTFROMKEY');
    expect(content).toContain('NEXTKEY');
    expect(content).toContain('get_portal');
    expect(content).toContain('get_portals');
    expect(content).toContain('find_portals');
    expect(content).toContain('SUCCESS');
  });

  it('write-safety: name the target/effect, wait for an explicit yes, prefer scheduled tools, and how to reverse', () => {
    const { content } = GUIDE_TOPICS['write-safety'];
    expect(content).toContain('explicit yes');
    expect(content).toContain('lock_portal reverses unlock_portal');
    expect(content).toContain('cancel_unlock_window');
    expect(content).toContain('cancel_daily_unlock_window');
  });

  it('none of the six topics contain any deny-listed site-specific literal', () => {
    for (const key of TOPIC_KEYS) {
      const { content } = GUIDE_TOPICS[key];
      expect(content).not.toContain('GRAND OPENING');
      expect(content).not.toContain('02OF01A');
    }
  });
});

describe('R7/C7, R8/C8: registerGuideTool', () => {
  it('registers exactly one tool, get_guide, taking only an optional topic string', () => {
    const server = new FakeServer();
    registerGuideTool(server as unknown as McpServer);
    expect(server.registrations.map((r) => r.name)).toEqual(['get_guide']);
    const reg = byName(server, 'get_guide');
    expect(Object.keys(reg.schema)).toEqual(['topic']);
  });

  it('description names all six topic keys and states it makes no controller call', () => {
    const server = new FakeServer();
    registerGuideTool(server as unknown as McpServer);
    const reg = byName(server, 'get_guide');
    for (const key of TOPIC_KEYS) {
      expect(reg.description).toContain(key);
    }
    expect(reg.description.toLowerCase()).toContain('no controller call');
  });

  it('a no-arg call returns the index: all six keys, their summaries, and a note that it is the index, not an error', async () => {
    const server = new FakeServer();
    registerGuideTool(server as unknown as McpServer);
    const reg = byName(server, 'get_guide');
    const result = await reg.handler({});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    for (const key of TOPIC_KEYS) {
      expect(text).toContain(key);
      expect(text).toContain(GUIDE_TOPICS[key].summary);
    }
    expect(text.toLowerCase()).toContain('index');
    expect(text.toLowerCase()).toContain('not an error');
  });

  it('an unrecognized topic returns the same index, not a thrown/error result', async () => {
    const server = new FakeServer();
    registerGuideTool(server as unknown as McpServer);
    const reg = byName(server, 'get_guide');
    const result = await reg.handler({ topic: 'not-a-real-topic' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    for (const key of TOPIC_KEYS) {
      expect(text).toContain(key);
    }
  });

  for (const key of TOPIC_KEYS) {
    it(`topic=${key} returns exactly that topic's content`, async () => {
      const server = new FakeServer();
      registerGuideTool(server as unknown as McpServer);
      const reg = byName(server, 'get_guide');
      const result = await reg.handler({ topic: key });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(GUIDE_TOPICS[key].content);
    });
  }
});
