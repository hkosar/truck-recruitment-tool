#!/usr/bin/env node
// Fails if the UI references /brand/* or /fonts/* files that are not in app/public.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const sources = [join(appRoot, 'index.html')];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(tsx?|css|html)$/.test(name)) sources.push(path);
  }
};
walk(join(appRoot, 'src'));

const refs = new Set();
for (const file of sources) {
  for (const match of readFileSync(file, 'utf8').matchAll(/["'(](\/(?:brand|fonts)\/[^"')\s?#]+)/g)) refs.add(match[1]);
}
const missing = [...refs].filter((ref) => !existsSync(join(appRoot, 'public', ref)));
if (missing.length > 0) {
  for (const ref of missing) console.error(`FAIL missing public asset ${ref}`);
  process.exit(1);
}
console.log(`PASS ${refs.size} referenced brand/font assets exist in app/public`);
