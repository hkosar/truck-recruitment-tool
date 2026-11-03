// TEST TOOLING ONLY. The "outside the repository" rule for retention-secure-a3-make-pki.ts, kept apart so it can be tested.
// A folder counts as inside the repository when its REAL path (symlinks and junctions followed on the nearest existing ancestor)
// is the repository root or below it. Paths are compared segment by segment with path.relative, so a sibling-looking name such
// as `..keys` inside the repository is not mistaken for a parent path.

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

export function isInsideRepository(dir: string, repositoryRoot: string): boolean {
  const target = resolve(dir);
  const root = resolve(repositoryRoot);
  return isInside(root, target) || isInside(realpathSync.native(root), realOfNearestAncestor(target));
}

export function assertOutsideRepository(dir: string | undefined, repositoryRoot: string): string {
  if (!dir || !isAbsolute(dir)) throw new Error('usage: make-pki <absolute, empty directory outside the repository>');
  if (isInsideRepository(dir, repositoryRoot)) throw new Error('refusing: the key material must live outside the repository');
  return resolve(dir);
}
