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
