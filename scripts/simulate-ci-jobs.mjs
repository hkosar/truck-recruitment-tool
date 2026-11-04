// Fresh-clone CI job simulator (TRUCKRECRU-136). Offline: reads .github/workflows/ci.yml and answers "does each job install what its steps need?"
//
// Mode 1 (default, static):  node scripts/simulate-ci-jobs.mjs [--ref <git ref>] [--workflow <path>] [--job <id>]
//   For each job, lists which package folders (a folder with a package.json, e.g. app, pipeline) the job installs and before which run steps,
//   then flags every run step that needs a package folder's node_modules that the job has not installed by then. A step "needs" a package when it
//     - runs npm run / npm test / npm start / npm exec / npx in that folder (its working-directory), or
//     - runs (or globs to) a node script, or a script's relative import, that builds a path under app/node_modules or pipeline/node_modules
//       (join(pipeline, 'node_modules', ...), join(root, 'app', 'node_modules', ...), "pipeline/node_modules/..."), or
//     - runs (or imports, relatively) a script with a bare import of an installed package (resolved from the nearest folder with a package.json,
//       else the repository root, which no job installs).
//   Relative imports are NOT followed by default (a library module often builds those paths only inside functions its importer never calls,
//   e.g. verify-real-db-suites-contract.mjs importing run-real-db-suites.mjs); --follow-imports follows them and is noisier.
//   Limits: a heuristic on text. Paths assembled from other pieces, scripts one script spawns by name, and shell features beyond the commands
//   listed below are not followed. The workflow parser knows only the shape of this repository's ci.yml and THROWS on anything else
//   (unknown keys, flow collections, tabs, anchors, matrix, needs, env, if, ...), and so does the command reader (cd, unknown commands, unknown npm sub-commands).
//   --ref reads the workflow and every file from that commit (git show / ls-tree), so a past commit can be checked without checking it out.
//
//   Inside an npm script body (package.json) the command reader also accepts package binaries (eslint, tsc, vite, ...), which need that package.
// Mode 2 (--run, local only): node scripts/simulate-ci-jobs.mjs --run --node 22=<node.exe> --node 24=<node.exe> --borrow <worktree root> [--job <id>] [--timeout-ms N]
//   For each job and each Node version: a fresh `git clone --no-hardlinks` of this repository's HEAD into a temp folder (no node_modules anywhere),
//   junctions in ONLY the packages the job installs (from the --borrow worktree's node_modules, read-only), runs the job's run steps with bash -e
//   (install steps are replaced by the junction; "uses:" steps are skipped), reports pass/fail, and deletes the clone. Uncommitted changes are NOT in the clone.
//   Child processes get NODE_OPTIONS removed (one script test asserts that); the simulator does not itself block the network, so run it
//   under your own guard (node --import file:///.../scripts/net-guard.mjs scripts/simulate-ci-jobs.mjs --run ...). No GitHub, no network of its own.
//
// Exit: 0 clean / all passed, 1 a job is flagged or a run failed, 2 usage or an unreadable workflow.

import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class SimError extends Error {}
const fail = (msg) => { throw new SimError(msg); };

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The workflow reader: a small indentation parser for block mappings, block sequences, scalars and `|` block scalars.
// ---------------------------------------------------------------------------------------------------------------------------------

function unquote(v, lineNo) {
  const q = v[0];
  if (q === '"' || q === "'") {
    if (v.length < 2 || v[v.length - 1] !== q) fail(`line ${lineNo}: unterminated quoted value: ${v}`);
    return v.slice(1, -1);
  }
  if (/^[\[{&*!>%@`]/.test(v)) fail(`line ${lineNo}: YAML feature not understood (flow collection, anchor, alias, tag or folded scalar): ${v}`);
  if (/\s#/.test(v)) fail(`line ${lineNo}: trailing comment on a value is not understood: ${v}`);
  return v;
}

/** Parses the YAML subset used by ci.yml into plain objects / arrays / strings / null. Throws SimError on anything else. */
export function parseYaml(text) {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = raw.map((r, i) => {
    if (/\t/.test(r.match(/^\s*/)[0])) fail(`line ${i + 1}: tab indentation is not understood`);
    const body = r.trim();
    return { n: i + 1, raw: r, indent: r.length - r.trimStart().length, text: body, skip: body === '' || body.startsWith('#') };
  });
  let i = 0;
  const peek = () => { while (i < lines.length && lines[i].skip) i += 1; return i < lines.length ? lines[i] : null; };

  function blockScalar(parentIndent, header, startLine) {
    if (!/^\|[-+]?$/.test(header)) fail(`line ${startLine}: only the "|" block scalar is understood, got: ${header}`);
    const body = [];
    let base = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() === '') { body.push(''); i += 1; continue; }
      if (l.indent <= parentIndent) break;
      if (base === null) base = l.indent;
      if (l.indent < base) fail(`line ${l.n}: block scalar indentation is inconsistent`);
      body.push(l.raw.slice(base));
      i += 1;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    return body.join('\n') + '\n';
  }

  function value(l, rest, parentIndent) {
    i += 1;
    if (rest === '' || rest === undefined) {
      const nx = peek();
      if (nx && nx.indent > parentIndent) return block(nx.indent);
      if (nx && nx.indent === parentIndent && nx.text.startsWith('- ')) fail(`line ${nx.n}: a sequence at the same indent as its key is not understood`);
      return null;
    }
    if (rest.startsWith('|')) return blockScalar(parentIndent, rest, l.n);
    return unquote(rest, l.n);
  }

  function mapping(indent) {
    const out = {};
    for (let l = peek(); l && l.indent === indent && !l.text.startsWith('- '); l = peek()) {
      const m = /^([A-Za-z0-9_.-]+):(?: +(.*))?$/.exec(l.text);
      if (!m) fail(`line ${l.n}: not a "key: value" line: ${l.text}`);
      if (Object.hasOwn(out, m[1])) fail(`line ${l.n}: duplicate key ${m[1]}`);
      out[m[1]] = value(l, m[2], indent);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (let l = peek(); l && l.indent === indent && l.text.startsWith('- '); l = peek()) {
      const rest = l.text.slice(2);
      if (rest.startsWith(' ') || rest === '') fail(`line ${l.n}: "-" must be followed by exactly one space and a value`);
      if (/^[A-Za-z0-9_.-]+:(?: |$)/.test(rest)) {
        lines[i] = { ...l, indent: indent + 2, text: rest, raw: ' '.repeat(indent + 2) + rest };
        out.push(mapping(indent + 2));
      } else { i += 1; out.push(unquote(rest, l.n)); }
    }
    return out;
  }

  function block(indent) {
    const l = peek();
    if (!l || l.indent !== indent) fail(`line ${l ? l.n : lines.length}: unexpected indentation`);
    return l.text.startsWith('- ') ? sequence(indent) : mapping(indent);
  }

  const first = peek();
  if (!first) fail('the workflow is empty');
  const doc = block(first.indent);
  const extra = peek();
  if (extra) fail(`line ${extra.n}: unexpected content: ${extra.text}`);
  return doc;
}

const JOB_KEYS = new Set(['name', 'runs-on', 'defaults', 'steps']);
const STEP_KEYS = new Set(['name', 'uses', 'with', 'run', 'working-directory']);

/** ci.yml text -> [{ id, name, defaultCwd, steps: [{ index, name, uses, run, cwd }] }]. Throws on any key it does not know. */
export function parseWorkflow(text) {
  const doc = parseYaml(text);
  for (const k of Object.keys(doc)) if (!['name', 'on', 'permissions', 'jobs'].includes(k)) fail(`top-level key not understood: ${k}`);
  if (!doc.jobs || typeof doc.jobs !== 'object' || Array.isArray(doc.jobs)) fail('no jobs: mapping');
  return Object.entries(doc.jobs).map(([id, job]) => {
    if (!job || typeof job !== 'object' || Array.isArray(job)) fail(`job ${id}: not a mapping`);
    for (const k of Object.keys(job)) if (!JOB_KEYS.has(k)) fail(`job ${id}: key not understood: ${k}`);
    let defaultCwd = null;
    if (job.defaults !== undefined) {
      const d = job.defaults;
      if (!d || Object.keys(d).join() !== 'run' || !d.run || Object.keys(d.run).join() !== 'working-directory' || typeof d.run['working-directory'] !== 'string') {
        fail(`job ${id}: defaults must be exactly run: working-directory: <folder>`);
      }
      defaultCwd = d.run['working-directory'];
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) fail(`job ${id}: no steps`);
    const steps = job.steps.map((s, index) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) fail(`job ${id} step ${index + 1}: not a mapping`);
      for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) fail(`job ${id} step ${index + 1}: key not understood: ${k}`);
      if ((s.uses === undefined) === (s.run === undefined)) fail(`job ${id} step ${index + 1}: needs exactly one of uses / run`);
      if (s.uses !== undefined && s['working-directory'] !== undefined) fail(`job ${id} step ${index + 1}: working-directory on a uses step is not understood`);
      return { index, name: s.name ?? s.uses ?? `step ${index + 1}`, uses: s.uses ?? null, with: s.with ?? null, run: s.run ?? null, cwd: s['working-directory'] ?? defaultCwd ?? '.' };
    });
    return { id, name: job.name ?? id, defaultCwd, steps };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Sources of files: a folder on disk, a git commit, or a map in memory (tests).
// ---------------------------------------------------------------------------------------------------------------------------------

const norm = (p) => { const n = posix.normalize(p.replace(/\\/g, '/')).replace(/\/$/, ''); return n === '' ? '.' : n.replace(/^\.\//, ''); };

export function memSource(files) {
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return { label: 'memory', list: () => [...map.keys()], has: (p) => map.has(norm(p)), read: (p) => { if (!map.has(norm(p))) fail(`missing file: ${p}`); return map.get(norm(p)); } };
}

export function fsSource(root) {
  const walk = (dir, rel, out) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, out);
      else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
    return out;
  };
  let files = null;
  return {
    label: root,
    list: () => (files ??= walk(root, '', [])),
    has: (p) => existsSync(join(root, norm(p))),
    read: (p) => { try { return readFileSync(join(root, norm(p)), 'utf8'); } catch { return fail(`missing file: ${p}`); } },
  };
}

export function gitSource(repo, ref) {
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ls = git(['ls-tree', '-r', '--name-only', ref]);
  if (ls.status !== 0) fail(`git ls-tree ${ref} failed: ${ls.stderr.trim()}`);
  const files = ls.stdout.split('\n').filter(Boolean);
  const set = new Set(files);
  const cache = new Map();
  return {
    label: `git ${ref}`,
    list: () => files,
    has: (p) => set.has(norm(p)),
    read: (p) => {
      const key = norm(p);
      if (!set.has(key)) fail(`missing file at ${ref}: ${p}`);
      if (!cache.has(key)) { const r = git(['show', `${ref}:${key}`]); if (r.status !== 0) fail(`git show ${ref}:${key} failed`); cache.set(key, r.stdout); }
      return cache.get(key);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Commands of a run step.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Splits one script line on unquoted ; && || into segments of tokens (quotes removed). */
export function splitSegments(line) {
  const segs = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let q = null;
  const endTok = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  const endSeg = () => { endTok(); if (tokens.length) segs.push(tokens); tokens = []; };
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '#' && !has) break;
    if (/\s/.test(c)) { endTok(); continue; }
    if (c === ';') { endSeg(); continue; }
    if ((c === '&' || c === '|') && line[k + 1] === c) { endSeg(); k += 1; continue; }
    cur += c; has = true;
  }
  if (q) fail(`unterminated quote in: ${line}`);
  endSeg();
  return segs;
}

const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done']);
const NPM_RUNS = new Set(['run', 'run-script', 'test', 't', 'start', 'exec']);
const NPM_INSTALLS = new Set(['ci', 'install', 'i']);
const JS_EXT = /\.(mjs|cjs|js|mts|cts|ts)$/;

/** One run block + its working folder -> [{ kind: 'install'|'npm-run'|'npx'|'files', ... }]. Throws on commands it does not model. */
export function readCommands(runText, cwd, bins = false) {
  const out = [];
  for (const rawLine of runText.split('\n')) {
    for (let seg of splitSegments(rawLine)) {
      while (seg.length && ['then', 'else', 'do'].includes(seg[0])) seg = seg.slice(1);
      while (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0])) seg = seg.slice(1);
      if (!seg.length) continue;
      const [cmd, ...args] = seg;
      if (cmd === 'echo' || cmd === '[' || cmd === 'test' || cmd === ':') continue;
      if (CONTROL.has(cmd)) {
        if (cmd === 'for') {
          const at = args.indexOf('in');
          if (at > 0) out.push({ kind: 'files', cwd, tokens: args.slice(at + 1) });
        } else if ((cmd === 'if' || cmd === 'elif') && (args[0] === '[' || args[0] === 'test')) { /* a file test, nothing to run */ } else if (cmd === 'if' || cmd === 'while' || cmd === 'elif') fail(`unsupported shell condition in: ${rawLine.trim()}`);
        continue;
      }
      if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') fail(`"${cmd}" changes the working folder and is not modelled: ${rawLine.trim()}`);
      if (cmd === 'node') {
        const tokens = [];
        for (let k = 0; k < args.length; k += 1) {
          if (['-e', '--eval', '-p', '--print', '-r', '--require', '--import'].includes(args[k])) { k += 1; continue; }
          if (args[k].startsWith('-')) continue;
          tokens.push(args[k]);
        }
        out.push({ kind: 'files', cwd, tokens });
      } else if (cmd === 'npm') {
        const sub = args[0];
        if (NPM_INSTALLS.has(sub)) {
          const p = args.indexOf('--prefix');
          out.push({ kind: 'install', dir: p >= 0 ? posix.join(cwd, args[p + 1] ?? fail(`--prefix without a folder: ${rawLine.trim()}`)) : cwd });
        } else if (NPM_RUNS.has(sub)) {
          const script = sub === 'run' || sub === 'run-script' ? args.find((a, k) => k > 0 && !a.startsWith('-')) ?? fail(`npm run without a script: ${rawLine.trim()}`) : (sub === 'exec' ? null : sub === 't' ? 'test' : sub);
          out.push({ kind: 'npm-run', cwd, script, text: rawLine.trim() });
        } else fail(`npm sub-command not understood: ${args[0]} in: ${rawLine.trim()}`);
      } else if (cmd === 'npx') out.push({ kind: 'npx', cwd, text: rawLine.trim() });
      else if (!bins) fail(`command not understood: ${cmd} in: ${rawLine.trim()}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. What a script needs.
// ---------------------------------------------------------------------------------------------------------------------------------

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const PKG_OF_JOIN_VAR = /join\(\s*(?:\w+\.)?(app|pipeline)\w*\s*,\s*['"]node_modules['"]/;
const PKG_OF_JOIN_LIST = /join\([^)]*['"](app|pipeline)['"]\s*,\s*['"]node_modules['"]/;
const PKG_OF_STRING = /['"`][^'"`\n]*\b(app|pipeline)\/node_modules\b/;
const BARE_IMPORT = [/^\s*(?:import|export)\b[^'"`]*?from\s*['"]([^'"]+)['"]/, /^\s*import\s*['"]([^'"]+)['"]/];
const REL_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function ownerPackage(src, file) {
  for (let dir = posix.dirname(norm(file)); ; dir = posix.dirname(dir)) {
    if (dir !== '.' && src.has(`${dir}/package.json`)) return dir;
    if (dir === '.' || dir === '/') return '.';
  }
}

/** Needs of one script file and the files it imports with a relative path: [{ pkg, file, line, text, why }]. */
export function needsOfFile(src, file, seen = new Set(), follow = false) {
  const f = norm(file);
  if (seen.has(f) || !JS_EXT.test(f)) return [];
  seen.add(f);
  const out = [];
  const lines = src.read(f).split('\n');
  lines.forEach((text, k) => {
    const t = text.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const m = PKG_OF_JOIN_VAR.exec(t) ?? PKG_OF_JOIN_LIST.exec(t) ?? PKG_OF_STRING.exec(t);
    if (m) out.push({ pkg: m[1], file: f, line: k + 1, text: t, why: `uses ${m[1]}/node_modules` });
    for (const re of BARE_IMPORT) {
      const b = re.exec(t);
      // `node:`-prefixed names are always built in (builtinModules on Node 22 omits prefix-only ones such as node:test).
      if (b && !b[1].startsWith('.') && !b[1].startsWith('/') && !b[1].startsWith('node:') && !BUILTINS.has(b[1])) {
        const pkg = ownerPackage(src, f);
        out.push({ pkg, file: f, line: k + 1, text: t, why: `imports the package "${b[1]}", installed under ${pkg === '.' ? 'the repository root (no job installs there)' : `${pkg}/node_modules`}` });
      }
    }
    for (const r of follow ? t.matchAll(REL_IMPORT) : []) {
      const target = norm(posix.join(posix.dirname(f), r[1]));
      const hit = [target, `${target}.mjs`, `${target}.js`, `${target}.ts`].find((c) => src.has(c) && JS_EXT.test(c));
      if (hit) out.push(...needsOfFile(src, hit, seen, follow));
    }
  });
  return out;
}

/** Expands one file token (no `**`; `*` and `?` inside a path segment) relative to cwd; a token that is not a script path expands to []. */
export function expandToken(src, cwd, token) {
  if (/[$`(){}~]/.test(token) && !/[*?]/.test(token)) return [];
  if (token.includes('**')) fail(`"**" glob is not understood: ${token}`);
  const isGlob = /[*?]/.test(token);
  if (!isGlob && !JS_EXT.test(token)) return [];
  const rel = norm(posix.join(cwd, token));
  if (!isGlob) { if (!src.has(rel)) fail(`${token} (from ${cwd}) does not exist`); return [rel]; }
  const re = new RegExp(`^${rel.split('/').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/')}$`);
  const hits = src.list().filter((p) => re.test(p) && JS_EXT.test(p));
  if (!hits.length) fail(`the pattern ${token} (from ${cwd}) matches no script file`);
  return hits;
}

function scriptsOf(src, dir) {
  if (!src.has(`${dir}/package.json`)) return null;
  return JSON.parse(src.read(`${dir}/package.json`)).scripts ?? {};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The analysis.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Walks the jobs' steps in order. Returns [{ id, name, installs: [{ pkg, step }], steps: [{ index, name, installed: [...], needs: [...], flags: [...] }], flagged }].
 * needs: [{ pkg, why, file?, line?, text? }]; a flag is a need whose pkg was not installed by an EARLIER step of the same job.
 */
export function analyze(src, jobs, { follow = false } = {}) {
  return jobs.map((job) => {
    const installed = new Set();
    const installs = [];
    const steps = [];
    for (const step of job.steps) {
      const rec = { index: step.index, name: step.name, uses: step.uses, installedBefore: [...installed].sort(), needs: [], flags: [], installs: [] };
      steps.push(rec);
      if (step.run === null) continue;
      const cwd = norm(step.cwd);
      const pending = [];
      for (const c of readCommands(step.run, cwd)) {
        if (c.kind === 'install') {
          const dir = norm(c.dir);
          if (!src.has(`${dir}/package.json`)) fail(`job ${job.id} step "${step.name}": installs in ${dir}, which has no package.json`);
          if (!pending.includes(dir)) pending.push(dir);
        } else if (c.kind === 'npm-run' || c.kind === 'npx') {
          if (!src.has(`${c.cwd}/package.json`)) fail(`job ${job.id} step "${step.name}": "${c.text}" runs in ${c.cwd}, which has no package.json`);
          rec.needs.push({ pkg: c.cwd, why: `${c.text} runs from ${c.cwd}/node_modules` });
          if (c.kind === 'npm-run' && c.script) {
            const body = scriptsOf(src, c.cwd)[c.script];
            if (body === undefined) fail(`job ${job.id} step "${step.name}": ${c.cwd}/package.json has no script "${c.script}"`);
            for (const sub of readCommands(body, c.cwd, true)) {
              if (sub.kind === 'files') for (const t of sub.tokens) for (const f of expandToken(src, sub.cwd, t)) rec.needs.push(...needsOfFile(src, f, new Set(), follow));
              else if (sub.kind === 'npm-run' || sub.kind === 'npx') { /* same package */ }
            }
          }
        } else if (c.kind === 'files') {
          for (const t of c.tokens) for (const f of expandToken(src, c.cwd, t)) rec.needs.push(...needsOfFile(src, f, new Set(), follow));
        }
      }
      for (const n of rec.needs) if (!installed.has(n.pkg)) rec.flags.push(n);
      for (const dir of pending) { installed.add(dir); installs.push({ pkg: dir, step: step.name }); rec.installs.push(dir); }
    }
    return { id: job.id, name: job.name, installs, installedAll: [...installed].sort(), steps, flagged: steps.some((s) => s.flags.length > 0) };
  });
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((n) => { const k = `${n.pkg}|${n.file ?? ''}|${n.line ?? ''}|${n.why}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function formatReport(label, results) {
  const out = [`Workflow source: ${label}`];
  for (const j of results) {
    out.push('', `job ${j.id} ("${j.name}"): installs ${j.installs.length ? j.installs.map((i) => `${i.pkg} (step "${i.step}")`).join(', ') : 'NOTHING'}`);
    for (const s of j.steps) {
      if (s.uses) { out.push(`  ${s.index + 1}. ${s.name}  [uses]`); continue; }
      const bits = [];
      if (s.installs.length) bits.push(`installs ${s.installs.join(', ')}`);
      const needs = dedupe(s.needs);
      if (needs.length) bits.push(`needs ${[...new Set(needs.map((n) => n.pkg))].join(', ')}`);
      out.push(`  ${s.index + 1}. ${s.name}  [${bits.join('; ') || 'no package use'}; installed before: ${s.installedBefore.join(', ') || 'nothing'}]`);
      for (const f of dedupe(s.flags)) {
        out.push(`     FLAG: needs ${f.pkg === '.' ? 'the repository root' : f.pkg}/node_modules but the job has not installed it - ${f.why}${f.file ? ` (${f.file}:${f.line})` : ''}`);
      }
    }
    out.push(j.flagged ? `  => job ${j.id}: FLAGGED` : `  => job ${j.id}: clean`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Mode 2: a fresh clone per job and Node version.
// ---------------------------------------------------------------------------------------------------------------------------------

export function findBash() {
  if (process.env.CI_SIM_BASH) return process.env.CI_SIM_BASH;
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
    fail('Git Bash not found (set CI_SIM_BASH)');
  }
  return 'bash';
}

function removeLink(p) {
  try { rmdirSync(p); } catch { unlinkSync(p); }
}

/** Runs one job once in a fresh clone. nodeExe: node binary to put first on PATH. Returns { ok, steps: [{ name, status, output }] }. */
export function runJob({ repo, sha, job, result, nodeExe, borrow, timeoutMs, workflowPath }) {
  const dir = mkdtempSync(join(tmpdir(), `ci-sim-${job.id}-`));
  const links = [];
  const steps = [];
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', repo, dir], { encoding: 'utf8' });
    if (clone.status !== 0) fail(`git clone failed: ${clone.stderr}`);
    const co = spawnSync('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], { encoding: 'utf8' });
    if (co.status !== 0) fail(`git checkout ${sha} failed: ${co.stderr}`);
    if (existsSync(join(dir, 'node_modules')) || result.installedAll.some((p) => existsSync(join(dir, p, 'node_modules')))) fail('the clone already has a node_modules');
    for (const pkg of result.installedAll) {
      const from = join(borrow, pkg, 'node_modules');
      if (!existsSync(from)) fail(`--borrow has no ${pkg}/node_modules to link`);
      const to = join(dir, pkg, 'node_modules');
      symlinkSync(from, to, 'junction');
      links.push(to);
    }
    const env = { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', PATH: `${dirname(nodeExe)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
    delete env.NODE_OPTIONS;
    let ok = true;
    for (const step of job.steps) {
      if (step.run === null) { steps.push({ name: step.name, status: 'skipped (uses: action)', output: '' }); continue; }
      const cmds = readCommands(step.run, norm(step.cwd));
      if (cmds.some((c) => c.kind === 'install')) { steps.push({ name: step.name, status: 'skipped (install replaced by junction)', output: '' }); continue; }
      if (!ok) { steps.push({ name: step.name, status: 'not run (earlier step failed)', output: '' }); continue; }
      const r = spawnSync(findBash(), ['-e', '-c', step.run], { cwd: join(dir, step.cwd), env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
      const pass = r.status === 0 && !r.error;
      steps.push({ name: step.name, status: pass ? 'passed' : `FAILED (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`, output });
      if (!pass) ok = false;
    }
    return { ok, steps };
  } finally {
    for (const l of links) { try { removeLink(l); } catch { /* reported below */ } }
    const leftover = links.filter((l) => { try { lstatSync(l); return true; } catch { return false; } });
    if (leftover.length) process.stderr.write(`NOT deleting ${dir}: a junction could not be removed (${leftover.join(', ')})\n`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. The command line.
// ---------------------------------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { ref: null, workflow: '.github/workflows/ci.yml', job: null, follow: false, run: false, node: {}, borrow: null, timeoutMs: 15 * 60 * 1000 };
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k];
    const next = () => argv[(k += 1)] ?? fail(`${a} needs a value`);
    if (a === '--run') o.run = true;
    else if (a === '--follow-imports') o.follow = true;
    else if (a === '--ref') o.ref = next();
    else if (a === '--workflow') o.workflow = next();
    else if (a === '--job') o.job = next();
    else if (a === '--borrow') o.borrow = next();
    else if (a === '--timeout-ms') o.timeoutMs = Number(next());
    else if (a === '--node') { const m = /^(\d+)=(.+)$/.exec(next()); if (!m) fail('--node takes <major>=<path to node>'); o.node[m[1]] = m[2]; }
    else fail(`unknown argument: ${a}`);
  }
  if (o.run && o.ref) fail('--run always uses HEAD of this repository; drop --ref');
  if (o.run && (!o.borrow || !Object.keys(o.node).length)) fail('--run needs --borrow <worktree with node_modules> and at least one --node <major>=<path>');
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) fail('--timeout-ms must be a positive number');
  return o;
}

export function main(argv, repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), io = { out: (s) => process.stdout.write(`${s}\n`) }) {
  const o = parseArgs(argv);
  const src = o.ref ? gitSource(repo, o.ref) : fsSource(repo);
  const jobs = parseWorkflow(src.read(o.workflow)).filter((j) => !o.job || j.id === o.job);
  if (!jobs.length) fail(`no job matches ${o.job}`);
  const results = analyze(src, jobs, { follow: o.follow });
  io.out(formatReport(src.label, results));
  let bad = results.some((r) => r.flagged);
  if (!o.run) { io.out(bad ? '\nRESULT: FLAGGED' : '\nRESULT: clean'); return bad ? 1 : 0; }
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  io.out(`\nRunning against a fresh clone of HEAD ${sha} (uncommitted changes are not included)`);
  for (const job of jobs) {
    const result = results.find((r) => r.id === job.id);
    for (const [major, exe] of Object.entries(o.node)) {
      const r = runJob({ repo, sha, job, result, nodeExe: exe, borrow: o.borrow, timeoutMs: o.timeoutMs });
      io.out(`\n=== job ${job.id} on Node ${major}: ${r.ok ? 'PASS' : 'FAIL'} (junctions: ${result.installedAll.join(', ') || 'none'}) ===`);
      for (const s of r.steps) {
        io.out(`  - ${s.name}: ${s.status}`);
        if (s.status.startsWith('FAILED')) io.out(s.output.split('\n').map((l) => `      | ${l}`).join('\n'));
      }
      if (!r.ok) bad = true;
    }
  }
  io.out(bad ? '\nRESULT: FAILED' : '\nRESULT: all passed');
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof SimError)) throw e;
    process.stderr.write(`simulate-ci-jobs: ${e.message}\n`);
    process.exitCode = 2;
  }
}
