import json
import re

PATTERNS: list[tuple[str, re.Pattern]] = [
    ("pem", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)")),
    ("anthropic", re.compile(r"(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,250}(?![A-Za-z0-9_-])")),
    ("openai", re.compile(r"(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}(?![A-Za-z0-9_-])")),
    ("github", re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])")),
    ("aws", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack", re.compile(r"(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,250}(?![A-Za-z0-9_-])")),
    ("google", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("stripe", re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{20,}")),
    ("telegram", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("bearer", re.compile(r"(?i)(?<=bearer )[A-Za-z0-9._~+/=-]{16,}")),
]

SECRET_NAME = r"[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)S?"
ENV_ASSIGN = re.compile(
    rf"(?m)^(?P<lead>[ \t]*(?:export[ \t]+)?{SECRET_NAME}[ \t]*[=:][ \t]*)"
    r"(?P<value>(?=[\"']?[^\s\"'#]*[A-Za-z])[\"']?[^\s\"'#]{4,}[\"']?)"
)
SECRET_KEY = re.compile(
    r"(?i)^(?:api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|password|passwd|"
    r"access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|authorization|private[_-]?key|"
    r"[a-z0-9_]*_(?:api_key|secret|password|token))$"
)


def redact_text(text: str) -> str:
    if not text:
        return text
    for name, pattern in PATTERNS:
        text = pattern.sub(f"[REDACTED:{name}]", text)
    return ENV_ASSIGN.sub(lambda m: m["lead"] + "[REDACTED:env]", text)


def _maybe_json(text: str):
    stripped = text.strip()
    if len(stripped) < 2 or stripped[0] not in "{[" or stripped[-1] not in "}]":
        return None
    try:
        return json.loads(stripped)
    except ValueError:
        return None


def sanitize(value):
    if isinstance(value, str):
        decoded = _maybe_json(value)
        if decoded is not None and isinstance(decoded, (dict, list)):
            return json.dumps(sanitize(decoded), ensure_ascii=False)
        return redact_text(value)
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(v, str) and isinstance(k, str) and SECRET_KEY.match(k) and v and not v.startswith("[REDACTED"):
                out[k] = "[REDACTED:field]"
            else:
                out[k] = sanitize(v)
        return out
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def sanitize_line(line: str) -> str:
    try:
        record = json.loads(line)
    except ValueError:
        return redact_text(line)
    return json.dumps(sanitize(record), ensure_ascii=False, separators=(",", ":"))


def bounded(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    text = redact_text(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"…[+{len(text) - limit} chars]"
