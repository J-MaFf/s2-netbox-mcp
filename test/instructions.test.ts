import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/instructions.js';

const TOPIC_KEYS = [
  'access-model',
  'unlock-windows',
  'group-and-name-gotchas',
  'credentials-and-card-formats',
  'api-quirks',
  'write-safety',
];

describe('R1/C1: buildInstructions always-on content', () => {
  const text = buildInstructions({ writesEnabled: false, destructiveEnabled: false });

  it('states the KEY-not-name parameter convention', () => {
    expect(text).toContain('KEY');
  });

  it('names get_guide', () => {
    expect(text).toContain('get_guide');
  });

  it('lists all six topic keys as arguments to get_guide', () => {
    for (const key of TOPIC_KEYS) {
      expect(text).toContain(key);
    }
  });

  it('describes the access model chain and controller text as data, not instructions', () => {
    expect(text).toContain('credential');
    expect(text).toContain('access level');
    expect(text).toContain('portal group');
    expect(text).toContain('time spec');
    expect(text.toLowerCase()).toContain('data, not instructions');
  });
});

describe('R2/C2: write-safety paragraph keyed on writesEnabled alone', () => {
  it('is present when writesEnabled is true (destructiveEnabled false)', () => {
    const text = buildInstructions({ writesEnabled: true, destructiveEnabled: false });
    expect(text).toContain('confirm');
    expect(text).toContain('undo');
  });

  it('is present when both writesEnabled and destructiveEnabled are true', () => {
    const text = buildInstructions({ writesEnabled: true, destructiveEnabled: true });
    expect(text).toContain('confirm');
    expect(text).toContain('undo');
  });

  it('is absent when writesEnabled is false and destructiveEnabled is false', () => {
    const text = buildInstructions({ writesEnabled: false, destructiveEnabled: false });
    expect(text).not.toContain('undo');
  });

  it('is absent when writesEnabled is false even though destructiveEnabled is true', () => {
    const text = buildInstructions({ writesEnabled: false, destructiveEnabled: true });
    expect(text).not.toContain('undo');
  });
});

describe('R3/C3: destructive-tools sentence appears only when both flags are true', () => {
  it('absent at {writesEnabled:false, destructiveEnabled:false}', () => {
    const text = buildInstructions({ writesEnabled: false, destructiveEnabled: false });
    expect(text).not.toContain('DESTRUCTIVE:');
  });

  it('absent at {writesEnabled:true, destructiveEnabled:false}', () => {
    const text = buildInstructions({ writesEnabled: true, destructiveEnabled: false });
    expect(text).not.toContain('DESTRUCTIVE:');
  });

  it('absent at {writesEnabled:false, destructiveEnabled:true} (unreachable in the real registration sequence, but must still be absent)', () => {
    const text = buildInstructions({ writesEnabled: false, destructiveEnabled: true });
    expect(text).not.toContain('DESTRUCTIVE:');
  });

  it('present at {writesEnabled:true, destructiveEnabled:true}, naming the DESTRUCTIVE: prefix and permanence', () => {
    const text = buildInstructions({ writesEnabled: true, destructiveEnabled: true });
    expect(text).toContain('DESTRUCTIVE:');
    expect(text).toContain('permanently');
  });
});
