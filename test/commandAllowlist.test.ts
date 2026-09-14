import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NBAPI_COMMANDS } from '../src/commands.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const SCRIPTS_DIR = join(ROOT, 'scripts');

// Explicitly out-of-scope write/control commands and other deferred commands
// named in the spec (spec "Out of scope" section) plus their common Add/
// Modify/Delete/Remove family members for the resources this server reads.
// None of these strings may ever appear as a quoted literal anywhere in src/.
const FORBIDDEN_COMMAND_LITERALS = [
  'AddPerson',
  'ModifyPerson',
  'RemovePerson',
  'DeletePerson',
  'AddAccessLevel',
  'ModifyAccessLevel',
  'DeleteAccessLevel',
  'AddAccessLevelGroup',
  'ModifyAccessLevelGroup',
  'DeleteAccessLevelGroup',
  'LockPortal',
  'UnlockPortal',
  'MomentaryUnlockPortal',
  'ActivateOutput',
  'DeactivateOutput',
  'SetThreatLevel',
  'AddThreatLevel',
  'ModifyThreatLevel',
  'RemoveThreatLevel',
  'AddThreatLevelGroup',
  'ModifyThreatLevelGroup',
  'RemoveThreatLevelGroup',
  'TriggerEvent',
  'AddHoliday',
  'ModifyHoliday',
  'DeleteHoliday',
  'AddTimeSpec',
  'ModifyTimeSpec',
  'DeleteTimeSpec',
  'AddTimeSpecGroup',
  'ModifyTimeSpecGroup',
  'DeleteTimeSpecGroup',
  'AddCredential',
  'ModifyCredential',
  'RemoveCredential',
  'AddPartition',
  'SwitchPartition',
  'InsertActivity',
  'ModifyUDFListItems',
  'GetPicture',
  'StreamEvents',
  // Not a write/control command, but not a real NBAPI command either: only
  // the plural `GetPortals` exists (see spec Context / R10). Listed here as
  // a belt-and-suspenders guard against it ever being reintroduced.
  'GetPortal',
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('R10: read-only command allowlist', () => {
  it('NBAPI_COMMANDS contains exactly the 17 documented allowed commands (no GetPortal singular)', () => {
    const values = Object.values(NBAPI_COMMANDS).sort();
    const expected = [
      'Login',
      'Logout',
      'GetAPIVersion',
      'GetPerson',
      'SearchPersonData',
      'GetCardAccessDetails',
      'GetCardFormats',
      'GetAccessLevel',
      'GetAccessLevels',
      'GetAccessLevelGroup',
      'GetAccessLevelGroups',
      'GetPortals',
      'GetReader',
      'GetReaders',
      'GetEventHistory',
      'ListEvents',
      'GetAccessHistory',
    ].sort();
    expect(values).toEqual(expected);
    expect(values).toHaveLength(17);
    expect(values).not.toContain('GetPortal');
  });

  it('no forbidden write/control (or otherwise out-of-scope) command literal appears anywhere in src/ or scripts/', () => {
    const files = [...listTsFiles(SRC_DIR), ...listTsFiles(SCRIPTS_DIR)];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of FORBIDDEN_COMMAND_LITERALS) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`) || text.includes(`\`${name}\``)) {
          offenders.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every one of the 17 allowed command name literals is confined to src/commands.ts', () => {
    const files = [...listTsFiles(SRC_DIR), ...listTsFiles(SCRIPTS_DIR)].filter((f) => f !== join(SRC_DIR, 'commands.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of Object.values(NBAPI_COMMANDS)) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`) || text.includes(`\`${name}\``)) {
          offenders.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every client.call(...) site passes a NBAPI_COMMANDS.* constant, never a raw string literal', () => {
    const files = [...listTsFiles(SRC_DIR), ...listTsFiles(SCRIPTS_DIR)];
    const offenders: string[] = [];
    const callSitePattern = /\.call\(\s*(['"`])/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = callSitePattern.exec(text)) !== null) {
        offenders.push(`${relative(ROOT, file)} at offset ${match.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
