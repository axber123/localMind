import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "embedding_worker.py"


def run_worker(requests: list[dict]) -> list[dict]:
    payload = "\n".join(json.dumps(item, ensure_ascii=False) for item in requests) + "\n"
    result = subprocess.run(
        [sys.executable, str(WORKER)],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def test_health_protocol() -> None:
    responses = run_worker([{"id": 1, "method": "health"}, {"id": 2, "method": "shutdown"}])
    assert responses[0]["ok"] is True
    assert responses[0]["result"]["status"] == "ok"
    assert responses[1]["ok"] is True


def test_invalid_method_returns_error() -> None:
    responses = run_worker([{"id": 7, "method": "nope"}, {"id": 8, "method": "shutdown"}])
    assert responses[0]["ok"] is False
    assert "unknown method" in responses[0]["error"]["message"]
