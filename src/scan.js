import { stat } from 'node:fs/promises';
import { buildInventory, rootsFromEnv } from './inventory.js';
import { ingestSource, recordError } from './ingest.js';

async function unchangedImmutable(db, source) {
  if (!source.immutable) return false;
  const row = await db('sources').where({ path: source.path }).first();
  if (!row || row.status !== 'done') return false;
  const info = await stat(source.path);
  return String(row.inode) === String(info.ino) && String(row.size) === String(info.size);
}

export async function scan(db, { tool = null, changedSinceLast = false, roots = rootsFromEnv(), onSource } = {}) {
  const inv = await buildInventory(roots);
  const sources = inv.sources.filter((s) => !tool || s.tool === tool);
  const summary = { sources: sources.length, ingested: 0, skipped: 0, errors: 0, lines: 0, rows: 0 };
  for (const source of sources) {
    try {
      if (changedSinceLast && (await unchangedImmutable(db, source))) {
        summary.skipped++;
        continue;
      }
      const r = await ingestSource(db, source);
      if (r.skipped) summary.skipped++;
      else summary.ingested++;
      summary.lines += r.lines;
      summary.rows += r.rows;
    } catch (err) {
      summary.errors++;
      await recordError(db, { sourcePath: source.path, errorClass: err.code || err.name || 'Error' }).catch(() => {});
    }
    await onSource?.(source, summary);
  }
  summary.unsupported = inv.unsupported.length;
  summary.unreadable = inv.unreadable.length;
  summary.empty = inv.empty.length;
  summary.skippedFiles = inv.skipped.length;
  summary.duplicateSegments = inv.duplicateSegments().size;
  return summary;
}
