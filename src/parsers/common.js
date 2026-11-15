import { bounded, sanitize } from '../redact.js';

export function cleanText(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  return sanitize(text);
}

export function cleanBounded(text, limit) {
  return bounded(cleanText(text), limit);
}

export function safeDate(value, onInvalid) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    onInvalid?.();
    return null;
  }
  return d;
}

const DATE_FIELDS = ['started_at', 'ended_at'];

export function snapshotSession(session) {
  const out = { ...session };
  for (const f of DATE_FIELDS) out[f] = session[f] ? session[f].toISOString() : null;
  return out;
}

export function restoreSession(session, saved) {
  if (!saved) return;
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'id' || k === 'source_path') continue;
    session[k] = DATE_FIELDS.includes(k) ? safeDate(v) : v;
  }
}
