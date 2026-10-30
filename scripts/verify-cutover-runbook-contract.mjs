#!/usr/bin/env node
// Offline documentation guard only. No SQL, secrets, subprocesses or network access.
// This does not approve a live step or verify a hosted config, cron or candidate tool.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkCutoverRunbook(runbook, yaml) {
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
  need(runbook, /OPEN-1 — How production SQL gets run \(no route is recorded\)/, 'OPEN-1 must remain undecided');
  need(runbook, /mail provider is \*\*SendGrid\*\*/, 'SendGrid decision missing');
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const failures = checkCutoverRunbook(
    readFileSync(resolve(root, 'docs/build-plan/17-signin-cutover-runbook-draft.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/build-plan/drafts/render-recruiter-web.yaml'), 'utf8'),
  );
  if (failures.length) {
    console.error('Cutover runbook contract check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('PASS cutover runbook contract: owner credential isolation, reader-copy lifetime, independent checks and cron/backout go-gates; text-level only, no live actions');
  }
}
