// TEST TOOLING ONLY. The "outside the repository" rule for retention-secure-a3-make-pki.ts, kept apart so it can be tested.
// A folder counts as inside the repository when its REAL path (symlinks and junctions followed on the nearest existing ancestor)
// is the repository root or below it. Paths are compared segment by segment with path.relative, so a sibling-looking name such
// as `..keys` inside the repository is not mistaken for a parent path.
// UNC, network-share and device paths (\\host\share, \\localhost\C$, \\?\UNC\..., \\?\C:\..., \\.\...) are refused outright, also when
// the real path of a folder turns out to be one (a mapped network drive): such a path can name the repository folder without looking
// like it (review t33 r2, N1). On Windows a path segment that is a reserved device name (CON, NUL, COM1, ...) is refused too.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function realOfNearestAncestor(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync.native(cur), ...rest);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel));
}

/** True for a UNC, network-share or device path: anything starting with two slashes or backslashes, in any mix. */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** True when a segment of p is a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, also with an extension). */
export function hasDeviceNameSegment(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.[^\\/]*)?[ .]*$/i.test(seg));
}

export function isInsideRepository(dir: string, repositoryRoot: string): boolean {
  const target = resolve(dir);
  const root = resolve(repositoryRoot);
  return isInside(root, target) || isInside(realpathSync.native(root), realOfNearestAncestor(target));
}

export function assertOutsideRepository(dir: string | undefined, repositoryRoot: string): string {
  if (!dir || !isAbsolute(dir)) throw new Error('usage: make-pki <absolute, empty directory outside the repository>');
  if (isUncOrDevicePath(dir) || isUncOrDevicePath(resolve(dir))) throw new Error('refusing: UNC, network-share and device paths are not allowed');
  if (process.platform === 'win32' && hasDeviceNameSegment(dir)) throw new Error('refusing: a path segment is a reserved device name');
  if (isUncOrDevicePath(realOfNearestAncestor(dir))) throw new Error('refusing: the folder is on a network share');
  if (isInsideRepository(dir, repositoryRoot)) throw new Error('refusing: the key material must live outside the repository');
  return resolve(dir);
}
