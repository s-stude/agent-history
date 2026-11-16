import { createInterface } from 'node:readline';
import { buildInventory, openSource, rootsFromEnv } from '../src/inventory.js';
import { sanitizeLine } from '../src/redact.js';
import { loadDotenv } from '../src/dotenv.js';

loadDotenv();

const sampleSize = Number(process.argv[2] || 50);
const LABEL = /\[REDACTED:(\w+)\]/g;

function labels(text) {
  const counts = new Map();
  for (const m of text.matchAll(LABEL)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  return counts;
}

const inv = await buildInventory(rootsFromEnv());
const pool = [...inv.sources];
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const picked = pool.slice(0, sampleSize);
const totals = new Map();
let lines = 0;
for (const src of picked) {
  const rl = createInterface({ input: openSource(src), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    const before = labels(line);
    for (const [name, n] of labels(sanitizeLine(line))) {
      const added = n - (before.get(name) || 0);
      if (added > 0) totals.set(name, (totals.get(name) || 0) + added);
    }
  }
}
const tools = picked.reduce((acc, s) => ({ ...acc, [s.tool]: (acc[s.tool] || 0) + 1 }), {});
console.log(JSON.stringify({ sources: picked.length, tools, lines, redactions: Object.fromEntries(totals) }));
