import json

import pytest

from agent_history.redact import bounded, redact_text, sanitize, sanitize_line
from tests.fixtures import secrets as S

TOKENS = [S.ANTHROPIC, S.OPENAI, S.GITHUB, S.GITHUB_PAT, S.AWS, S.SLACK, S.GOOGLE, S.STRIPE, S.TELEGRAM, S.JWT]


def assert_clean(text: str):
    for secret in S.ALL:
        assert secret not in text, secret[:12]


@pytest.mark.parametrize("token", TOKENS)
def test_plain_tokens(token):
    out = redact_text(f"use {token} now")
    assert token not in out and "[REDACTED:" in out and out.startswith("use ") and out.endswith(" now")


def test_bearer_env_and_pem():
    text = f"Authorization: Bearer {S.BEARER}\nexport OPENAI_API_KEY={S.ENV_VALUE}\nDB_PASSWORD='{S.ENV_VALUE}'\n{S.PEM}\nafter"
    out = redact_text(text)
    assert_clean(out)
    assert "OPENAI_API_KEY=[REDACTED:env]" in out
    assert out.endswith("after")


def test_escaped_pem_in_raw_line():
    line = json.dumps({"type": "user", "message": {"content": f"key:\n{S.PEM}"}})
    assert "\\n" in line
    assert_clean(sanitize_line(line))
    assert_clean(redact_text(line))


def test_truncated_pem_without_end_marker():
    assert_clean(redact_text("-----BEGIN PRIVATE KEY-----\n" + S.PEM_BODY))


def test_nested_stringified_tool_arguments():
    args = json.dumps({"cmd": f"curl -H 'Authorization: Bearer {S.BEARER}'", "env": {"api_key": S.FIELD_VALUE}})
    record = {"type": "response_item", "payload": {"type": "function_call", "arguments": args, "input": json.dumps([S.GITHUB])}}
    out = sanitize_line(json.dumps(record))
    assert_clean(out)
    decoded = json.loads(json.loads(out)["payload"]["arguments"])
    assert decoded["env"]["api_key"] == "[REDACTED:field]"


def test_metadata_fields_and_tool_results():
    record = {
        "cwd": f"/tmp/{S.AWS}",
        "title": f"debug {S.SLACK}",
        "toolUseResult": {"stdout": f"OPENAI_API_KEY={S.ENV_VALUE}\nok", "password": S.FIELD_VALUE},
        "headers": {"Authorization": f"Bearer {S.BEARER}", "x-api-key": S.FIELD_VALUE},
    }
    assert_clean(json.dumps(sanitize(record)))


def test_secret_straddling_trim_boundary_is_removed():
    text = "x" * 489 + " " + S.ANTHROPIC + " " + "y" * 100
    out = bounded(text, 500)
    assert "sk-ant-" not in out
    assert S.ANTHROPIC[:20] not in out
    assert out.endswith("chars]")


def test_bounded_keeps_short_text():
    assert bounded("hello", 500) == "hello"
    assert bounded(None, 500) is None


@pytest.mark.parametrize("benign", [
    "commit 9f0a007c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a",
    "session 43cec861-2203-414b-bfc7-b732d4b880f0",
    "/Users/me/projects/sk-learn-notes/token_count.py",
    "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "max_tokens: 4096",
    "token_count = 12",
    "the PASSWORD field is required",
    "MAX_TOKENS: 4096",
    "api_key = os.environ['API_KEY']",
])
def test_false_positives_left_intact(benign):
    assert redact_text(benign) == benign


def test_key_prefix_inside_long_base64url_blob_is_not_a_key():
    blob = "iVBORw0KGgo" + "Ab3_x" * 40 + "sk-" + "Zq9_Lm" * 60 + "xoxb-" + "Pq7" * 30
    assert redact_text(blob) == blob


def test_key_next_to_punctuation_is_still_caught():
    for wrapped in (f'"{S.OPENAI}"', f"({S.ANTHROPIC})", f"key={S.GITHUB};", f"<{S.SLACK}>"):
        assert_clean(redact_text(wrapped))


def test_benign_json_keys_untouched():
    record = {"token_count": 12, "input_tokens": 5, "key": "value", "tokenizer": "cl100k"}
    assert sanitize(record) == record


def test_invalid_json_line_falls_back_to_text():
    assert_clean(sanitize_line("not json " + S.GITHUB))
