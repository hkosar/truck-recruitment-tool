#!/usr/bin/env node
// Offline contract check for the local staging app launcher (docs/build-plan/19-local-app-staging-launcher.md):
// scripts/run-app-staging.mjs must stay in step with app/server/config.ts, pipeline/src/target-guard.ts and the doc.
// Text-level; no dependencies, no network, no database.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (rel) => (existsSync(resolve(root, rel)) ? readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n') : '');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
const failures = [];
const need = (ok, msg) => { if (!ok) failures.push(msg); };

const raw = read('scripts/run-app-staging.mjs');
const src = code(raw);
const config = read('app/server/config.ts');
const guard = read('pipeline/src/target-guard.ts');
const doc = read('docs/build-plan/19-local-app-staging-launcher.md');
const test = read('scripts/run-app-staging.test.mjs');
need(raw !== '' && config !== '' && guard !== '' && doc !== '' && test !== '', 'launcher, its test, its doc, app config or target guard is missing');

// The names the app requires (no default) must all be in the launcher's list, and nothing else secret.
const requiredByApp = [...config.matchAll(/(?:required\(env, |key\()'([A-Z_]+)'\)/g)].map((m) => m[1]).filter((n) => !['APP_ORIGIN', 'SENDGRID_API_KEY', 'SENDGRID_FROM_ADDRESS'].includes(n));
const listed = /APP_SECRET_NAMES = \[([^\]]*)\]/.exec(src)?.[1].match(/'([A-Z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
need(listed.length === 4 && [...requiredByApp].sort().join() === [...listed].sort().join(), `launcher secret names (${listed.join()}) differ from the app's required names (${requiredByApp.join()})`);

// The forced settings.
need(/EMAIL_MODE: 'test'/.test(src) && /HOST: BIND_HOST/.test(src) && /BIND_HOST = '127\.0\.0\.1'/.test(src), 'launcher must force EMAIL_MODE=test and bind 127.0.0.1');
need(/TRUSTED_PROXY_HOPS: '0'/.test(src) && /STAGING_BANNER: 'true'/.test(src) && /APP_ORIGIN: `http:\/\/localhost:/.test(src), 'launcher must force APP_ORIGIN (localhost), TRUSTED_PROXY_HOPS 0 and STAGING_BANNER');
need(/env\.DOPPLER_PROJECT !== APP_STAGING_PROJECT \|\| env\.DOPPLER_CONFIG !== APP_STAGING_CONFIG/.test(src) && /APP_STAGING_PROJECT = 'truck-recruitment-tool'/.test(src) && /APP_STAGING_CONFIG = 'stg'/.test(src), 'launcher must require Doppler truck-recruitment-tool/stg');
// The target guard is reused, not copied, and production is never an option.
need(/from '\.\.\/pipeline\/src\/target-guard\.ts'/.test(src) && /parseSupabaseDbTarget\(env\.DATABASE_URL\)/.test(src) && /RECORDED_PROJECT_REFS\.stagingRebuilt/.test(src), 'launcher must reuse parseSupabaseDbTarget and RECORDED_PROJECT_REFS.stagingRebuilt');
need(!/ejrfobddnojbijzrjbii|yhyoxhtguyturgdhwywc|ojqtsftfclhxauhjwott/.test(src), 'launcher must not hard-code a project ref (it reads them from the target guard)');
need(/export const RECORDED_PROJECT_REFS/.test(guard) && /stagingRebuilt: REBUILT_STAGING_PROJECT_REF/.test(guard), 'target-guard must still export RECORDED_PROJECT_REFS.stagingRebuilt');
need(/APP_ROLE = 'recruiter_app'/.test(src) && /APP_DB_PORT = 5432/.test(src), 'launcher must require the recruiter_app login on port 5432');
// Masking is shared with the wrapper; the child gets a built environment, never the parent's.
need(/import \{ scrub \} from '\.\/run-with-secrets\.mjs'/.test(src) && !/maskTargets\(/.test(src), 'launcher must reuse the wrapper scrub but not its length-filtered maskTargets');
need(/export function launcherMaskTargets/.test(src) && /launcherMaskTargets\(childEnv\[n\]\)/.test(src) && !/length >= \d/.test(/function launcherMaskTargets[\s\S]*?\n}\n/.exec(src)?.[0] ?? 'length >= 4'), 'launcher must mask every secret with launcherMaskTargets, which has no minimum-length filter');
need(/MIN_MASKABLE_LENGTH = 8/.test(src) && /shorter than \$\{MIN_MASKABLE_LENGTH\} characters/.test(src), 'launcher must refuse a database password under 8 characters');
need(/JSON\.parse\(scrub\(line, targets\)\)/.test(src) && /scrub\(v, targets\)/.test(src) && /return scrub\(JSON\.stringify\(out\), targets\)/.test(src) && /jsonEscaped/.test(src) && /encodeURIComponent/.test(src), 'launcher must mask the raw line before parsing, each parsed value and the final line, including JSON-escaped and URL-encoded forms');
// Non-JSON lines: only the exact ConfigError messages of app/server/config.ts.
const configLiterals = [...config.matchAll(/new ConfigError\((?:'([A-Z_]+)'|name), ('[^']*'|"[^"]*")\)/g)].map((m) => [m[1], m[2].slice(1, -1)]);
const listedMessages = src.slice(src.indexOf('CONFIG_ERROR_MESSAGES = ['), src.indexOf('const CONFIG_ERROR_LINES'));
need(configLiterals.length >= 10, 'could not read the ConfigError literals of app/server/config.ts');
for (const [name, rule] of configLiterals) {
  if (name === undefined) continue; // required(): the 'is required' rule is checked per name below
  need(listedMessages.includes(rule), `launcher config-error list lacks the rule of ${name}: ${rule}`);
}
need(listedMessages.includes('is required') && /KEY_LINKS: the three keys must differ/.test(listedMessages), 'launcher config-error list lacks the is-required or the three-keys message');
need(!/\[A-Z\]\[A-Z0-9_\]\{2,40\}/.test(src) && /CONFIG_ERROR_LINES\.has\(line\)/.test(src), 'launcher must accept config-error lines only by exact match, not by pattern');
need(test.includes('finding 1') && test.includes('finding 2') && test.includes('finding 3'), 'tests must keep the regression cases for the three review findings');
need(/env: childEnv/.test(src) && !/env: process\.env/.test(src) && !/\.\.\.env\b/.test(src) && /shell: false/.test(src) && /stdio: \['ignore'/.test(src), 'child must get only the built environment, no shell, no stdin');
need(!/\bSENDGRID_[A-Z_]+'/.test(src.replace(/startsWith\('SENDGRID_'\)/, '')), 'launcher must not name or pass any SendGrid variable');
need(!/console\.log\([^)]*env|stdout\.write\([^)]*env\b/.test(src), 'launcher must not print environment values');
// No network or Doppler calls from the launcher itself.
need(!/\bfetch\(|node:https?|node:net|node:dns|\bdoppler\b.*spawn/i.test(src.replace(/Doppler|doppler/g, 'D')), 'launcher must not use the network');
// Tests cover every refusal; the doc carries the names and the command.
for (const phrase of ['only the staging Doppler scope', 'is missing or empty', 'production project', 'does not target the recorded staging-2', 'recruiter_app login', 'session-mode port', 'EMAIL_MODE must be test', 'HOST must be 127', 'SendGrid', '<masked>']) {
  need(test.includes(phrase), `test file does not cover: ${phrase}`);
}
for (const n of listed) need(doc.includes(`\`${n}\``), `doc 19 does not name ${n}`);
need(doc.includes('NOT RUN'), 'doc 19 must mark the launch command NOT RUN');
// Every launch command in the doc must use the scoped staging token prefix, never the full login.
const launchLines = doc.split('\n').filter((l) => l.includes('run-app-staging.mjs') && /\bdoppler\b/.test(l) && !l.startsWith('Launcher:'));
need(launchLines.length > 0, 'doc 19 shows no launch command');
for (const l of launchLines) {
  need(l.includes('--config-dir') && l.includes('--scope') && l.includes('--no-fallback') && l.includes('--no-read-env') && l.includes('--project truck-recruitment-tool --config stg'), `doc 19 launch command lacks --config-dir/--scope/--no-fallback: ${l.trim().slice(0, 60)}`);
}
need(/Secrets owner, only after Hunter's direct OK in the secrets chat/.test(doc) && doc.indexOf('doppler secrets set KEY_LINKS') > doc.indexOf("Secrets owner, only after Hunter's direct OK"), 'doc 19 must keep the KEY_* creation commands under the secrets-owner heading');

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('app staging launcher contract: OK');
