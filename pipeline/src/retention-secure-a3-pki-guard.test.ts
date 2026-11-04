// LOCAL test (TRUCKRECRU-33 fix): the key-folder rule of retention-secure-a3-make-pki.ts. No database, no network. Uses a temp folder
// of its own (removed at the end; junction/symlink entries are removed link-only) and runs the real helper as a child process for
// the end-to-end refusals, so nothing it writes can land in the repository.
// Run: npx tsx src/retention-secure-a3-pki-guard.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepository, isInsideRepository } from './retention-secure-a3-pki-guard.js';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';

const HELPER = fileURLToPath(new URL('./retention-secure-a3-make-pki.ts', import.meta.url));
const PIPELINE_DIR = fileURLToPath(new URL('..', import.meta.url));
const made: string[] = [];
const links: string[] = [];
const sandbox = mkdtempSync(join(tmpdir(), 'pki-guard-'));

function refuses(dir: string | undefined, label: string): void {
  assert.throws(() => assertOutsideRepository(dir, REPOSITORY_ROOT), /refusing|usage/, `${label} must be refused`);
}
function runHelper(dir: string | undefined): { status: number | null; out: string } {
  const args = ['--import', 'tsx', HELPER, ...(dir === undefined ? [] : [dir])];
  const r = spawnSync(process.execPath, args, { cwd: PIPELINE_DIR, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

try {
  // The 7 cases the reviewer already checked.
  refuses(undefined, 'no argument');
  refuses('relative/folder', 'a relative path');
  refuses(join(REPOSITORY_ROOT, 'pipeline', 'x'), 'a folder under pipeline');
  refuses(REPOSITORY_ROOT, 'the repository root itself');
  refuses(join(REPOSITORY_ROOT, 'pipeline', '..', 'x-' + process.pid), 'a path reaching into the repository through .. segments');
  const nonEmpty = join(sandbox, 'nonempty');
  mkdirSync(nonEmpty);
  writeFileSync(join(nonEmpty, 'keep.txt'), 'x');
  const ne = runHelper(nonEmpty);
  assert.equal(ne.status, 1, 'non-empty folder: exit 1');
  assert.match(ne.out, /not empty/);
  assert.deepEqual(readdirSync(nonEmpty), ['keep.txt'], 'non-empty folder: nothing written');

  // The reported bug: a folder INSIDE the repository whose name starts with two dots.
  for (const name of ['..keys', '...x']) {
    const inside = join(REPOSITORY_ROOT, name + '-guard-' + process.pid);
    refuses(inside, `the in-repo folder ${name}`);
    assert.equal(isInsideRepository(inside, REPOSITORY_ROOT), true);
  }
  const dotdot = join(REPOSITORY_ROOT, '..guard-' + process.pid);
  const dd = runHelper(dotdot);
  assert.equal(dd.status, 1, '..name inside the repository: exit 1');
  assert.equal(existsSync(dotdot), false, '..name inside the repository: nothing created');
  // A real parent of the repository is outside (the repository is not inside it).
  assert.equal(isInsideRepository(join(REPOSITORY_ROOT, '..'), REPOSITORY_ROOT), false, 'the parent folder is outside');

  // A junction (Windows) or symlink (elsewhere) outside the repository that points into it, with the target folder not yet existing below it.
  const link = join(sandbox, 'link-into-repo');
  symlinkSync(join(REPOSITORY_ROOT, 'pipeline'), link, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(link);
  refuses(link, 'the link itself');
  refuses(join(link, 'newfolder', 'deeper'), 'a new folder below a link into the repository');
  const viaLink = runHelper(join(link, 'pki-' + process.pid));
  assert.equal(viaLink.status, 1, 'via link: exit 1');
  assert.equal(existsSync(join(REPOSITORY_ROOT, 'pipeline', 'pki-' + process.pid)), false, 'via link: nothing written into the repository');

  // Case differences (Windows file systems are case-insensitive; elsewhere the differently-cased path is simply another, outside, path).
  if (process.platform === 'win32') {
    refuses(REPOSITORY_ROOT.toUpperCase(), 'the repository path in upper case');
    const swapped = REPOSITORY_ROOT.replace(/[a-z]/g, (c) => c.toUpperCase());
    refuses(join(swapped, 'PIPELINE', 'X'), 'a case-changed path inside the repository');
    refuses(join(swapped.charAt(0).toLowerCase() + swapped.slice(1), '..keys'), 'a case-changed drive letter with ..keys');
  }

  // UNC, network-share and device paths are refused before the file system is touched (review t33 r2, N1: \\localhost\C$\<repo>
  // reached the repository). Built from the repository path so the share would really point at it; nothing is dialled.
  const drive = /^[A-Za-z]:/.test(REPOSITORY_ROOT) ? REPOSITORY_ROOT.charAt(0) : 'C';
  const tail = REPOSITORY_ROOT.replace(/^[A-Za-z]:[\\/]?/, '').replace(/^[\\/]+/, '');
  const pid = String(process.pid);
  const unc = [
    `\\\\host\\share\\keys-${pid}`,
    `\\\\localhost\\${drive}$\\${tail}\\unc-${pid}`,
    `\\\\127.0.0.1\\${drive.toLowerCase()}$\\${tail}\\unc-${pid}`,
    `\\\\?\\UNC\\localhost\\${drive}$\\${tail}\\unc-${pid}`,
    `\\\\?\\${drive}:\\${tail}\\dev-${pid}`,
    `\\\\.\\${drive}:\\${tail}\\dev-${pid}`,
    `//localhost/${drive}$/${tail.replace(/\\/g, '/')}/unc-${pid}`,
    `\\\\.\\pipe\\keys-${pid}`,
    `\\\\.\\PhysicalDrive0`,
  ];
  for (const p of unc) {
    refuses(p, `the UNC / device path ${p}`);
    if (process.platform === 'win32') assert.throws(() => assertOutsideRepository(p, REPOSITORY_ROOT), /UNC, network-share and device/, `${p}: refused as UNC/device`);
  }
  const viaShare = runHelper(unc[1]);
  assert.equal(viaShare.status, 1, 'admin share: exit 1');
  assert.match(viaShare.out, /refusing|usage/);
  assert.equal(existsSync(join(REPOSITORY_ROOT, 'unc-' + pid)), false, 'admin share: nothing written into the repository');
  if (process.platform === 'win32') {
    for (const name of ['CON', 'nul', 'NUL.txt', 'com1', 'LPT9.key', 'aux ']) {
      assert.throws(() => assertOutsideRepository(join(sandbox, name, 'x'), REPOSITORY_ROOT), /reserved device name/, `device name ${name} must be refused`);
    }
    // A segment ending in a dot or a space is another folder to Node than to Windows tools (review t40, N1). Checked on the raw text:
    // path.join would not keep a trailing space reliably, and nothing is created.
    for (const name of ['keys.', 'keys ', 'a. ']) {
      assert.throws(() => assertOutsideRepository(`${sandbox}\\${name}\\x`, REPOSITORY_ROOT), /ends in a dot or a space/, `segment "${name}" must be refused`);
      assert.throws(() => assertOutsideRepository(`${sandbox}\\x\\${name}`, REPOSITORY_ROOT), /ends in a dot or a space/, `last segment "${name}" must be refused`);
    }
    assert.throws(() => assertOutsideRepository(`${REPOSITORY_ROOT}.\\x`, REPOSITORY_ROOT), /ends in a dot or a space/, 'the repository folder name plus a dot');
    // Forward slashes are separators on Windows too (T53 item 2): a split on backslash only would miss these.
    for (const name of ['keys.', 'keys ']) {
      assert.throws(() => assertOutsideRepository(`${sandbox.replace(/\\/g, '/')}/${name}/x`, REPOSITORY_ROOT), /ends in a dot or a space/, `forward-slash segment "${name}" must be refused`);
      assert.throws(() => assertOutsideRepository(`${sandbox}\\a/${name}\\x`, REPOSITORY_ROOT), /ends in a dot or a space/, `mixed-slash segment "${name}" must be refused`);
    }
    // Device names too (T67 item 3): a split on backslash only would miss the forward-slash case.
    assert.throws(() => assertOutsideRepository(`${sandbox.replace(/\\/g, '/')}/con/x`, REPOSITORY_ROOT), /reserved device name/, 'forward-slash device name segment must be refused');
    assert.throws(() => assertOutsideRepository(`${sandbox}\\a/nul.txt\\x`, REPOSITORY_ROOT), /reserved device name/, 'mixed-slash device name segment must be refused');
    assert.doesNotThrow(() => assertOutsideRepository(`${sandbox}\\.\\ok\\..\\fine`, REPOSITORY_ROOT), '"." and ".." segments are navigation, not names');
    assert.doesNotThrow(() => assertOutsideRepository(join(sandbox, 'console', 'connect', 'nullx'), REPOSITORY_ROOT), 'names that only start like a device name are fine');
  }

  // Outside folders are accepted (existing or not).
  assert.equal(isInsideRepository(sandbox, REPOSITORY_ROOT), false);
  assert.doesNotThrow(() => assertOutsideRepository(join(sandbox, 'fresh', 'sub'), REPOSITORY_ROOT));
  const ok = join(sandbox, 'good');
  const good = runHelper(ok);
  assert.equal(good.status, 0, 'outside folder: exit 0 ' + good.out);
  assert.deepEqual(readdirSync(ok).sort(), ['root.crt', 'server.crt', 'server.key']);
  made.push(ok);
  console.log('PASS pki guard: in-repo (incl. ..name, link, case on Windows) and UNC / network-share / device paths refused; outside accepted; helper writes nothing on refusal');
} catch (err) {
  console.error('FAIL pki guard:', err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  for (const l of links) { try { unlinkSync(l); } catch { try { rmSync(l, { force: true }); } catch { /* ignore */ } } }
  rmSync(sandbox, { recursive: true, force: true });
}
