#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const targets = [
  join(repositoryRoot, 'supabase', 'seed.sql'),
  join(repositoryRoot, 'scripts', 'seed-auth-users.ts'),
  join(repositoryRoot, 'scripts', 'cleanup-auth-users.ts'),
];

const allowedExtensions = new Set(['.sql', '.ts', '.tsx', '.js', '.mjs', '.json']);
const realIdentityPattern = /(?:hunter|marisol|dwight|priya|cole)@twistednail\.(?:com|dev)/gi;
const externalEmailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const isSafeEmailDomain = (domain) =>
  domain === 'example.invalid' || domain.endsWith('.example.invalid');
const hardCodedPasswordPattern = /(?:const\s+PASSWORD\s*=\s*|password\s*:\s*)['"][^'"\n]{8,}['"]/gi;
const phonePattern = /\((\d{3})\)\s+555-(\d{4})/g;

function listFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return listFiles(child);
    return allowedExtensions.has(extname(entry.name)) ? [child] : [];
  });
}

const findings = [];
for (const file of targets.flatMap(listFiles)) {
  const content = readFileSync(file, 'utf8');
  const path = relative(repositoryRoot, file);

  for (const match of content.matchAll(realIdentityPattern)) {
    findings.push(`${path}: contains a real TNBS-style identity (${match[0]})`);
  }

  for (const match of content.matchAll(externalEmailPattern)) {
    const domain = match[1]?.toLowerCase();
    if (domain && !isSafeEmailDomain(domain)) {
      findings.push(`${path}: email domain is not reserved for testing (${match[0]})`);
    }
  }

  for (const match of content.matchAll(hardCodedPasswordPattern)) {
    findings.push(`${path}: appears to contain a hard-coded test password (${match[0].split('=')[0]?.trim()})`);
  }

  if (path === 'supabase/seed.sql' && content.includes('ejrfobddnojbijzrjbii')) {
    findings.push(`${path}: contains the production Supabase project ref`);
  }

  for (const match of content.matchAll(phonePattern)) {
    const subscriber = Number(match[2]);
    if (subscriber < 100 || subscriber > 199) {
      findings.push(`${path}: 555 number is outside the reserved 0100-0199 fictional block (${match[0]})`);
    }
  }
}

if (findings.length > 0) {
  console.error('Hosted fixture safety check failed:');
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  console.error('\nUse only fictional identities, reserved example.invalid contact data in SQL, runtime-provided approved Auth domains, and no hard-coded passwords.');
  process.exit(1);
}

console.log('PASS hosted seed contains only reserved contact data, runtime-only Auth domains, no real TNBS identities, and no hard-coded passwords');
