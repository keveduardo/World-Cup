#!/usr/bin/env node
// KO schedule parity check — run before deploying.
//
// The per-match knockout pick locks live in TWO places that must agree:
//   • worker.js  → KO_TIMES  (server-side lock enforcement)
//   • index.html → KO_SCHEDULE (client-side lock + display)
// If a provider moves a kickoff and only one copy is updated, the client can show a
// pick as editable while the server silently rejects it (see finding H1). This script
// parses both files and fails (exit 1) if any match number's [date, ET] disagree.
//
// Usage:  node tools/ko-parity-check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(join(root, 'worker.js'), 'utf8');
const index  = readFileSync(join(root, 'index.html'), 'utf8');

// worker.js: entries look like  73:['2026-06-28','15:00'],
function parseWorker(src) {
  const block = src.match(/const KO_TIMES\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error('KO_TIMES not found in worker.js');
  const out = {};
  const re = /(\d+)\s*:\s*\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g;
  let m;
  while ((m = re.exec(block[1]))) out[+m[1]] = { date: m[2], et: m[3] };
  return out;
}

// index.html: entries look like  {n:73,date:'2026-06-28',et:'15:00',v:'LA', ...}
function parseIndex(src) {
  const block = src.match(/const KO_SCHEDULE\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('KO_SCHEDULE not found in index.html');
  const out = {};
  const re = /\{\s*n:\s*(\d+)\s*,\s*date:\s*'([^']+)'\s*,\s*et:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1]))) out[+m[1]] = { date: m[2], et: m[3] };
  return out;
}

const w = parseWorker(worker);
const i = parseIndex(index);

const nums = [...new Set([...Object.keys(w), ...Object.keys(i)].map(Number))].sort((a, b) => a - b);
const problems = [];
for (const n of nums) {
  const a = w[n], b = i[n];
  if (!a) { problems.push(`match ${n}: missing in worker.js KO_TIMES`); continue; }
  if (!b) { problems.push(`match ${n}: missing in index.html KO_SCHEDULE`); continue; }
  if (a.date !== b.date || a.et !== b.et)
    problems.push(`match ${n}: worker ${a.date} ${a.et}  ≠  index ${b.date} ${b.et}`);
}

if (problems.length) {
  console.error('✗ KO schedule mismatch:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ KO parity OK — ${nums.length} matches agree between worker.js and index.html`);
