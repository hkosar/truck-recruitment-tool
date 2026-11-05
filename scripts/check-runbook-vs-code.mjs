#!/usr/bin/env node
// Read-only check of a runbook (markdown) against this repo at HEAD. Offline: reads only repo files and the given
// markdown file; runs only `git rev-parse` / `git ls-tree` / `git show` (read-only) in the repo this script lives in, so it
// works from any current folder. Prints one line per finding. Exit codes: 0 no findings, 1 findings, 2 bad usage or an
// unreadable runbook, 3 the check itself crashed (for example git failed). INFO lines (outside-repo citations) never change the exit code.
//
//   node scripts/check-runbook-vs-code.mjs <runbook.md> [--root <dir>]
//
// --root <dir> reads plain files from <dir> instead of `git HEAD` (used by the tests; the default is the repo at HEAD).
// Windows drive paths (C:\...) are matched against the checkout this script lives in (or --root): inside it they are repo paths
// (a missing file is a finding), elsewhere INFO. Run it from the checkout the runbook cites, or cite repo-relative paths.
//
// What is checked (finding names in capitals):
//  REFUSAL   An id in `"refusal":"<id>"` or `refusal=<id>` must be in REFUSAL_IDS (pipeline/src/refusals.ts). A bare
//            `snake_case` code span on a line that contains "refus" must be a refusal id or appear literally in
//            some non-test source file.
//  ACTION    `--action=<name>` must be a key of the staging action registry, or at least appear quoted in the code.
//  CONFIRM   `--confirm=<PHRASE>` must be a quoted literal in the code; when the same line also has --action and the
//            registry (pipeline/src/staging-rebuilt.ts and pipeline/src/role-password.ts) has that action, the phrase must be that action's phrase.
//  EXPECTED  Expected-output lines. Two styles are read:
//              1. A fenced block directly after a line that is just `expected:`, `**Expected:**` or `Expected output:` (any case): every non-empty line.
//              2. The existing runbook style: code spans on lines that start with `PASS`, that are JSON (`{"msg":...}`)
//                 or start with an upper-case word such as EVENT / RUN / SUMMARY / PLAN / ABORTED / REFUSED.
//            `<placeholder>` and `...` match anything. A JSON span must have its "msg" value as a quoted literal in the
//            code and every key as a word in the code. Any other span: every `key=` and every word of 3+ characters
//            (split on | and punctuation) must occur somewhere in the code. This is a word-level check: it catches a
//            misspelt or removed line, not a wrong ordering.
//  CITATION  `path:line`, `path:a-b`, `path:a, b` (a path with an extension, or a bare file name that is unique or
//            at least present in the repo) must name an existing file with at least that many lines. Citations written
//            as `<commit>:path:line` (an older commit) and bare `:123` are not checked.
//  UNMENTIONED  For every code file the runbook cites, each `result=WORD` literal the file prints must appear as WORD
//            somewhere in the runbook (catches a line the code prints that the runbook never mentions, e.g. SKIPPED).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXT = /\.(?:ts|tsx|mjs|js|cjs)$/;
const CITE_EXT = '(?:ts|tsx|mjs|cjs|js|sql|md|json|ps1|yml|yaml|sh|html|css)';

function makeSource(root) {
  if (root) {
    const files = [];
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(p).isDirectory()) walk(p, r); else files.push(r);
      }
    };
    walk(root, '');
    return { top: resolve(root), files, read: (f) => readFileSync(join(root, f), 'utf8') };
  }
  // The repo is the one this script lives in (found with git), whatever the current folder is.
  const run = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const top = run(fileURLToPath(new URL('.', import.meta.url)), 'rev-parse', '--show-toplevel').trim();
  const git = (...a) => run(top, ...a);
  const files = git('ls-tree', '-r', '--name-only', '--full-tree', '-z', 'HEAD').split('\0').filter(Boolean);
  return { top, files, read: (f) => git('show', `HEAD:${f}`) };
}

const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const tail = (s) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);

// Citations of files outside the repo are not findings: a `thr_<id>/...` thread-storage note, or a bare .md name with no folder
// (such as handoff-2026-11-04.md), or a .md path whose first folder is not a top-level folder of the repo. A path under a real
// top-level folder (docs/, scripts/, pipeline/, app/ ...) is always checked. Skipped ones are pushed to the `info` array
// (when given) as `OUTSIDE-REPO line=N <path>`.
// Path forms are normalised first: backslashes become /, a leading ./ is dropped. The first folder is compared without case, and
// a first folder that is a known sub-folder of a top-level folder (build-plan/x.md for docs/build-plan/x.md) also counts as a repo
// path, so a missing file is a finding in all those forms. thr_<id>/ stays info-only.
const normalizePath = (p) => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
const isOutsideRepo = (path, repoDirs) => /^thr_[a-z0-9]+\//.test(path)
  || (/\.md$/.test(path) && !(path.includes('/') && repoDirs.has(path.split('/')[0].toLowerCase())));

export function checkRunbook(markdown, { root, info } = {}) {
  const src = makeSource(root);
  const cache = new Map();
  const read = (f) => { if (!cache.has(f)) cache.set(f, src.read(f)); return cache.get(f); };
  const repoDirs = new Set(src.files.filter((f) => f.includes('/')).flatMap((f) => f.split('/').slice(0, -1).slice(0, 2)).map((d) => d.toLowerCase()));
  const findings = [];
  const add = (check, line, msg) => findings.push(`${check} line=${line} ${msg}`);

  const codeFiles = src.files.filter((f) => CODE_EXT.test(f) && !/\.test\.|(^|\/)(node_modules|dist)\//.test(f) && /^(pipeline\/src|scripts)\//.test(f));
  const corpus = codeFiles.map(read).join('\n');

  const refusalsText = src.files.includes('pipeline/src/refusals.ts') ? read('pipeline/src/refusals.ts') : '';
  const refusalBlock = /REFUSAL_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(refusalsText);
  const refusalIds = new Set(refusalBlock ? [...refusalBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) : []);

  // Action registries: staging-rebuilt.ts, and the role-password actions in role-password.ts.
  const registryText = ['pipeline/src/staging-rebuilt.ts', 'pipeline/src/role-password.ts'].filter((f) => src.files.includes(f)).map(read).join('\n');
  const registry = new Map();
  for (const m of registryText.matchAll(/['"]?([A-Za-z0-9-]+)['"]?:\s*\{[^{}]*?confirmation:\s*'([^']+)'/g)) registry.set(m[1], m[2]);

  const lines = markdown.split('\n');
  const citedCode = new Set();
  const expectedLines = []; // { line, text }

  // Fenced blocks and the `expected:` convention.
  let inFence = false;
  let fenceIsExpected = false;
  let prevNonEmpty = '';
  const fenceLines = new Set();
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/^\s*```/.test(raw)) {
      if (!inFence) { inFence = true; fenceIsExpected = /^\s*[*_]*expected(?:\s+output)?\s*:?\s*[*_]*\s*:?\s*$/i.test(prevNonEmpty); } else { inFence = false; fenceIsExpected = false; }
      fenceLines.add(n);
      return;
    }
    if (inFence) {
      fenceLines.add(n);
      if (fenceIsExpected && raw.trim() !== '') expectedLines.push({ line: n, text: raw.trim() });
      return;
    }
    if (raw.trim() !== '') prevNonEmpty = raw;
  });

  lines.forEach((raw, i) => {
    const n = i + 1;
    const inCode = fenceLines.has(n);

    // REFUSAL (explicit forms)
    for (const m of raw.matchAll(/"refusal"\s*:\s*"([^"]+)"|\brefusal=([A-Za-z0-9_]+)/g)) {
      const id = m[1] ?? m[2];
      if (!refusalIds.has(id)) add('REFUSAL', n, `unknown refusal id ${tail(id)}`);
    }
    // REFUSAL (bare code spans on refusal/STOP lines)
    if (!inCode && /refus/i.test(raw)) {
      for (const m of raw.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
        const id = m[1];
        if (!refusalIds.has(id) && !corpus.includes(id)) add('REFUSAL', n, `unknown refusal id ${tail(id)}`);
      }
    }

    // ACTION / CONFIRM
    const actions = [...raw.matchAll(/--action=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const confirms = [...raw.matchAll(/--confirm=([A-Z0-9][A-Z0-9 -]*[A-Z0-9])/g)].map((m) => m[1]);
    for (const a of actions) {
      if (!registry.has(a) && !corpus.includes(`'${a}'`) && !corpus.includes(`"${a}"`)) add('ACTION', n, `unknown action ${tail(a)}`);
    }
    for (const c of confirms) {
      if (!corpus.includes(`'${c}'`) && !corpus.includes(`"${c}"`)) add('CONFIRM', n, `confirm phrase not in code: ${tail(c)}`);
    }
    if (actions.length === 1 && confirms.length === 1 && registry.has(actions[0]) && registry.get(actions[0]) !== confirms[0]) {
      add('CONFIRM', n, `confirm phrase ${tail(confirms[0])} is not the phrase of action ${actions[0]}`);
    }

    // EXPECTED (existing style)
    if (!inCode && /^\s*(?:[-*]\s+)?\**PASS\b/.test(raw)) {
      for (const m of raw.matchAll(/`([^`]+)`/g)) {
        const t = m[1].trim();
        if (t.startsWith('{') || /^[A-Z][A-Z-]*(?:\s[A-Z]+)?(?:\s|$)/.test(t)) {
          if (/^PASS\b/.test(t)) continue;
          expectedLines.push({ line: n, text: t });
        }
      }
    }

    // CITATION
    // A checked folder whose own path contains spaces (a TEMP folder such as C:\Users\Jo Smith\...) cannot match the space-free path pattern,
    // so that exact folder path (either slash, any letter case) is one more allowed start of a path. No text is rewritten, so nothing can collide.
    // The same holds for a folder name with any character the path pattern does not allow (+ $ ^ , & = # % [ ] ( ) ...).
    let rootAlt = '';
    let midRoots = []; // [start, end) spans of the root written mid-token (glued to a path character before it); a match starting inside one is not a repo path
    if (/[^A-Za-z0-9_.:\\/-]/.test(src.top)) {
      const rootPattern = src.top.replace(/[\\/]+$/, '').replace(/[\\/]|[.*+?^${}()|[\]]|[A-Za-z]/g, (c) => (c === '\\' || c === '/' ? '[\\\\/]' : /[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : `\\${c}`));
      rootAlt = `${rootPattern}[A-Za-z0-9_.-]*[\\\\/]|`; // the optional name characters let a sibling such as "<root>-old" be read whole (then it is outside, not inside)
      for (const rm of raw.matchAll(new RegExp(rootPattern, 'g'))) if (rm.index > 0 && /[A-Za-z0-9_./\\-]/.test(raw[rm.index - 1])) midRoots.push([rm.index, rm.index + rm[0].length]);
    }
    const re = new RegExp(`(^|[^A-Za-z0-9_./\\\\-])((?:[0-9a-f]{7,40}:)?)((?:${rootAlt}[A-Za-z]:[/\\\\])?(?:[A-Za-z0-9_.-]+[/\\\\])*[A-Za-z0-9_.-]+\\.${CITE_EXT}):(\\d+(?:-\\d+)?(?:, ?\\d+(?:-\\d+)?)*)`, 'g');
    for (const m of raw.matchAll(re)) {
      if (m[2]) continue; // older commit
      const start = m.index + m[1].length;
      if (midRoots.some(([a, b]) => start > a && start < b)) continue; // fragment of a mid-token root
      let path = normalizePath(m[3]);
      let insideByDrive = false;
      if (/^[A-Za-z]:\//.test(path)) { // Windows drive path: a repo path when inside the folder being checked, otherwise INFO
        const top = posix.normalize(normalizePath(src.top)).replace(/\/+$/, '');
        path = posix.normalize(path); // drops `.` segments and resolves `..`; a path that climbs above the drive root loses its drive and is INFO
        if (path.toLowerCase().startsWith(`${top.toLowerCase()}/`)) { path = path.slice(top.length + 1); insideByDrive = true; }
        else { if (info) info.push(`OUTSIDE-REPO line=${n} not a repo file, not checked: ${tail(path)}`); continue; }
      }
      // a short relative path may stand for a deeper file (suffix match); a full drive path names its location, so only the exact file counts
      let matches = src.files.filter((f) => f === path || (!insideByDrive && f.endsWith(`/${path}`)));
      const exact = matches.filter((f) => f === path);
      if (exact.length) matches = exact;
      if (!matches.length) {
        if (!insideByDrive && isOutsideRepo(path, repoDirs)) { if (info) info.push(`OUTSIDE-REPO line=${n} not a repo file, not checked: ${tail(path)}`); continue; }
        add('CITATION', n, `file not found: ${tail(path)}`); continue;
      }
      const counts = matches.map((f) => lineCount(read(f)));
      const max = Math.max(...counts);
      let ok = true;
      for (const part of m[4].split(/, ?/)) {
        const [a, b] = part.split('-').map(Number);
        const hi = b ?? a;
        if (a < 1 || hi < a || hi > max) { ok = false; add('CITATION', n, `${tail(path)}:${part} outside file (${max} lines)`); }
      }
      if (ok) for (const f of matches) if (CODE_EXT.test(f)) citedCode.add(f);
    }
  });

  // EXPECTED checks
  const words = (t) => t.split(/[^A-Za-z0-9_.\-/]+/).filter((w) => w.length >= 3 && !/^[.\-/]+$/.test(w));
  for (const { line, text } of expectedLines) {
    const bare = text.replace(/<[^>]*>/g, ' ').replace(/\.\.\.|…/g, ' ');
    let json = null;
    if (text.startsWith('{')) { try { json = JSON.parse(text); } catch { json = null; } }
    const missing = [];
    if (json && typeof json === 'object') {
      if (typeof json.msg === 'string' && !corpus.includes(`'${json.msg}'`) && !corpus.includes(`"${json.msg}"`) && !corpus.includes(`\`${json.msg}\``)) missing.push(`msg ${json.msg}`);
      for (const k of Object.keys(json)) if (!new RegExp(`\\b${k.replace(/[^A-Za-z0-9_]/g, '.')}\\b`).test(corpus)) missing.push(`key ${k}`);
    } else {
      for (const tok of bare.split(/\s+/)) {
        const km = /^([A-Za-z_]+)=/.exec(tok);
        if (km && !corpus.includes(`${km[1]}=`)) missing.push(`${km[1]}=`);
      }
      for (const w of words(bare)) if (!corpus.includes(w)) missing.push(w);
    }
    if (missing.length) add('EXPECTED', line, `not in code: ${[...new Set(missing)].slice(0, 4).map(tail).join(', ')} (line: ${tail(text)})`);
  }

  // UNMENTIONED result= values of cited code files
  for (const f of [...citedCode].sort()) {
    const vals = new Set([...read(f).matchAll(/result=([A-Z][A-Z_]+)/g)].map((m) => m[1]));
    for (const v of vals) if (!new RegExp(`\\b${v}\\b`).test(markdown)) add('UNMENTIONED', 0, `${f} prints result=${v}; the runbook never mentions ${v}`);
  }

  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let root;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = args[++i]; else rest.push(args[i]);
  }
  if (rest.length !== 1 || (args.includes('--root') && !root)) {
    console.error('usage: node scripts/check-runbook-vs-code.mjs <runbook.md> [--root <dir>]');
    process.exit(2);
  }
  let md;
  try { md = readFileSync(rest[0], 'utf8'); } catch { console.error('cannot read the runbook file'); process.exit(2); }
  let findings;
  const info = [];
  try { findings = checkRunbook(md, { root, info }); } catch (e) {
    console.error(`INTERNAL ERROR (the check itself crashed; this is not a finding): ${String(e && e.message).split('\n')[0]}`);
    process.exit(3);
  }
  for (const f of findings) console.log(`FINDING ${f}`);
  for (const i of info) console.log(`INFO ${i}`);
  console.log(`SUMMARY findings=${findings.length} info=${info.length}`);
  process.exit(findings.length ? 1 : 0);
}
