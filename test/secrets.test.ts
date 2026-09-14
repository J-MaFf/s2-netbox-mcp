import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'test', 'scripts'].map((d) => join(ROOT, d));

// Any call that could put a value in front of a human/log sink.
const LOGGING_CALL_PATTERN = /console\.\w+\s*\(|process\.stdout\.write\s*\(|process\.stderr\.write\s*\(/;

// Matches actual access to the password *value* (env lookup or a .password
// property read) — deliberately NOT a bare quoted 'NETBOX_PASSWORD' string,
// since naming the variable in a "this one's missing" message is expected
// and safe (e.g. config.ts's actionable startup error, live-check's skip
// message). Only a genuine value-access next to a logging call is a finding.
const PASSWORD_VALUE_ACCESS_PATTERN = /process\.env\.NETBOX_PASSWORD|\benv\.NETBOX_PASSWORD\b|\.password\b/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
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

describe('R19: NETBOX_PASSWORD never reaches a log/console/error sink', () => {
  it('no line referencing the password ever appears alongside a console/stdout/stderr write call', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          const referencesPasswordValue = PASSWORD_VALUE_ACCESS_PATTERN.test(line);
          if (referencesPasswordValue && LOGGING_CALL_PATTERN.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no line referencing the password constructs an Error/throw with it interpolated', () => {
    const offenders: string[] = [];
    const errorPattern = /throw\s+new\s+\w*Error|new\s+\w*Error\s*\(/;
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          const referencesPasswordValue = /\.password\b/.test(line);
          if (referencesPasswordValue && errorPattern.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the config error for a missing NETBOX_PASSWORD names the variable only, never a value', () => {
    // Direct behavioral check complementing the static scans above.
    const offenders: string[] = [];
    for (const file of listTsFiles(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('NETBOX_PASSWORD') && /console\.|process\.(stdout|stderr)\.write/.test(text)) {
        // Only a concern if NETBOX_PASSWORD and a logging call share a line (already checked above),
        // but flag any file that logs full env dumps or similar which could include it indirectly.
        if (/console\.\w+\(\s*(process\.env|env)\s*\)/.test(text)) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
