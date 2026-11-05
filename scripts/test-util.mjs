// TEST TOOLING ONLY (TRUCKRECRU-150): helpers shared by the scripts/*.test.mjs files. Never imported by product code.
// Undo: delete this file and put withPrivateTemp back into scripts/simulate-ci-jobs.test.mjs.

/**
 * Runs fn with TMPDIR/TEMP/TMP pointing at the folder `dir`, so a tool that lists os.tmpdir() (the simulator's ci-sim-* folders)
 * can only see this run's own entries; other processes on the PC use the shared temp folder at the same time.
 * The caller makes (and deletes) `dir`. The three variables are put back exactly as they were, also when fn throws.
 * os.tmpdir() reads them at call time, so it follows the change. Returns what fn returns.
 */
export function withPrivateTemp(dir, fn) {
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: dir, TEMP: dir, TMP: dir });
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
