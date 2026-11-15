import { readFileSync } from 'node:fs';
import path from 'node:path';
import { historyHome } from './paths.js';

export function configPath(env = process.env) {
  return path.join(historyHome(env), 'config.json');
}

export function loadConfig(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(configPath(env), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
