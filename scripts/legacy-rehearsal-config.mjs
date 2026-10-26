#!/usr/bin/env node
// Legacy rehearsal frontend (doc 16 section 1.3 step 7, approval 5): build configuration check and
// project-id proof. The backout returns users to the OLD app, so the rehearsal builds the
// pre-cutover SPA (the commit the current staging Worker serves, 353be1c) pointed at the NEW
// staging project, and proves that before M1 is applied.
//
//   node scripts/legacy-rehearsal-config.mjs config --new-ref=<20-letter ref>
//        Reads VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_EXPECTED_SUPABASE_REF and
//        VITE_APP_ENV from the environment and refuses anything that is not the new staging
//        project. Prints nothing secret (the anon key is never echoed).
//   node scripts/legacy-rehearsal-config.mjs prove <build-output-dir> --new-ref=<ref>
//        Searches every file of the built bundle: the new ref must be present, and neither the
//        old staging ref nor the production ref may appear anywhere; no service-role or secret
//        key may be embedded.
//
// Doc 16 proof (a) is the `prove` command; (b) the page header and (c) the fixture sign-in are
// operator steps in the browser.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Recorded project refs (repository constants, not secrets): pipeline/src/target-guard.ts.
export const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
export const OLD_STAGING_REF = 'yhyoxhtguyturgdhwywc';
const REF_PATTERN = /^[a-z]{20}$/;

export function checkNewRef(newRef) {
  if (!REF_PATTERN.test(newRef ?? '')) throw new Error('--new-ref must be a 20-letter Supabase project ref');
  if (newRef === PRODUCTION_REF) throw new Error('--new-ref is the production project; refusing');
  if (newRef === OLD_STAGING_REF) throw new Error('--new-ref is the OLD staging project; the rehearsal must point at the new one');
}

function jwtClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Returns a list of failure strings; empty means the build environment is acceptable. */
export function checkBuildEnv(env, newRef) {
  const failures = [];
  try {
    checkNewRef(newRef);
  } catch (err) {
    return [err.message];
  }
  if (env.VITE_SUPABASE_URL !== `https://${newRef}.supabase.co`) failures.push('VITE_SUPABASE_URL must be exactly https://<new ref>.supabase.co');
  if (env.VITE_EXPECTED_SUPABASE_REF !== newRef) failures.push('VITE_EXPECTED_SUPABASE_REF must equal the new ref');
  if (env.VITE_APP_ENV !== 'staging') failures.push('VITE_APP_ENV must be staging');
  const key = env.VITE_SUPABASE_ANON_KEY ?? '';
  if (!key) {
    failures.push('VITE_SUPABASE_ANON_KEY is missing');
  } else if (key.startsWith('sb_secret_')) {
    failures.push('VITE_SUPABASE_ANON_KEY is a secret key; only the public anon/publishable key may go in a frontend build');
  } else if (!key.startsWith('sb_publishable_')) {
    const claims = jwtClaims(key);
    if (!claims) failures.push('VITE_SUPABASE_ANON_KEY is neither a publishable key nor a JWT');
    else {
      if (claims.role !== 'anon') failures.push(`VITE_SUPABASE_ANON_KEY carries the role "${String(claims.role)}", not anon`);
      if (claims.ref !== undefined && claims.ref !== newRef) failures.push('VITE_SUPABASE_ANON_KEY belongs to a different project than the new ref');
    }
  }
  for (const name of Object.keys(env)) {
    if (/SERVICE_ROLE|SECRET/i.test(name) && name.startsWith('VITE_')) failures.push(`${name}: no secret may be a VITE_ build variable`);
  }
  return failures;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Searches a built bundle. Returns { filesScanned, filesWithNewRef, failures }. */
export function proveBundle(dir, newRef) {
  checkNewRef(newRef);
  const failures = [];
  let filesScanned = 0;
  let filesWithNewRef = 0;
  for (const path of walk(dir)) {
    const text = readFileSync(path).toString('latin1');
    filesScanned += 1;
    const rel = path.slice(dir.length + 1).replace(/\\/g, '/');
    if (text.includes(newRef)) filesWithNewRef += 1;
    if (text.includes(OLD_STAGING_REF)) failures.push(`${rel}: contains the OLD staging ref`);
    if (text.includes(PRODUCTION_REF)) failures.push(`${rel}: contains the production ref`);
    if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) failures.push(`${rel}: contains a secret key`);
    for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
      const claims = jwtClaims(match[0]);
      if (claims && claims.role && claims.role !== 'anon') failures.push(`${rel}: embeds a JWT with role "${String(claims.role)}"`);
      if (claims && claims.ref && claims.ref !== newRef) failures.push(`${rel}: embeds a JWT for a different project`);
    }
  }
  if (filesScanned === 0) failures.push('the build output directory is empty');
  else if (filesWithNewRef === 0) failures.push('the new ref does not appear anywhere in the bundle');
  return { filesScanned, filesWithNewRef, failures };
}

function main(argv) {
  const [mode, ...rest] = argv;
  const flag = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const newRef = flag('new-ref');
  if (mode === 'config') {
    const failures = checkBuildEnv(process.env, newRef);
    if (failures.length) {
      for (const f of failures) console.error(`FAIL ${f}`);
      process.exit(1);
    }
    console.log('PASS legacy rehearsal build environment points only at the new staging project');
    return;
  }
  if (mode === 'prove') {
    const dir = rest.find((a) => !a.startsWith('--'));
    if (!dir) throw new Error('usage: prove <build-output-dir> --new-ref=<ref>');
    const result = proveBundle(resolve(dir), newRef);
    if (result.failures.length) {
      for (const f of result.failures) console.error(`FAIL ${f}`);
      process.exit(1);
    }
    console.log(`PASS ${result.filesScanned} files scanned; new ref in ${result.filesWithNewRef}; no old staging ref, production ref or secret key`);
    return;
  }
  throw new Error('usage: config --new-ref=<ref> | prove <dir> --new-ref=<ref>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
