#!/usr/bin/env node
// Offline contract check for the local staging app launcher (docs/build-plan/19-local-app-staging-launcher.md):
// scripts/run-app-staging.mjs must stay in step with app/server/config.ts, pipeline/src/target-guard.ts and the doc.
// Text-level; no dependencies, no network, no database.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
need(/JSON\.parse\(maskLine\(line, targets\)\)/.test(src) && /return maskLine\(JSON\.stringify\(out\), targets\)/.test(src) && /jsonEscaped/.test(src) && /encodeURIComponent/.test(src) && /\[\$\{c\.toLowerCase\(\)\}\$\{c\.toUpperCase\(\)\}\]/.test(src), 'launcher must keep masking as a second layer: the raw line before parsing and the final line, including JSON-escaped, URL-encoded (any hex case) forms');
// Chunk boundaries: one StringDecoder per stream, never a per-chunk toString.
need(/new StringDecoder\('utf8'\)/.test(src) && /decoder\.write\(chunk\)/.test(src) && !/chunk\.toString\(/.test(src), 'launcher must decode each stream with one StringDecoder (a multibyte character can be split across chunks)');
// The output gate is an ALLOW-LIST of the app's own events (derived from the app source), with no free-text field.
const launcher = await import(pathToFileURL(resolve(root, 'scripts/run-app-staging.mjs')).href);
const events = launcher.APP_LOG_EVENTS;
need(events !== undefined && launcher.FIELD_PATTERNS !== undefined, 'launcher must export APP_LOG_EVENTS and FIELD_PATTERNS');
need(!/MAX_VALUE|typeof v === 'string' \?/.test(src), 'launcher must not accept arbitrary strings up to a length cap');
need(/has\(APP_LOG_EVENTS, obj\.event\)/.test(src) && /bad > 0/.test(src) && /fieldOk\(spec\[k\], obj\[k\]\)/.test(src) && /AT = \/\^\\d\{4\}/.test(src), 'launcher must withhold any line whose event, field or value is not on the allow-list');
const PATTERN_NAMES = new Set(['uuid', 'route']);
for (const [event, fields] of Object.entries(events ?? {})) {
  need(/^[a-z][a-z0-9_]{0,60}$/.test(event), 'allow-list event name is not a plain lowercase name: ' + event);
  for (const [name, spec] of Object.entries(fields)) {
    const kinds = Object.keys(spec);
    const label = event + '.' + name;
    need(kinds.length === 1 && ['enum', 'int', 'pattern'].includes(kinds[0]), 'allow-list field ' + label + ' is not an enum, a bounded integer or a named pattern (free text is not allowed)');
    if (kinds[0] === 'enum') need(Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((v) => /^[a-z_]{1,40}$/.test(v)), 'allow-list enum ' + label + ' must be fixed lowercase category words');
    if (kinds[0] === 'int') need(Number.isInteger(spec.int) && spec.int <= 3_600_000, 'allow-list integer ' + label + ' must have a small maximum');
    if (kinds[0] === 'pattern') {
      need(PATTERN_NAMES.has(spec.pattern), 'allow-list pattern ' + label + ' is not a known tight pattern');
      const re = launcher.FIELD_PATTERNS[spec.pattern];
      need(re instanceof RegExp && re.source.startsWith('^') && re.source.endsWith('$') && !/\.\*|\.\+|\\S|\\w\+|\\w\*|\[\^/.test(re.source), 'allow-list pattern ' + spec.pattern + ' must be anchored and must not allow free text');
      need(re instanceof RegExp && !re.test('a free text sentence with spaces') && !re.test('Zm9vYmFyYmF6'), 'allow-list pattern ' + spec.pattern + ' accepts free text');
    }
  }
}
// Re-derive the events and field names from the app's own log(...) calls; both directions must match.
const serverFiles = [];
const walk = (dir) => { for (const f of readdirSync(resolve(root, dir))) { const rel = dir + '/' + f; if (statSync(resolve(root, rel)).isDirectory()) { if (f !== 'testing') walk(rel); } else if (rel.endsWith('.ts') && !/\.test\.ts$/.test(rel)) serverFiles.push(rel); } };
walk('app/server');
const derived = new Map();
const serverSource = serverFiles.map((f) => code(read(f))).join('\n');
for (const m of serverSource.matchAll(/\b(?:log|consoleLogger)\(\s*'([a-z_]+)'(?:\s*,\s*\{([^}]*)\})?\s*\)/g)) {
  const set = derived.get(m[1]) ?? new Set();
  for (const part of (m[2] ?? '').split(',')) { const n = /^\s*([A-Za-z_]+)/.exec(part)?.[1]; if (n) set.add(n); }
  derived.set(m[1], set);
}
// A spread (`...extra`) or a non-literal field object hides field names from this check: refuse it instead of skipping it.
for (const m of serverSource.matchAll(/\b(?:log|consoleLogger)\(\s*'([a-z_]+)'\s*,\s*\{([^}]*)\}/g)) {
  need(!m[2].includes('...'), 'app log call for event ' + m[1] + ' spreads fields (...); list every field by name so the allow-list can be checked');
}
for (const m of serverSource.matchAll(/\b(?:log|consoleLogger)\(\s*'([a-z_]+)'\s*,\s*(?![\s{])/g)) {
  need(false, 'app log call for event ' + m[1] + ' passes fields that are not an object literal; list every field by name so the allow-list can be checked');
}
need(/\.replace\(\/\\r\$\/, ''\)/.test(src), 'launcher must strip a trailing CR before matching a config-error line (Windows CRLF)');
need(/existsSync\(resolve\(appDir, 'dist', 'index\.html'\)\)/.test(src), 'launcher must refuse when app/dist/index.html is not built');
need(derived.size >= 10,'could not derive the app log events from app/server (found ' + derived.size + ')');
for (const [event, fields] of derived) {
  need(events !== undefined && Object.prototype.hasOwnProperty.call(events, event), 'the app logs event ' + event + ' but the launcher allow-list lacks it (it would be withheld)');
  if (events && events[event]) need([...fields].sort().join() === Object.keys(events[event]).sort().join(), 'event ' + event + ': app fields (' + [...fields].sort().join() + ') differ from the allow-list (' + Object.keys(events[event]).sort().join() + ')');
}
for (const event of Object.keys(events ?? {})) need(derived.has(event), 'the allow-list names event ' + event + ' that the app never logs');
// Category enums must equal the category literals found in the source.
const categorySource = new Set([...serverSource.matchAll(/category: '([a-z_]+)'/g)].map((m) => m[1]));
for (const m of read('app/server/mail/adapter.ts').matchAll(/operatorAlertFor\([^)]*\): ([^{]*)\{/g)) for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) categorySource.add(lit[1]);
const categoryEnum = new Set(events?.operator_alert?.category?.enum ?? []);
need([...categorySource].sort().join() === [...categoryEnum].sort().join(), 'operator_alert categories in the app (' + [...categorySource].sort().join() + ') differ from the allow-list (' + [...categoryEnum].sort().join() + ')');
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
// The Supabase root is pinned with its fingerprint, checked at use, and there is no way around it.
const rootCa = read('pipeline/src/supabase-root-ca.ts');
const dbTls = read('pipeline/src/db-tls.ts');
const PIN_SHA = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
const pinList = /export const SUPABASE_ROOT_CAS[^=]*= Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(rootCa)?.[1] ?? '';
need(pinList.includes(`sha256: '${PIN_SHA}'`) && (pinList.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length === 1 && pinList.includes('-----END CERTIFICATE-----'), 'supabase-root-ca.ts must pin exactly one certificate with the Supabase Root 2021 CA SHA-256');
need(rootCa.includes('prod-ca-2021.crt') && rootCa.includes('2026-11-03') && /NOT checked: production/.test(rootCa), 'supabase-root-ca.ts must record the provenance and that production was not checked');
need(/cert\.fingerprint256 !== pin\.sha256\.toUpperCase\(\)/.test(dbTls) && /throw invalid/.test(dbTls) && /rejectUnauthorized: true/.test(dbTls) && !/rejectUnauthorized: false/.test(code(dbTls)), 'db-tls.ts must check the pinned fingerprint (fail closed) and never set rejectUnauthorized false');
need(/blocks\.length !== 1 \|\| blocks\[0\] !== '-----BEGIN CERTIFICATE-----'/.test(dbTls) && /const pem = cert\.toString\(\)/.test(dbTls) && /return pem;/.test(dbTls) && !/return pin\.pem/.test(dbTls), 'db-tls.ts must allow one plain CERTIFICATE block only and hand TLS the re-encoded checked certificate, not the raw text');
need(/SUPABASE_ROOT_CAS[^=]*= Object\.freeze\(\[\s*Object\.freeze\(\{/.test(rootCa), 'supabase-root-ca.ts must freeze the pin list and its entries');
// The two certificate files: no process, env or file access of any form, no dynamic import or require, and exactly the known imports.
const noExternalInput = /\bprocess\b|\benv\b|\bglobalThis\b|\brequire\b|createRequire|getBuiltinModule|\bimport\s*\(|\bimport\.meta\b|NODE_EXTRA_CA_CERTS|\breadFile|\bopenSync\b|\bfs\b|\bnode:fs/;
const importsOf = (src) => [...code(src).matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]).sort().join();
need(!noExternalInput.test(code(rootCa)) && !noExternalInput.test(code(dbTls)), 'db-tls.ts and supabase-root-ca.ts must not read process.env or any file: the pinned root has no external override');
need(importsOf(rootCa) === '' && importsOf(dbTls) === ['./supabase-root-ca.js', 'node:crypto', 'node:net', 'node:tls'].sort().join(), 'supabase-root-ca.ts must import nothing, and db-tls.ts only node:crypto, node:net, node:tls and ./supabase-root-ca.js');
const pgSecure = read('pipeline/src/pg-secure.ts');
need(/ALLOWED_EXTRA_OPTIONS/.test(pgSecure) && /checkedExtra\(extra\)/.test(pgSecure) && (pgSecure.match(/checkedExtra\(extra\)/g) ?? []).length === 2 && !/\.\.\.extra\b/.test(pgSecure), 'pg-secure.ts must allow-list the extra options of both helpers (no connectionString, ssl, host or port override)');
need(/'keepAlive', 'keepAliveInitialDelayMillis'\]/.test(pgSecure) && /key === 'keepAlive' && typeof value !== 'boolean'\) refuseOverride\(\)/.test(pgSecure)
  && /key === 'keepAliveInitialDelayMillis' && \(typeof value !== 'number' \|\| !Number\.isSafeInteger\(value\) \|\| value < 0 \|\| value > MAX_KEEPALIVE_INITIAL_DELAY_MS\)\) refuseOverride\(\)/.test(pgSecure) && /MAX_KEEPALIVE_INITIAL_DELAY_MS = 600_000;/.test(pgSecure),
  'pg-secure.ts must allow keepAlive only as a boolean and keepAliveInitialDelayMillis only as a whole number 0 to 600000');
// Staging-2 only through the session pooler (TRUCKRECRU-49): one rule (target-guard.ts isStaging2PoolerAddress) and one refusal
// (staging2-pooler.ts, no pg import so the app can use it), applied by the launcher, the app's Database and every pipeline client.
const poolerGuard = read('pipeline/src/staging2-pooler.ts');
const appDb = read('app/server/db/database.ts');
need(importsOf(poolerGuard) === ['./db-tls.js', './refusals.js', './target-guard.js'].sort().join() && /namesRebuiltStaging\(target\) && !isStaging2PoolerAddress\(target\)/.test(poolerGuard) && /'staging2_pooler_required'/.test(poolerGuard), 'staging2-pooler.ts must hold the one staging-2 pooler refusal (isStaging2PoolerAddress, staging2_pooler_required) and import only db-tls, refusals and target-guard');
need(/from '\.\.\/pipeline\/src\/target-guard\.ts'/.test(src) && /if \(!isStaging2PoolerAddress\(target\)\) throw new Error\('refusing \(staging2_pooler_required\): [^'$`]*'\)/.test(src), 'launcher must refuse a non-pooler staging-2 DATABASE_URL with the shared isStaging2PoolerAddress rule, id staging2_pooler_required, fixed text');
need(/from '\.\.\/\.\.\/\.\.\/pipeline\/src\/staging2-pooler'/.test(appDb) && /refuseStaging2UnlessPooler\(target\);/.test(appDb) && appDb.indexOf('refuseStaging2UnlessPooler(target);') < appDb.indexOf('new pg.Pool('), 'app Database must call refuseStaging2UnlessPooler before it builds its pg.Pool');
need(/from '\.\/staging2-pooler\.js'/.test(pgSecure) && /securePgConfig\(target: PgTargetFields\): pg\.ClientConfig \{\n  refuseStaging2UnlessPooler\(target\);/.test(pgSecure), 'pg-secure.ts securePgConfig must call refuseStaging2UnlessPooler first');
need(doc.includes(PIN_SHA) && doc.includes('Production has NOT been checked') && doc.includes('prod-ca-2021.crt') && !doc.includes('No root is pinned yet'), 'doc 19 must record the pinned fingerprint, its provenance and that production is unchecked');
// Tests cover every refusal; the doc carries the names and the command.
for (const phrase of ['only the staging Doppler scope', 'is missing or empty', 'production project', 'does not target the recorded staging-2', 'recruiter_app login', 'session-mode port', 'EMAIL_MODE must be test', 'HOST must be 127', 'SendGrid', '<masked>', 'staging2_pooler_required']) {
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
