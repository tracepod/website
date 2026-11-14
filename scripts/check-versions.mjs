// Fails if a pinned Tracepod version other than the current one appears in
// src/ or README.md. Current version: src/version.ts.
// Lines that talk about version history (not a pin) are allowed via HISTORY.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const current = readFileSync(join(root, 'src/version.ts'), 'utf8')
  .match(/OSS_VERSION\s*=\s*'(v\d+\.\d+\.\d+)'/)?.[1];
if (!current) { console.error('check-versions: cannot read OSS_VERSION from src/version.ts'); process.exit(2); }
const bare = current.slice(1);

// A line is history, not a pin, when it matches one of these.
const HISTORY = [
  /\bBefore v\d/i, /\bbefore v\d/, /\bsince v\d/i, /\band later\b/, /Deprecated in v\d/,
  /\btags? v0\.\d+\.\d+/, /Action tags/,
];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(astro|md|mdx|ts|mjs)$/.test(name)) files.push(p);
  }
})(join(root, 'src'));
files.push(join(root, 'README.md'));

const re = /\bv?0\.2\.\d+\b/g;
const bad = [];
for (const f of files) {
  if (f.endsWith('src/version.ts')) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const hits = (line.match(re) || []).filter((v) => v.replace(/^v/, '') !== bare);
    if (hits.length && !HISTORY.some((h) => h.test(line)))
      bad.push(`${f.slice(root.length)}:${i + 1}: ${hits.join(', ')} (current is ${current})`);
  });
}
if (bad.length) {
  console.error('check-versions: stale or unlisted version pins:\n' + bad.join('\n'));
  process.exit(1);
}
console.log(`check-versions: ok (${current})`);
