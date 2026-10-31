#!/usr/bin/env node
// Offline documentation guard only. No SQL, secrets or network access.
// This does not approve a live step or verify a hosted config, cron or candidate tool.
// The one subprocess is `git show <tip>:<path>` (read-only) to read the Route A runner source and the first-manager tool source at their reviewed tips.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Route A runner's reviewed tip ("missing-sql r2: ready"; branch bb/fix-draft-sql-findings-backouts-do-not-use-bo3-i-thr_8uxydx6hqr); never merged here. */
export const RUNNER_TIP = '7111139';
export const RUNNER_FILES = { prodSql: 'pipeline/src/prod-sql.ts', stagingRebuilt: 'pipeline/src/staging-rebuilt.ts', cli: 'pipeline/src/prod-sql-runner.ts', wrapper: 'scripts/run-with-secrets.mjs' };
/** The first-manager tool's reviewed commit ("fm-listener r2: ready"; branch bb/fix-first-manager-listener-output-commit-outcome-thr_q9ajbvqpa6, contained in signin/combined-reviewed-abc); never merged here. */
export const FM_TIP = '7285a7e';
export const FM_FILES = { bootstrap: 'pipeline/src/first-manager-bootstrap.ts', runner: 'pipeline/src/first-manager-runner.ts', wrapper: 'scripts/run-with-secrets.mjs' };
/** The only two actions the runner may refuse as DO NOT USE; the runbook may mention them but never as runnable. */
export const EXPECTED_DO_NOT_USE = ['profile-bootstrap-backout', 'dnc-enum-cast-backout'];

/** Parses the first-manager tool source: its two actions, typed phrases (production), states and result words. */
export function parseFirstManager(bootstrap, runner) {
  const actions = [...(bootstrap.match(/FIRST_MANAGER_ACTIONS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const check = bootstrap.match(/FIRST_MANAGER_CHECK_CONFIRMATION = '([^']+)'/)?.[1];
  const create = bootstrap.match(/FIRST_MANAGER_CREATE_CONFIRMATION[^=]*= \{[^}]*production: '([^']+)'/)?.[1];
  const states = [...(bootstrap.match(/FIRST_MANAGER_STATES = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const results = new Set([...bootstrap.matchAll(/msg: 'first-manager\.result', result: (?:'([a-z_]+)'|acknowledged \? '([a-z_]+)' : '([a-z_]+)')/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  const events = [...(bootstrap + runner).matchAll(/msg: 'first-manager\.([a-z_]+)'/g)].map((m) => m[1]);
  const phrases = new Map();
  if (check) phrases.set('first-manager-check', check);
  if (create) phrases.set('first-manager-create', create);
  return { actions, phrases, states, results, events, error: actions.length === 2 && check && create && states.length === 7 ? undefined : 'first-manager action table not found' };
}

/** Parses the runner source text: built actions with their typed phrases, the not-built ids, and the fixed warning sentences. */
export function parseRunner(prodSql, stagingRebuilt) {
  const built = new Map();
  const missing = new Set();
  const warnings = [];
  const doNotUse = [];
  const start = prodSql.indexOf('export const PROD_SQL_ACTIONS');
  const mid = prodSql.indexOf('export const PROD_SQL_MISSING');
  const end = prodSql.indexOf('];', mid);
  if (start < 0 || mid < start || end < mid) return { built, missing, doNotUse, warnings, stagingInventoryPhrase: undefined, error: 'runner action table not found' };
  const table = prodSql.slice(start, mid);
  const templated = /phrase: `RUN TNBS PRODUCTION SQL \$\{id\.toUpperCase\(\)\}`/.test(prodSql);
  for (const m of table.matchAll(/MIGRATION\('([a-z0-9-]+)'/g)) {
    if (templated) built.set(m[1], `RUN TNBS PRODUCTION SQL ${m[1].toUpperCase()}`);
  }
  for (const m of table.matchAll(/\{ id: '([a-z0-9-]+)'[^\n]*?phrase: '([^']+)' \}/g)) built.set(m[1], m[2]);
  for (const m of prodSql.slice(mid, end).matchAll(/\{ id: '([a-z0-9-]+)'/g)) missing.add(m[1]);
  for (const m of prodSql.matchAll(/^\s+(connections_end_cannot_be_undone|rollback_does_not_restore_connections): '([^']+)'/gm)) warnings.push({ id: m[1], text: m[2] });
  const dnuStart = prodSql.indexOf('export const PROD_SQL_DO_NOT_USE');
  if (dnuStart >= 0) for (const m of prodSql.slice(dnuStart, prodSql.indexOf('];', dnuStart)).matchAll(/\{ id: '([a-z0-9-]+)'/g)) doNotUse.push(m[1]);
  const inv = stagingRebuilt.match(/'auth-schema-inventory': \{[^\n]*confirmation: '([^']+)'/);
  return { built, missing, doNotUse, warnings, stagingInventoryPhrase: inv?.[1] };
}


/** The wrapper's real parser (scripts/run-with-secrets.mjs parseArgs): its options, which take a value, the prompt-only names and the allowed secret names. */
export function parseWrapperParser(src) {
  const start = src.indexOf('export function parseArgs');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) return { error: 'wrapper parseArgs not found' };
  const body = src.slice(start, end);
  const options = new Map();
  for (const m of body.matchAll(/a === '(--[a-z-]+)'\) \{([^}]*)\}/g)) options.set(m[1], /\+\+i/.test(m[2]));
  const promptOnly = [...(src.match(/PROMPT_ONLY = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  const allowed = [...(src.match(/export const ALLOWED = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  const needsNode = /rest\[0\] !== 'node'/.test(body);
  const error = options.size === 4 && options.has('--secret') && options.has('--from-env') && options.has('--cwd') && options.has('--node-path') && promptOnly.includes('PRODUCTION_DB_URL') && allowed.includes('PRODUCTION_DB_URL') && needsNode && /unknown option/.test(body)
    ? undefined : 'wrapper parser not recognised';
  return { options, promptOnly, allowed, error };
}

/** A runner CLI's real argument parser: the --name= options, the bare flags and the unknown-argument refusal. */
export function parseRunnerParser(src, fnName) {
  const start = src.indexOf('export function ' + fnName);
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) return { error: fnName + ' not found' };
  const body = src.slice(start, end);
  const valueFlags = [...body.matchAll(/arg\.startsWith\('(--[a-z-]+)='\)/g)].map((m) => m[1]);
  const boolFlags = [...body.matchAll(/arg === '(--[a-z-]+)'/g)].map((m) => m[1]);
  const error = valueFlags.length === 3 && ['--target', '--action', '--confirm'].every((f) => valueFlags.includes(f)) && boolFlags.length === 1 && boolFlags[0] === '--execute' && /RunnerRefusal\('unknown_argument'/.test(body)
    ? undefined : fnName + ' not recognised';
  return { valueFlags, boolFlags, error };
}

/** The value a POSIX shell passes for one argument value: double quotes removed, everything else kept, so "A"B is AB (never a prefix match). */
function unquoteArg(value) {
  return value.replace(/"/g, '');
}

/** Validates ONE pasted command line, token by token, as the wrapper and the runner would parse it. Returns the action, phrase and mode, plus every problem. */
export function parseCommandLine(line, wrapper, runner, runnerRelPath) {
  const problems = [];
  const tokens = [...line.trim().matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) => m[0]);
  const out = { problems, action: undefined, confirm: undefined, execute: false };
  if (tokens[0] !== 'node' || tokens[1] !== 'scripts/run-with-secrets.mjs') { problems.push('not a node scripts/run-with-secrets.mjs command'); return out; }
  const secrets = [];
  let cwd; let nodePath; let fromEnv = false;
  let i = 2;
  for (; i < tokens.length; i += 1) {
    const a = tokens[i];
    if (a === '--') { i += 1; break; }
    if (!wrapper.options.has(a)) { problems.push('unknown wrapper option ' + a); continue; }
    const value = wrapper.options.get(a) ? tokens[++i] : undefined;
    if (a === '--secret') secrets.push(value);
    else if (a === '--from-env') fromEnv = true;
    else if (a === '--cwd') cwd = value;
    else if (a === '--node-path') nodePath = value;
  }
  if (fromEnv) problems.push('--from-env is refused by the wrapper for ' + wrapper.promptOnly.join(', ') + ' (staging only)');
  if (secrets.length !== 1 || secrets[0] !== 'PRODUCTION_DB_URL') problems.push('the secret list must be exactly --secret PRODUCTION_DB_URL, found: ' + secrets.join(', '));
  if (cwd !== 'pipeline') problems.push('--cwd must be pipeline');
  if (nodePath !== undefined) problems.push('--node-path is not part of the documented command');
  const rest = tokens.slice(i);
  if (rest[0] !== 'node' || rest[1] !== 'node_modules/tsx/dist/cli.mjs' || rest[2] !== runnerRelPath) problems.push('child must be exactly: node node_modules/tsx/dist/cli.mjs ' + runnerRelPath);
  const seen = new Set();
  for (const arg of rest.slice(3)) {
    const name = arg.match(/^(--[a-z-]+)=/)?.[1];
    const flag = name && runner.valueFlags.includes(name) ? name : runner.boolFlags.includes(arg) ? arg : undefined;
    if (!flag) { problems.push('unknown_argument ' + arg.replace(/=.*/, '')); continue; }
    if (seen.has(flag)) problems.push('duplicate ' + flag);
    seen.add(flag);
    if (flag === '--action') out.action = unquoteArg(arg.slice('--action='.length));
    else if (flag === '--confirm') out.confirm = unquoteArg(arg.slice('--confirm='.length));
    else if (flag === '--target') { if (arg !== '--target=production') problems.push('--target must be production'); }
    else if (flag === '--execute') out.execute = true;
  }
  for (const need of ['--target', '--action', '--confirm']) if (!seen.has(need)) problems.push('missing ' + need);
  if (out.execute && !/\s--execute\s*$/.test(line)) problems.push('--execute must be the last argument');
  return out;
}

/** Keys of each 'first-manager.<event>' entry in the wrapper's output allow-list (the real field set). */
export function parseFmOutputFields(wrapperSrc) {
  const events = new Map();
  for (const m of wrapperSrc.matchAll(/'first-manager\.([a-z_]+)': \{/g)) {
    let depth = 1; let i = m.index + m[0].length; const start = i;
    for (; i < wrapperSrc.length && depth > 0; i += 1) { if (wrapperSrc[i] === '{') depth += 1; else if (wrapperSrc[i] === '}') depth -= 1; }
    const body = wrapperSrc.slice(start, i - 1);
    const keys = []; let d = 0; let piece = '';
    const flush = () => { const k = piece.trim().match(/^([a-z_]+)\b/)?.[1]; if (k) keys.push(k); piece = ''; };
    for (const ch of body) {
      if ('([{'.includes(ch)) d += 1; else if (')]}'.includes(ch)) d -= 1;
      if (ch === ',' && d === 0) flush(); else piece += ch;
    }
    flush();
    events.set(m[1], keys.sort());
  }
  return events;
}

/** The exact action order the runbook must show, in document order: each action as a plan-only line then its --execute line. */
export const EXPECTED_STEPS = [
  ['OPEN-2', 'fm', ['first-manager-check', 'first-manager-create']],
  ['A1', 'prod', ['read-only-inventory']],
  ['A2', 'prod', ['migration-security-hardening', 'migration-profile-service-bootstrap', 'migration-dnc-activity-enum-cast', 'migration-contact-logs-dnc-guard']],
  ['A3', 'prod', ['snapshot']], ['B2', 'prod', ['m1']], ['B3', 'prod', ['m1b']], ['B4', 'prod', ['m1c']],
  ['B8', 'fm', ['first-manager-check']], ['B9', 'fm', ['first-manager-create']], ['B9V', 'fm', ['first-manager-check']],
  ['B10', 'prod', ['window-on']], ['B13', 'prod', ['l1-shape', 'l1-counts', 'l1-sweep']], ['C4', 'prod', ['window-off']],
  ['BO2', 'prod', ['retire-nologin', 'retire-terminate', 'retire-backends', 'retire-revoke', 'retire-checks', 'retire-email']],
  ['BO3', 'prod', ['bootstrap-identity-check', 'read-only-inventory']],
  ['BO4', 'prod', ['backout-m1c']], ['BO5', 'prod', ['backout-m1b']], ['BO6', 'prod', ['backout-m1']], ['BO10', 'prod', ['security-hardening-backout']],
];

export function checkCutoverRunbook(runbook, yaml, runnerSources, fmSources) {
  const failures = [];
  const need = (text, pattern, label) => {
    if (!pattern.test(text)) failures.push(label);
  };
  const blocks = new Map([...runbook.matchAll(/^🔴 \*\*([A-Z]+-?\d+[A-Z]?) — [^\n]+[\s\S]*?(?=^🔴 \*\*|^##### |^---|$(?![\s\S]))/gm)]
    .map(([body, id]) => [id, body]));
  const block = (id) => {
    if (!blocks.has(id)) failures.push(`missing ${id} block`);
    return blocks.get(id) ?? '';
  };
  /** Every line of the runbook with the id of the step block it sits in ('' outside a step block), mirroring the block pattern above. */
  const located = [];
  let currentId = '';
  for (const lineText of runbook.split('\n')) {
    const header = lineText.match(/^🔴 \*\*([A-Z]+-?\d+[A-Z]?) — /);
    if (header) currentId = header[1];
    else if (/^##### |^---/.test(lineText)) currentId = '';
    located.push({ id: currentId, lineText });
  }
  /** Compares the ordered actions found with the required order; names the first position that differs. */
  const sameSequence = (label, actual, expected) => {
    if (actual.join('\n') === expected.join('\n')) return;
    let i = 0;
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) i += 1;
    failures.push(label + ': command order differs from the required order at position ' + (i + 1) + ': found ' + (actual[i] ?? '(nothing)') + ', required ' + (expected[i] ?? '(nothing)') + ' (' + actual.length + ' commands found, ' + expected.length + ' required)');
  };
  const expectedSequence = (kind) => EXPECTED_STEPS.filter((s) => s[1] === kind).flatMap(([id, , actions]) => actions.flatMap((a) => [id + '|' + a + '|plan', id + '|' + a + '|execute']));
  const ownerScope = /`truck-recruitment-tool-owner`\s*(?:\/|, config)\s*`prd`|truck-recruitment-tool-owner\/prd/;
  const readerScope = /truck-recruitment-tool(?:`\s*\/\s*`|\/)dev/;

  // Every production/backout/cleanup block remains independently unapproved.
  const ids = [
    ...Array.from({ length: 9 }, (_, i) => `A${i + 1}`), 'A7R',
    ...Array.from({ length: 15 }, (_, i) => `B${i + 1}`), 'B9V',
    ...Array.from({ length: 4 }, (_, i) => `C${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `BO${i + 1}`), 'K1',
    'GATE-1', 'GATE-2', 'GATE-3',
  ];
  for (const id of ids) {
    const body = block(id);
    need(body.split('\n')[0], /NOT APPROVED/, `${id}: missing NOT APPROVED`);
    const gate = id === 'B1' ? /- \*\*Go-gate:\*\*[^\n]*go for the cutover window, starting B1/ : new RegExp(`- \\*\\*Go-gate:\\*\\*[^\\n]*go for ${id}\\b`);
    need(body, gate, `${id}: missing own go-gate`);
  }
  for (const id of ['B8', 'B9', 'B9V', 'C3', 'BO5', 'BO6', 'K1']) {
    const body = block(id);
    for (const label of ['What', 'Why', 'If skipped', 'Steps', 'Success check']) {
      need(body, new RegExp(`\\*\\*${label}:?\\*\\*`), `${id}: missing ${label}`);
    }
  }

  // The sync is whole-config: privileged owner and monitoring names cannot be runtime entries.
  const runtimeKeys = [...yaml.matchAll(/^\s*- key:\s*(\w+)/gm)].map((m) => m[1]);
  for (const name of ['PRODUCTION_DB_URL', 'TEMP_RENDER_API_KEY']) {
    if (runtimeKeys.includes(name)) failures.push(`Render draft: forbidden runtime key ${name}`);
  }
  need(yaml, ownerScope, 'Render draft: missing separate owner scope');
  need(yaml, /must NEVER sync to Render/, 'Render draft: missing owner sync prohibition');
  for (const id of ['OPEN-2', 'OPEN-5', 'B8', 'B9', 'B9V']) {
    need(block(id), ownerScope, `${id}: missing owner-only scope`);
  }
  for (const id of ['B8', 'B9', 'B9V']) {
    const body = block(id);
    need(body, /https:\/\/dashboard\.doppler\.com/, `${id}: missing Doppler page`);
    need(body, new RegExp(FM_TIP), `${id}: first-manager tool commit ${FM_TIP} not cited`);
    if (/pending review|e31dc29|\*\*GAP/i.test(body)) failures.push(`${id}: stale pending-review / candidate / GAP text remains for the reviewed first-manager tool`);
    need(body, /--secret PRODUCTION_DB_URL -- node node_modules\/tsx\/dist\/cli\.mjs src\/first-manager-runner\.ts/, `${id}: missing wrapped first-manager command`);
    need(body, /never run/, `${id}: wrapped line must be marked never run`);
    need(body, /Go-gate:[^\n]*the manager has confirmed the wrapped line[^\n]*merged tool/, `${id}: wrapped line must be confirmed against the merged tool before go`);
    if (/project `truck-recruitment-tool` → config `prd` → `PRODUCTION_DB_URL`|from `truck-recruitment-tool\/prd`|value read from Doppler `truck-recruitment-tool`\s*\/\s*`prd`/.test(body)) failures.push(`${id}: bootstrap uses runtime scope`);
  }
  const sync = block('B6');
  need(sync, /PRODUCTION_DB_URL[^\n]*TEMP_RENDER_API_KEY[^\n]*STOP/, 'B6: missing runtime inventory stop');
  need(sync, /owner-only `truck-recruitment-tool-owner\/prd` has no syncs or integrations/, 'B6: missing owner isolation check');
  need(sync, /Go-gate:[^\n]*owner isolation checks passed/, 'B6: isolation must gate approval');

  // A7 revokes its write key; a different, explicitly approved reader copy survives until K1.
  need(block('A7'), /deletes the Render API key[^\n]*deletes `TEMP_RENDER_API_KEY`/, 'A7: write-key cleanup missing');
  const reader = block('A7R');
  need(reader, /carrieronboardingbot[^\n]*dev/, 'A7R: reader source missing');
  need(reader, /B6[^\n]*B7[^\n]*B15[^\n]*BO1[^\n]*backout window/, 'A7R: reader lifetime must cover backout');
  need(reader, /Final removal is K1/, 'A7R: final cleanup missing');
  for (const id of ['B6', 'B7', 'B15', 'BO1']) {
    const gate = block(id).split('\n').find((line) => line.startsWith('- **Go-gate:**')) ?? '';
    need(gate, /reader copy/, `${id}: reader availability must gate approval`);
    need(block(id), readerScope, `${id}: target reader dev scope missing`);
  }
  need(block('K1'), /do not revoke the shared reader key/i, 'K1: shared reader must not be revoked');
  need(block('K1'), /Go-gate:[^\n]*no later helper needs the key/, 'K1: cleanup must follow all helper uses');
  need(block('B9V'), /negative check never authorizes another create/, 'B9V: missing no-retry rule');
  need(block('B15'), /Go-gate:[^\n]*B9V confirmed `manager_exists`/, 'B15: independent check must gate opening');
  if (/run B8 again|run the B8 command again/.test(block('B9'))) failures.push('B9: abbreviated/implicitly approved follow-up');

  const cron = block('C3');
  need(cron, /Doppler project `pipeline`, config `prd`/, 'C3: missing pipeline/prd');
  need(cron, /https:\/\/dashboard\.doppler\.com \(not verified:/, 'C3: missing marked Doppler page link');
  need(cron, /Source for `MAINTENANCE_DATABASE_URL`:[^\n]*recruiter_maintenance/, 'C3: missing named credential source');
  need(cron, /Go-gate:[^\n]*cron activation[^\n]*all gaps resolved/, 'C3: unresolved cron activation must block go');
  if (/only if it is a web service/.test(cron)) failures.push('C3: inapplicable web-service branch');
  need(runbook, /mail provider is \*\*SendGrid\*\*/, 'SendGrid decision missing');

  // OPEN-1 is closed by Hunter's recorded decision; no unnamed-route placeholder may remain.
  const open1 = runbook.match(/^✅ \*\*OPEN-1 — CLOSED[^\n]*\n(?:- [^\n]*\n|  [^\n]*\n)+/m)?.[0] ?? '';
  if (!open1) failures.push('OPEN-1: closed decision block missing');
  need(open1, /2026-10-30/, 'OPEN-1: decision date missing');
  need(open1, /Hunter/, 'OPEN-1: decider missing');
  need(open1, /18-production-sql-route-options\.md/, 'OPEN-1: doc 18 not cited');
  need(open1, new RegExp(`tip \`${RUNNER_TIP}\``), `OPEN-1: runner tip ${RUNNER_TIP} not cited`);
  need(open1, /Route B[^\n]*reviewed paste box still owed/i, 'OPEN-1: Route B paste box owed missing');
  need(open1, /5101b81/, 'OPEN-1: review trail 5101b81 missing');
  need(open1, /bb\/fix-draft-sql-findings-backouts-do-not-use-bo3-i-thr_8uxydx6hqr/, 'OPEN-1: runner branch not cited');
  if (/🔴 \*\*OPEN-1\b/.test(runbook)) failures.push('OPEN-1: still marked as a pending action');
  if (/production SQL route/i.test(runbook)) failures.push('placeholder "production SQL route" remains');
  if (/production SQL gets run \(no route/i.test(runbook)) failures.push('stale OPEN-1 "no route is recorded" text remains');
  const b5 = block('B5');
  need(b5, /Route B/, 'B5: password statement must stay on Route B');
  need(b5, /reviewed paste box still owed/, 'B5: reviewed paste box still owed missing');
  if (/prod-sql-runner/.test(b5)) failures.push('B5: password statement must not go through the Route A runner');
  // Route B password drafts: owner steps in the four-heading format, the exact placeholder statement, Doppler by NAME only.
  for (const [id, role, name, project] of [['B5', 'recruiter_app', 'DATABASE_URL', 'truck-recruitment-tool'], ['C3', 'recruiter_maintenance', 'MAINTENANCE_DATABASE_URL', 'pipeline']]) {
    const body = block(id);
    need(body, /DRAFT, NOT APPROVED, NEEDS REVIEW/, `${id}: password draft must be marked DRAFT, NOT APPROVED, NEEDS REVIEW`);
    need(body, new RegExp(`^\\s+ALTER ROLE ${role} LOGIN PASSWORD '<paste here>';$`, 'm'), `${id}: missing the exact draft statement for ${role} with the <paste here> placeholder`);
    for (const heading of ['Pending Action', 'Summary of Next Step', 'Summary of Previous Step', 'Miscellaneous']) need(body, new RegExp(`^\\s+###### ${heading}`, 'm'), `${id}: missing four-heading format heading "${heading}"`);
    need(body, new RegExp(`project \`${project}\` → config \`prd\` → (?:secret |add secret )?\`${name}\``), `${id}: Doppler project/config/name for ${name} missing`);
    need(body, /password manager/, `${id}: password-manager step missing`);
    need(body, /https:\/\/supabase\.com\/dashboard/, `${id}: Supabase page link missing`);
    need(body, /https:\/\/dashboard\.doppler\.com/, `${id}: Doppler page link missing`);
    need(body, /Success check/i, `${id}: owner steps need a success check`);
    need(body, /Still owed before this is a reviewed paste box[^\n]*1\. exact production project[^\n]*2\. password generation[^\n]*3\. the correct session-pooler[^\n]*4\. /, `${id}: the four still-owed review items must be listed`);
    if (/prod-sql-runner/.test(body)) failures.push(`${id}: password statement must not go through the Route A runner`);
  }
  // No value anywhere: only the placeholder may sit inside a PASSWORD literal; no connection URL; no long token-like run.
  for (const m of runbook.matchAll(/PASSWORD '([^']*)'/g)) if (!/^<[a-z ]+>$/.test(m[1])) failures.push('a PASSWORD literal other than a <placeholder> appears in the runbook');
  if (/postgres(?:ql)?:\/\/|eyJ[A-Za-z0-9_-]{10,}|SG\.[A-Za-z0-9_-]{16,}/.test(runbook)) failures.push('a connection URL or token-like value appears in the runbook');
  for (const m of runbook.matchAll(/[A-Za-z0-9]{32,}/g)) if (!/^[0-9a-f]+$/.test(m[0])) failures.push('a long token-like run appears in the runbook');

  // Every cited Route A action, phrase and command must exist in the runner source at the reviewed tip.
  const runner = runnerSources ? parseRunner(runnerSources.prodSql ?? '', runnerSources.stagingRebuilt ?? '') : undefined;
  if (!runner || runner.error || runner.built.size === 0) {
    failures.push(`runner source at ${RUNNER_TIP} unavailable or unparseable${runner?.error ? `: ${runner.error}` : ''}`);
  } else {
    const phrases = new Set(runner.built.values());
    const seen = new Map();
    const wrapper = parseWrapperParser(runnerSources.wrapper ?? '');
    const cli = parseRunnerParser(runnerSources.cli ?? '', 'parseProdSqlArgs');
    if (wrapper.error || cli.error) failures.push('argument parsers at ' + RUNNER_TIP + ' unavailable or unrecognised: ' + (wrapper.error ?? cli.error));
    const sequence = [];
    for (const { id, lineText } of located) {
      if (!/prod-sql-runner\.ts/.test(lineText)) continue;
      const parsed = cli.error || wrapper.error ? undefined : parseCommandLine(lineText, wrapper, cli, RUNNER_FILES.cli.replace(/^pipeline\//, ''));
      const action = parsed ? parsed.action : lineText.match(/--action=(\S+)/)?.[1];
      if (!action || /^<[a-z-]+>$/.test(action)) continue; // the one template line with <action>
      if (runner.doNotUse.includes(action) || EXPECTED_DO_NOT_USE.includes(action)) { failures.push('DO NOT USE action ' + action + ' is cited as a runnable command'); continue; }
      if (!/^\s*node scripts\/run-with-secrets/.test(lineText)) { failures.push(id + ': a runner command is not a plain pasted line: ' + lineText.slice(0, 60)); continue; }
      const confirm = parsed?.confirm;
      const execute = /\s--execute\s*$/.test(lineText);
      if (!runner.built.has(action)) {
        failures.push('cited action ' + action + ' is not a built action in the runner source at ' + RUNNER_TIP + (runner.missing.has(action) ? ' (listed as not built)' : ''));
        continue;
      }
      if (confirm !== runner.built.get(action)) failures.push('action ' + action + ': cited phrase "' + (confirm ?? '') + '" does not match the runner phrase');
      if (parsed) {
        for (const problem of parsed.problems) failures.push(id + ': action ' + action + ': command argument list does not match the parsers at ' + RUNNER_TIP + ': ' + problem);
      }
      sequence.push(id + '|' + action + '|' + (execute ? 'execute' : 'plan'));
      const kinds = seen.get(action) ?? new Set();
      kinds.add(execute ? 'execute' : 'plan');
      seen.set(action, kinds);
    }
    sameSequence('Route A', sequence, expectedSequence('prod'));
    for (const m of runbook.matchAll(/\bactions? `([a-z0-9-]+)`/g)) {
      if (!runner.built.has(m[1]) && !runner.missing.has(m[1]) && !runner.doNotUse.includes(m[1]) && !/^auth-schema-inventory$/.test(m[1])) failures.push(`prose cites action \`${m[1]}\` that is not in the runner source at ${RUNNER_TIP}`);
    }
    for (const m of runbook.matchAll(/`(RUN TNBS PRODUCTION SQL [A-Z0-9-]+)`/g)) {
      if (!phrases.has(m[1])) failures.push(`prose cites phrase "${m[1]}" that is not in the runner source at ${RUNNER_TIP}`);
    }
    for (const [id, kind, actions] of EXPECTED_STEPS) {
      if (kind !== 'prod') continue;
      for (const action of actions) if (!runner.built.has(action)) failures.push(id + ': action ' + action + ' not in the runner source');
      if (/production SQL route|the production SQL/i.test(block(id))) failures.push(id + ': unnamed-route placeholder');
    }
    // A2: the prose labels must name the migrations in the required order (the command lines are checked above).
    const a2Labels = [...block('A2').matchAll(/Migration (\d), action `([a-z0-9-]+)`/g)].map((m) => m[1] + ':' + m[2]);
    sameSequence('A2 labels', a2Labels, EXPECTED_STEPS.find((s) => s[0] === 'A2')[2].map((a, i) => (i + 1) + ':' + a));
    // DO NOT USE: the runner's list must be exactly the two known ids; the runbook may mention them only on a line that says DO NOT USE,
    // and A2 must explain why (doc 18) and say the forward fixes are retained.
    if (runner.doNotUse.length !== EXPECTED_DO_NOT_USE.length || EXPECTED_DO_NOT_USE.some((id) => !runner.doNotUse.includes(id))) failures.push(`runner DO NOT USE list is [${runner.doNotUse.join(', ')}], expected [${EXPECTED_DO_NOT_USE.join(', ')}]`);
    for (const id of EXPECTED_DO_NOT_USE) {
      if (runner.built.has(id)) failures.push(`${id} is in the runner action table; it must be DO NOT USE`);
      const lines = runbook.split('\n').filter((l) => l.includes(id));
      if (lines.length === 0) failures.push(`${id}: the DO NOT USE action is never explained in the runbook`);
      for (const l of lines) if (!/DO NOT USE/.test(l)) failures.push(`${id}: mentioned on a line that does not say DO NOT USE: ${l.slice(0, 60)}`);
    }
    const a2 = block('A2');
    for (const id of EXPECTED_DO_NOT_USE) need(a2, new RegExp(`\`${id}\` is DO NOT USE`), `A2: ${id} must be stated as DO NOT USE`);
    need(a2, /prod_sql_action_do_not_use/, 'A2: refusal id prod_sql_action_do_not_use missing');
    need(a2, /doc 18/, 'A2: DO NOT USE reason must cite doc 18');
    need(a2, /forward fixes[^\n]*RETAINED/, 'A2: must say the forward fixes are retained');
    need(a2, /fails open/, 'A2: profile guard reason (fails open) missing');
    need(a2, /42804/, 'A2: DNC cast reason (SQLSTATE 42804) missing');
    // No "not built" placeholder may remain for a built action, and no unnamed-route wording.
    for (const lineText of runbook.split('\n')) {
      const ids = [...runner.built.keys()].filter((id) => lineText.includes(`\`${id}\``));
      if (ids.length && /not built|prod_sql_action_not_built|route not decided|no Route A action|has \*\*no action\*\*|Route A has \*\*no action\*\*/i.test(lineText)) failures.push(`"not built / no action" placeholder remains for built action ${ids.join(', ')}: ${lineText.slice(0, 60)}`);
    }
    if (/route not decided|\*\*route not decided\*\*/i.test(runbook)) failures.push('a "route not decided" placeholder remains');
    // The old runner tip and the old candidate tool commit may appear only as history ("first written against", "re-pointed", "replaces").
    for (const lineText of runbook.split('\n')) {
      if (/4552557/.test(lineText) && !/first written against|re-pointed/.test(lineText)) failures.push(`old runner tip 4552557 cited as current: ${lineText.slice(0, 60)}`);
      if (/e31dc29/.test(lineText) && !/replaces the earlier candidate|replaced/.test(lineText)) failures.push(`old candidate commit e31dc29 cited as current: ${lineText.slice(0, 60)}`);
    }
    for (const id of ['A1', 'B10', 'C4', 'BO3', 'BO10']) need(block(id), /Go-gate:[^\n]*GATE-1 done/, `${id}: go-gate must require GATE-1 (runner branch merged)`);
    need(block('BO3'), /BEFORE the M1 backouts/, 'BO3: must say it runs before the M1 backouts');
    need(block('BO3'), /retire-email/, 'BO3: relation to retire-email missing');
    need(block('BO3'), /BO6[^\n]*drops|drops `internal\.auth_events`|drops[^\n]*auth_events/, 'BO3: why order matters (internal.auth_events dropped by M1-backout) missing');
    // BO3 must consume approved_auth_email_null: report it, require 0, and STOP above 0 (the email_mismatches comparison cannot see a NULL Auth email).
    const bo3 = block('BO3');
    const bo3Report = bo3.split('\n').find((l) => /^\s+c\. Report `email_mismatches`/.test(l)) ?? '';
    need(bo3Report, /`approved_auth_email_null` \(expected 0[^)]*STOP/, 'BO3: reporting step must require approved_auth_email_null = 0 with a STOP above 0');
    const bo3Success = bo3.split('\n').find((l) => l.startsWith('- **Success check:**')) ?? '';
    need(bo3Success, /`approved_auth_email_null` is 0/, 'BO3: success rule must require approved_auth_email_null to be 0');
    need(bo3Success, /if[^.]*`approved_auth_email_null` is above 0[^.]*\*\*stop\*\*/, 'BO3: STOP rule must name approved_auth_email_null above 0');
    // Documented counts and refusal ids must exist in the wrapper's allow-lists at the runner tip (no invented name).
    const countNames = [...(runnerSources.wrapper ?? '').matchAll(/PROD_SQL_COUNT_NAMES = \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    const refusalIds = [...((runnerSources.wrapper ?? '').match(/REFUSAL_IDS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    if (countNames.length === 0 || refusalIds.length === 0) failures.push('count names or refusal ids not found in the wrapper at ' + RUNNER_TIP);
    for (const { id, lineText } of located) {
      if (/prod-sql\.counts/.test(lineText)) {
        for (const m of lineText.matchAll(/`([a-z]+(?:_[a-z<>]+)+)`/g)) if (!countNames.includes(m[1]) && !/^profiles_<role>_<status>$/.test(m[1])) failures.push(id + ': documents count name ' + m[1] + ' that the runner does not define');
      }
      for (const m of lineText.matchAll(/\bprod_sql_[a-z_]+/g)) if (refusalIds.length && !refusalIds.includes(m[0])) failures.push(id + ': documents refusal id ' + m[0] + ' that the runner does not define');
    }
    need(block('A1'), /`approved_auth_email_null`/, 'A1: the inventory count approved_auth_email_null is not recorded');
    need(block('B10'), /prod_sql_flag_not_expected/, 'B10: flag verification refusal missing');
    need(block('C4'), /prod_sql_flag_not_expected/, 'C4: flag verification refusal missing');

    // Go-gate prerequisites, each NOT APPROVED with its own go.
    const gateLine = (id) => block(id).split('\n').find((l) => l.startsWith('- **Go-gate:**')) ?? '';
    for (const id of ['A2', 'A3', 'B2', 'B3', 'B4', 'B13', 'BO2', 'BO4', 'BO5', 'BO6']) need(gateLine(id), /GATE-1(?: and GATE-2)? done/, `${id}: go-gate must require GATE-1 (runner branch merged)`);
    need(gateLine('B13'), /GATE-2 done/, 'B13: go-gate must require GATE-2 (inventory capture and classification)');
    need(gateLine('BO2'), /go for GATE-3/, 'BO2: go-gate must require GATE-3 before retire-terminate');
    need(block('BO2'), /GATE-3 first[\s\S]*--action=retire-terminate/, 'BO2: retire-terminate step must name GATE-3 before the command');
    need(block('GATE-1'), new RegExp(RUNNER_TIP), 'GATE-1: runner tip missing');
    need(block('GATE-1'), /merge/i, 'GATE-1: merge requirement missing');
    const g2 = block('GATE-2');
    need(g2, /auth-schema-inventory/, 'GATE-2: inventory action missing');
    need(g2, /auth-table-classification\.json/, 'GATE-2: classification file missing');
    need(g2, /classif/i, 'GATE-2: human classification missing');
    if (!runner.stagingInventoryPhrase) failures.push('GATE-2: inventory phrase not found in the staging runner source');
    else need(g2, new RegExp(`--confirm="${runner.stagingInventoryPhrase}"`), 'GATE-2: inventory phrase does not match the runner source');
    const g3 = block('GATE-3');
    if (runner.warnings.length !== 2) failures.push('GATE-3: expected two fixed warnings in the runner source');
    for (const w of runner.warnings) {
      need(g3, new RegExp(w.id), `GATE-3: warning id ${w.id} missing`);
      if (!g3.includes(w.text.replace(/\\'/g, "'"))) failures.push(`GATE-3: warning sentence for ${w.id} does not match the runner source`);
    }
    need(g3, /retire-terminate/, 'GATE-3: retire-terminate missing');
    for (const [action, kinds] of seen) {
      if (!kinds.has('plan') || !kinds.has('execute')) failures.push(`action ${action}: both plan-only and --execute commands must be shown`);
    }
  }
  // First-manager tool: every cited command, phrase, state and result must exist in the tool source at FM_TIP.
  const fm = fmSources ? parseFirstManager(fmSources.bootstrap ?? '', fmSources.runner ?? '') : undefined;
  if (!fm || fm.error) {
    failures.push(`first-manager source at ${FM_TIP} unavailable or unparseable${fm?.error ? `: ${fm.error}` : ''}`);
  } else {
    const kinds = new Map();
    const fmWrapper = parseWrapperParser(fmSources.wrapper ?? '');
    const fmCli = parseRunnerParser(fmSources.runner ?? '', 'parseFirstManagerArgs');
    if (fmWrapper.error || fmCli.error) failures.push('first-manager argument parsers at ' + FM_TIP + ' unavailable or unrecognised: ' + (fmWrapper.error ?? fmCli.error));
    const fmSequence = [];
    for (const { id, lineText } of located) {
      if (!/first-manager-runner\.ts/.test(lineText) || !/--action=/.test(lineText)) continue;
      if (!/^\s*node scripts\/run-with-secrets/.test(lineText)) { failures.push(id + ': a first-manager command is not a plain pasted line: ' + lineText.slice(0, 60)); continue; }
      const parsed = fmWrapper.error || fmCli.error ? undefined : parseCommandLine(lineText, fmWrapper, fmCli, FM_FILES.runner.replace(/^pipeline\//, ''));
      const action = parsed ? parsed.action : lineText.match(/--action=(\S+)/)?.[1];
      const confirm = parsed?.confirm;
      if (!action || !fm.actions.includes(action)) { failures.push('first-manager command cites unknown action ' + (action ?? '(none)')); continue; }
      if (confirm !== fm.phrases.get(action)) failures.push('first-manager action ' + action + ': cited phrase "' + (confirm ?? '') + '" does not match the tool source');
      if (parsed) {
        for (const problem of parsed.problems) failures.push(id + ': first-manager action ' + action + ': command argument list does not match the parsers at ' + FM_TIP + ': ' + problem);
      }
      const execute = /\s--execute\s*$/.test(lineText);
      fmSequence.push(id + '|' + action + '|' + (execute ? 'execute' : 'plan'));
      const k = kinds.get(action) ?? new Set();
      k.add(execute ? 'execute' : 'plan');
      kinds.set(action, k);
    }
    sameSequence('first-manager', fmSequence, expectedSequence('fm'));
    for (const action of fm.actions) if (!kinds.get(action)?.has('plan') || !kinds.get(action)?.has('execute')) failures.push(`first-manager action ${action}: plan-only and --execute commands must both be shown`);
    const open2 = block('OPEN-2');
    need(open2, new RegExp(FM_TIP), `OPEN-2: first-manager tool commit ${FM_TIP} not cited`);
    need(open2, /fm-listener r2: ready/, 'OPEN-2: review label missing');
    need(open2, /signin\/combined-reviewed-abc/, 'OPEN-2: pushed branch signin/combined-reviewed-abc not cited');
    need(open2, /bb\/fix-first-manager-listener-output-commit-outcome-thr_q9ajbvqpa6/, 'OPEN-2: tool branch not cited');
    if (/pending review/i.test(open2.split('\n')[0])) failures.push('OPEN-2: stale "pending review" heading');
    for (const phrase of fm.phrases.values()) need(open2, new RegExp(phrase), `OPEN-2: phrase "${phrase}" missing`);
    for (const state of fm.states) need(open2, new RegExp(state), `OPEN-2: state ${state} missing`);
    for (const result of fm.results) need(open2, new RegExp(result), `OPEN-2: result ${result} missing`);
    for (const event of ['verified', 'plan_only', 'state', 'check', 'checks', 'result', 'done', 'refused']) {
      if (!fm.events.includes(event)) failures.push(`first-manager tool source has no event first-manager.${event}`);
      need(open2, new RegExp(`first-manager\\.${event}\\b`), `OPEN-2: output event first-manager.${event} missing`);
    }
    // The documented field set of each event must equal the wrapper's real allow-list for it: no invented field, none missing.
    const realFields = parseFmOutputFields(fmSources.wrapper ?? '');
    const documented = new Map();
    for (const m of open2.matchAll(/^\s+- `first-manager\.([a-z_]+)` — fields: ([^\n]*?)(?: \(|\.$)/gm)) documented.set(m[1], [...m[2].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]).sort());
    if (realFields.size === 0) failures.push('first-manager output allow-list not found in the wrapper at ' + FM_TIP);
    for (const [event, fields] of realFields) {
      const doc = documented.get(event);
      if (!doc) { failures.push('OPEN-2: field list for first-manager.' + event + ' is missing'); continue; }
      const invented = doc.filter((f) => !fields.includes(f));
      const missing = fields.filter((f) => !doc.includes(f));
      if (invented.length) failures.push('OPEN-2: first-manager.' + event + ' documents field(s) the wrapper does not define: ' + invented.join(', '));
      if (missing.length) failures.push('OPEN-2: first-manager.' + event + ' omits real field(s): ' + missing.join(', '));
    }
    for (const event of documented.keys()) if (!realFields.has(event)) failures.push('OPEN-2: documents an event first-manager.' + event + ' the wrapper does not define');
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const gitShow = (path) => {
    try {
      return execFileSync('git', ['show', `${RUNNER_TIP}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
  const gitShowAt = (tip, path) => {
    try {
      return execFileSync('git', ['show', `${tip}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
  const fmBootstrap = gitShowAt(FM_TIP, FM_FILES.bootstrap);
  const fmRunner = gitShowAt(FM_TIP, FM_FILES.runner);
  const prodSql = gitShow(RUNNER_FILES.prodSql);
  const stagingRebuilt = gitShow(RUNNER_FILES.stagingRebuilt);
  const prodCli = gitShow(RUNNER_FILES.cli);
  const prodWrapper = gitShow(RUNNER_FILES.wrapper);
  const fmWrapper = gitShowAt(FM_TIP, FM_FILES.wrapper);
  const failures = checkCutoverRunbook(
    readFileSync(resolve(root, 'docs/build-plan/17-signin-cutover-runbook-draft.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/build-plan/drafts/render-recruiter-web.yaml'), 'utf8'),
    prodSql === undefined || stagingRebuilt === undefined || prodCli === undefined || prodWrapper === undefined ? undefined : { prodSql, stagingRebuilt, cli: prodCli, wrapper: prodWrapper },
    fmBootstrap === undefined || fmRunner === undefined || fmWrapper === undefined ? undefined : { bootstrap: fmBootstrap, runner: fmRunner, wrapper: fmWrapper },
  );
  if (failures.length) {
    console.error('Cutover runbook contract check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS cutover runbook contract: owner credential isolation, reader-copy lifetime, independent checks, cron/backout go-gates, OPEN-1 closed with every cited Route A action and phrase found in the runner source at ${RUNNER_TIP}, DO NOT USE actions never cited as runnable, no placeholder left for a built action, first-manager commands and phrases found in the tool source at ${FM_TIP}, password drafts carry placeholders only; text-level only, no live actions`);
  }
}
