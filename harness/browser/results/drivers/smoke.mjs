// What the smoke drivers share: recording checks and steps, and deciding whether the run passed.
// Kept apart from the drivers so smoke.test.mjs can hold it to that without a browser.
import { writeFileSync } from 'node:fs';

// VideoSync.status().members is a count (client/core/src/app/bootstrap.ts), not a list. Read it
// and nothing else: the rest of status() is full of digits (a mediaKey on 127.0.0.1, positions,
// stats counters), so matching the serialised status passes whatever the roster says.
export const memberCount = (st) => (typeof st?.members === 'number' ? st.members : null);

// smokeRun(file, meta) -> { out, check, step, main }. main(body) runs the driver's steps and
// returns the exit code. It writes `file` whatever happens, so a step that throws keeps the
// checks and steps before it (and the error) instead of losing the run, and the code is non-zero
// when any check failed, none ran, or a step threw: printing "9/10 passed" and exiting 0 lets a
// `&&` chain or a wrapper count a failed run as a pass (the same defect F64 fixed in probe-laftel).
export function smokeRun(file, meta, con = console) {
  const out = { when: new Date().toISOString(), ...meta, checks: [], steps: [] };
  const check = (name, ok, detail) => {
    out.checks.push({ name, ok: !!ok, detail });
    con.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
  };
  const step = (s) => {
    out.steps.push({ t: new Date().toISOString(), ...s });
    con.log('  ', JSON.stringify(s).slice(0, 400));
  };
  async function main(body) {
    let threw = false;
    try {
      await body();
    } catch (e) {
      threw = true;
      out.error = String(e?.stack ?? e);
      con.error(e);
    } finally {
      writeFileSync(file, JSON.stringify(out, null, 1));
    }
    const passed = out.checks.filter((c) => c.ok).length;
    con.log(`\n${passed}/${out.checks.length} passed${threw ? ' (aborted)' : ''}`);
    return threw || out.checks.length === 0 || passed < out.checks.length ? 1 : 0;
  }
  return { out, check, step, main };
}
