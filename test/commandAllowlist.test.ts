import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NBAPI_COMMANDS } from '../src/commands.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const SCRIPTS_DIR = join(ROOT, 'scripts');

// R4: the exact 80-command closed set. Confined to src/commands.ts only.
const EXPECTED_COMMANDS = [
  // Session lifecycle + v0.2.0 reads (17)
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
  // Additional reads (18)
  'GetTimeSpec',
  'GetTimeSpecs',
  'GetTimeSpecGroup',
  'GetTimeSpecGroups',
  'GetHoliday',
  'GetHolidays',
  'GetPortalGroup',
  'GetPortalGroups',
  'GetReaderGroup',
  'GetReaderGroups',
  'GetOutputs',
  'GetAccessLevelNames',
  'GetPartitions',
  'GetUDFLists',
  'GetUDFListItems',
  'GetElevators',
  'GetFloors',
  'PingApp',
  // Actions (7)
  'ActivateOutput',
  'DeactivateOutput',
  'DogOnNextExitPortal',
  'LockPortal',
  'MomentaryUnlockPortal',
  'UnlockPortal',
  'SetThreatLevel',
  // Adds (10)
  'AddAccessLevel',
  'AddAccessLevelGroup',
  'AddHoliday',
  'AddPartition',
  'AddPortalGroup',
  'AddReaderGroup',
  'AddTimeSpec',
  'AddTimeSpecGroup',
  'AddThreatLevel',
  'AddThreatLevelGroup',
  // Deletes (7)
  'DeleteAccessLevel',
  'DeleteAccessLevelGroup',
  'DeleteHoliday',
  'DeletePortalGroup',
  'DeleteReaderGroup',
  'DeleteTimeSpec',
  'DeleteTimeSpecGroup',
  // Modifies (10)
  'ModifyAccessLevel',
  'ModifyAccessLevelGroup',
  'ModifyHoliday',
  'ModifyPortalGroup',
  'ModifyReaderGroup',
  'ModifyThreatLevel',
  'ModifyThreatLevelGroup',
  'ModifyTimeSpec',
  'ModifyTimeSpecGroup',
  'ModifyUDFListItems',
  // Removes (2)
  'RemoveThreatLevel',
  'RemoveThreatLevelGroup',
  // Person/credential writes (6)
  'AddCredential',
  'AddPerson',
  'ModifyCredential',
  'ModifyPerson',
  'RemoveCredential',
  'RemovePerson',
  // Events (2)
  'TriggerEvent',
  'InsertActivity',
  // Partition switch (1)
  'SwitchPartition',
];

// R4: the rewritten forbidden list — GetPicture, StreamEvents, GetPortal, and
// the seven deprecated commands. None of these may ever appear as a quoted
// literal anywhere in src/ or scripts/.
const FORBIDDEN_COMMAND_LITERALS = [
  'GetPicture',
  'StreamEvents',
  'GetPortal',
  'EditPerson',
  'EditThreatLevel',
  'EditThreatLevelGroup',
  'GetAccessDataLog',
  'GetAccessCardDetails',
  'LoginUserName',
  'LoginUserPassword',
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

describe('R4: 80-command NBAPI allowlist', () => {
  it('NBAPI_COMMANDS contains exactly the 80 documented commands, no more, no less', () => {
    const values = Object.values(NBAPI_COMMANDS).sort();
    expect(values).toEqual([...EXPECTED_COMMANDS].sort());
    expect(values).toHaveLength(80);
    expect(new Set(values).size).toBe(80); // no duplicates
  });

  it('no forbidden (out-of-scope/deprecated) command literal appears anywhere in src/ or scripts/', () => {
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

  it('every one of the 80 allowed command name literals is confined to src/commands.ts', () => {
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
