// Serves the built SPA (app/dist) plus the public sign-in assets. Files are read once at start;
// only paths that exist in the build are served, so no path ever escapes the directory.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { StaticFiles } from '../app';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function loadStaticFiles(dir: string): StaticFiles {
  const files = new Map<string, { body: Buffer; contentType: string; immutable: boolean }>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const urlPath = '/' + relative(dir, full).split(sep).join('/');
        if (urlPath === '/index.html') continue;
        files.set(urlPath, {
          body: readFileSync(full),
          contentType: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
          immutable: urlPath.startsWith('/assets/'),
        });
      }
    }
  };
  walk(dir);
  const index = readFileSync(join(dir, 'index.html'));
  return { get: (p) => files.get(p), index: () => index };
}
