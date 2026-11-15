const PATTERNS = [
  ['pem', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['anthropic', /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,250}(?![A-Za-z0-9_-])/g],
  ['openai', /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}(?![A-Za-z0-9_-])/g],
  ['github', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack', /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,250}(?![A-Za-z0-9_-])/g],
  ['google', /AIza[0-9A-Za-z_-]{35}/g],
  ['stripe', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ['telegram', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /(?<=bearer )[A-Za-z0-9._~+/=-]{16,}/gi],
];

const SECRET_NAME = '[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)S?';
const ENV_ASSIGN = new RegExp(
  `^(?<lead>[ \\t]*(?:export[ \\t]+)?${SECRET_NAME}[ \\t]*[=:][ \\t]*)` +
    `(?<value>(?=["']?[^\\s"'#]*[A-Za-z])["']?[^\\s"'#]{4,}["']?)`,
  'gm',
);
const SECRET_KEY = new RegExp(
  '^(?:api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|password|passwd|' +
    'access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|authorization|private[_-]?key|' +
    '[a-z0-9_]*_(?:api_key|secret|password|token))$',
  'i',
);

const REFERENCE_VALUE = new RegExp(
  [
    '^\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?$',
    '^(?:process\\.env|os\\.environ|os\\.getenv|import\\.meta\\.env|env)[.(\\[]',
    '^(?:<[^<>]*>|\\{\\{[^{}]*\\}\\})$',
    '^[A-Za-z_][A-Za-z0-9_]+(?:\\.[A-Za-z_][A-Za-z0-9_]+)+(?:\\(\\)?)?,?$',
  ].join('|'),
);

function isReference(value) {
  const v = value.replace(/^["']|["']$/g, '');
  return v.length <= 80 && REFERENCE_VALUE.test(v);
}

export function stripNul(text) {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

export function redactText(text) {
  if (!text) return text;
  let out = stripNul(text);
  for (const [name, pattern] of PATTERNS) out = out.replace(pattern, `[REDACTED:${name}]`);
  return out.replace(ENV_ASSIGN, (match, ...args) => {
    const { lead, value } = args.at(-1);
    return isReference(value) ? match : `${lead}[REDACTED:env]`;
  });
}

function maybeJson(text) {
  const s = text.trim();
  if (s.length < 2 || !'{['.includes(s[0]) || !'}]'.includes(s.at(-1))) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function sanitize(value) {
  if (typeof value === 'string') {
    const decoded = maybeJson(value);
    if (decoded !== null && typeof decoded === 'object') return JSON.stringify(sanitize(decoded));
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = stripNul(k);
      if (typeof v === 'string' && SECRET_KEY.test(k) && v && !v.startsWith('[REDACTED')) out[key] = '[REDACTED:field]';
      else out[key] = sanitize(v);
    }
    return out;
  }
  return value;
}

export function sanitizeLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return redactText(line);
  }
  return JSON.stringify(sanitize(record));
}

export function bounded(text, limit) {
  if (text === null || text === undefined) return text;
  const clean = redactText(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…[+${clean.length - limit} chars]`;
}
