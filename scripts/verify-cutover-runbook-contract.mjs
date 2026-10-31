#!/usr/bin/env node
// Offline documentation guard only. No SQL, secrets or network access.
// This does not approve a live step or verify a hosted config, cron or candidate tool.
// The one subprocess is `git show <tip>:<path>` (read-only) to read the Route A runner source at its reviewed tip.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Route A runner's reviewed tip (branch bb/route-a-round-3-termination-warning-auth-invento-thr_dj4kffsjqf); never merged here. */
export const RUNNER_TIP = '4552557';
export const RUNNER_FILES = { prodSql: 'pipeline/src/prod-sql.ts', stagingRebuilt: 'pipeline/src/staging-rebuilt.ts' };

/** Parses the runner source text: built actions with their typed phrases, the not-built ids, and the fixed warning sentences. */
export function parseRunner(prodSql, stagingRebuilt) {
  const built = new Map();
  const missing = new Set();
  const warnings = [];
  const start = prodSql.indexOf('export const PROD_SQL_ACTIONS');
  const mid = prodSql.indexOf('export const PROD_SQL_MISSING');
  const end = prodSql.indexOf('];', mid);
  if (start < 0 || mid < start || end < mid) return { built, missing, warnings, stagingInventoryPhrase: undefined, error: 'runner action table not found' };
  const table = prodSql.slice(start, mid);
  const templated = /phrase: `RUN TNBS PRODUCTION SQL \$\{id\.toUpperCase\(\)\}`/.test(prodSql);
  for (const m of table.matchAll(/MIGRATION\('([a-z0-9-]+)'/g)) {
    if (templated) built.set(m[1], `RUN TNBS PRODUCTION SQL ${m[1].toUpperCase()}`);
  }
  for (const m of table.matchAll(/\{ id: '([a-z0-9-]+)'[^\n]*?phrase: '([^']+)' \}/g)) built.set(m[1], m[2]);
  for (const m of prodSql.slice(mid, end).matchAll(/\{ id: '([a-z0-9-]+)'/g)) missing.add(m[1]);
  for (const m of prodSql.matchAll(/^\s+(connections_end_cannot_be_undone|rollback_does_not_restore_connections): '([^']+)'/gm)) warnings.push({ id: m[1], text: m[2] });
  const inv = stagingRebuilt.match(/'auth-schema-inventory': \{[^\n]*confirmation: '([^']+)'/);
  return { built, missing, warnings, stagingInventoryPhrase: inv?.[1] };
}

export function checkCutoverRunbook(runbook, yaml, runnerSources) {
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
    need(body, /pending review/i, `${id}: candidate review must remain pending`);
    need(body, /exact[^\n]*wrapper line[^\n]*before requesting go|exact hidden-prompt wrapper line supplied and reviewed/, `${id}: missing wrapper STOP`);
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
  if (/🔴 \*\*OPEN-1\b/.test(runbook)) failures.push('OPEN-1: still marked as a pending action');
  if (/production SQL route/i.test(runbook)) failures.push('placeholder "production SQL route" remains');
  if (/production SQL gets run \(no route/i.test(runbook)) failures.push('stale OPEN-1 "no route is recorded" text remains');
  const b5 = block('B5');
  need(b5, /Route B/, 'B5: password statement must stay on Route B');
  need(b5, /reviewed paste box still owed/, 'B5: reviewed paste box still owed missing');
  if (/prod-sql-runner/.test(b5)) failures.push('B5: password statement must not go through the Route A runner');

  // Every cited Route A action, phrase and command must exist in the runner source at the reviewed tip.
  const runner = runnerSources ? parseRunner(runnerSources.prodSql ?? '', runnerSources.stagingRebuilt ?? '') : undefined;
  if (!runner || runner.error || runner.built.size === 0) {
    failures.push(`runner source at ${RUNNER_TIP} unavailable or unparseable${runner?.error ? `: ${runner.error}` : ''}`);
  } else {
    const phrases = new Set(runner.built.values());
    const seen = new Map();
    for (const lineText of runbook.split('\n')) {
      if (!/prod-sql-runner\.ts/.test(lineText)) continue;
      const action = lineText.match(/--action=([a-z0-9-]+)/)?.[1];
      if (!action) continue; // the one template line with <action>
      const confirm = lineText.match(/--confirm="([^"]*)"/)?.[1];
      const execute = /\s--execute\s*$/.test(lineText);
      if (!runner.built.has(action)) {
        failures.push(`cited action ${action} is not a built action in the runner source at ${RUNNER_TIP}${runner.missing.has(action) ? ' (listed as not built)' : ''}`);
        continue;
      }
      if (confirm !== runner.built.get(action)) failures.push(`action ${action}: cited phrase "${confirm ?? ''}" does not match the runner phrase`);
      if (!/--target=production/.test(lineText)) failures.push(`action ${action}: command lacks --target=production`);
      if (!/--secret PRODUCTION_DB_URL/.test(lineText) || !/run-with-secrets\.mjs/.test(lineText)) failures.push(`action ${action}: command not wrapped by run-with-secrets with the hidden PRODUCTION_DB_URL prompt`);
      const kinds = seen.get(action) ?? new Set();
      kinds.add(execute ? 'execute' : 'plan');
      seen.set(action, kinds);
    }
    for (const m of runbook.matchAll(/\bactions? `([a-z0-9-]+)`/g)) {
      if (!runner.built.has(m[1]) && !runner.missing.has(m[1]) && !/^auth-schema-inventory$/.test(m[1])) failures.push(`prose cites action \`${m[1]}\` that is not in the runner source at ${RUNNER_TIP}`);
    }
    for (const m of runbook.matchAll(/`(RUN TNBS PRODUCTION SQL [A-Z0-9-]+)`/g)) {
      if (!phrases.has(m[1])) failures.push(`prose cites phrase "${m[1]}" that is not in the runner source at ${RUNNER_TIP}`);
    }
    const perBlock = {
      A2: ['migration-security-hardening', 'migration-profile-service-bootstrap', 'migration-dnc-activity-enum-cast', 'migration-contact-logs-dnc-guard'],
      A3: ['snapshot'], B2: ['m1'], B3: ['m1b'], B4: ['m1c'],
      B13: ['l1-shape', 'l1-counts', 'l1-sweep'],
      BO2: ['retire-nologin', 'retire-terminate', 'retire-backends', 'retire-revoke', 'retire-checks', 'retire-email'],
      BO4: ['backout-m1c'], BO5: ['backout-m1b'], BO6: ['backout-m1'],
    };
    for (const [id, actions] of Object.entries(perBlock)) {
      const body = block(id);
      for (const action of actions) {
        const plan = new RegExp(`--action=${action} --confirm="[^"]+"\\n`).test(`${body}\n`);
        const exec = new RegExp(`--action=${action} --confirm="[^"]+" --execute`).test(body);
        if (!plan || !exec) failures.push(`${id}: action ${action} needs a plan-only command and a --execute command`);
        if (!runner.built.has(action)) failures.push(`${id}: action ${action} not in the runner source`);
      }
      if (/production SQL route|the production SQL/i.test(body)) failures.push(`${id}: unnamed-route placeholder`);
    }
    // Things the runner does not build must be marked, not given an invented action.
    for (const [id, names] of Object.entries({ B10: ['window-on', 'window-off'], C4: [], BO10: ['security-hardening-backout'] })) {
      const body = block(id);
      need(body, /not decided|no action|has no action/i, `${id}: missing "no Route A action" statement`);
      need(body, /not verified/, `${id}: missing "(not verified: ...)" marker`);
      for (const name of names) if (!runner.missing.has(name)) failures.push(`${id}: ${name} is not listed as not built in the runner source`);
      if (/prod-sql-runner/.test(body)) failures.push(`${id}: cites a runner command for something the runner does not build`);
    }

    // Go-gate prerequisites, each NOT APPROVED with its own go.
    const gateLine = (id) => block(id).split('\n').find((l) => l.startsWith('- **Go-gate:**')) ?? '';
    for (const id of ['A2', 'A3', 'B2', 'B3', 'B4', 'B13', 'BO2', 'BO4', 'BO5', 'BO6']) need(gateLine(id), /GATE-1(?: and GATE-2)? done/, `${id}: go-gate must require GATE-1 (runner branch merged)`);
    need(gateLine('B13'), /GATE-2 done/, 'B13: go-gate must require GATE-2 (inventory capture and classification)');
    need(gateLine('BO2'), /go for GATE-3/, 'BO2: go-gate must require GATE-3 before retire-terminate');
    need(block('BO2'), /GATE-3 first[\s\S]*--action=retire-terminate/, 'BO2: retire-terminate step must name GATE-3 before the command');
    need(block('GATE-1'), new RegExp(`4552557|${RUNNER_TIP}`), 'GATE-1: runner tip missing');
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
  const prodSql = gitShow(RUNNER_FILES.prodSql);
  const stagingRebuilt = gitShow(RUNNER_FILES.stagingRebuilt);
  const failures = checkCutoverRunbook(
    readFileSync(resolve(root, 'docs/build-plan/17-signin-cutover-runbook-draft.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/build-plan/drafts/render-recruiter-web.yaml'), 'utf8'),
    prodSql === undefined || stagingRebuilt === undefined ? undefined : { prodSql, stagingRebuilt },
  );
  if (failures.length) {
    console.error('Cutover runbook contract check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS cutover runbook contract: owner credential isolation, reader-copy lifetime, independent checks, cron/backout go-gates, OPEN-1 closed with every cited Route A action and phrase found in the runner source at ${RUNNER_TIP}; text-level only, no live actions`);
  }
}
