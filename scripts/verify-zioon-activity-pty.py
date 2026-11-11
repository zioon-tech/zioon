#!/usr/bin/env python3
"""Activity presentation in a packaged CLI, real PTY and local HTTP fixture."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import pexpect
import pyte

root = Path(__file__).resolve().parent.parent
entry, destination = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=True)
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
temporary = tempfile.TemporaryDirectory(prefix="zioon-activity-pty-")
server = subprocess.Popen([node, str(root / "scripts/cli-ux-fixture.mjs")], stdout=subprocess.PIPE, text=True)
url = server.stdout.readline().strip()
screen = pyte.Screen(100, 32)
stream = pyte.Stream(screen)
raw = io.StringIO()
checks, child = [], None
environment = {**os.environ, "TERM": "xterm-256color", "COLORFGBG": "0;15",
               "ZIOON_CHAT_STATE_DIR": temporary.name, "ZION_RUNTIME_CLI_CONFIG": str(Path(temporary.name) / "absent.json")}

class Capture:
    def write(self, text):
        raw.write(text)
        stream.feed(text)
    def flush(self):
        pass

def control(value):
    with urllib.request.urlopen(urllib.request.Request(url + "/__control",
            data=json.dumps(value).encode(), headers={"content-type": "application/json"})) as response:
        return json.load(response)

def snapshot(name):
    try:
        while True:
            child.read_nonblocking(65536, timeout=0.05)
    except pexpect.TIMEOUT:
        pass
    (destination / f"activity-{name}.txt").write_text("\n".join(line.rstrip() for line in screen.display) + "\n")

def finished():
    child.expect("completed ·")
    child.expect("Enter send")

try:
    started = time.perf_counter()
    child = pexpect.spawn(node, [str(entry), "--url", url], env=environment,
                          encoding="utf-8", timeout=15, dimensions=(32, 100))
    child.delaybeforesend = 0
    child.logfile_read = Capture()
    child.expect("Enter send")
    prompt_ms = round((time.perf_counter() - started) * 1000, 1)
    events = [{"type": "reasoning.progress", "data": {"projection": {"deltaChars": 10}}} for _ in range(8)]
    events += [
        {"type": "message.delta", "data": {"delta": "我先检查工具链。\n\n"}},
        {"type": "tool.requested", "data": {"callId": "a", "name": "Bash", "arguments": {"description": "检查本地配置"}}},
        {"type": "tool.requested", "data": {"callId": "b", "name": "Bash", "arguments": {"description": "检查权限"}}},
        {"type": "tool.completed", "data": {"callId": "b", "ok": False, "error": "Permission denied"}},
        {"type": "tool.completed", "data": {"callId": "a", "ok": True, "result": "configuration ready"}},
    ]
    for i in range(3):
        events += [
            {"type": "tool.requested", "data": {"callId": f"s{i}", "name": "skillsList"}},
            {"type": "tool.completed", "data": {"callId": f"s{i}", "ok": True}},
        ]
    events += [{"type": "message.delta", "data": {"delta": "**检查完成**\n\n- 配置正常\n- 权限需要修正\n"}},
               {"type": "run.completed", "data": {}}]
    control({"events": events, "eventDelayMs": 20})
    child.send("检查活动展示\r")
    finished()
    snapshot("compact-light")
    content = raw.getvalue()
    assert "Permission denied" in content and "with tool failures" in content
    assert "List skills ×3" in content
    assert "Thought for " in content
    assert "检查完成" in "\n".join(screen.display)
    assert "**检查完成**" not in "\n".join(screen.display)
    checks += ["confirmed thinking phase stays separate from Markdown prose",
               "concurrent same-name tools correlate and ok:false remains visible",
               "consecutive successful calls group by action instead of lifecycle log lines"]

    child.send("/tools 2\r")
    child.expect("Permission denied")
    child.expect("Enter send")
    checks.append("numbered tool inspection retrieves the selected original payload")

    events = []
    for i in range(60):
        events += [{"type": "tool.requested", "data": {"callId": str(i), "name": "Bash", "arguments": {"command": f"inspect {i}"}}},
                   {"type": "tool.completed", "data": {"callId": str(i), "ok": True, "result": f"result {i}"}}]
    events += [{"type": "message.delta", "data": {"delta": "批量检查完成。\n"}}]
    control({"events": events, "eventDelayMs": 1})
    offset = len(raw.getvalue())
    child.send("检查长工具序列\r")
    finished()
    snapshot("burst")
    content = raw.getvalue()[offset:]
    assert content.count("✓") == 1, content
    assert "Run command ×60" in content and "60 tools" in content
    checks.append("sixty real HTTP tool lifecycles produce one committed summary line")

    child.send("未发送草稿🙂")
    child.expect("未发送草稿🙂")
    child.send("\x0f")
    child.expect("Tool details: expanded")
    snapshot("expanded-light")
    assert "未发送草稿🙂" in "\n".join(screen.display)
    assert "result 59" in raw.getvalue()
    child.send("\x0f")
    child.expect("Tool details: compact")
    snapshot("draft-kept")
    assert "未发送草稿🙂" in "\n".join(screen.display)
    checks.append("Ctrl+O expands recent results and collapses without sending or clearing a Chinese draft")

    child.setwinsize(16, 42); screen.resize(16, 42)
    child.send("\x0c")
    snapshot("narrow")
    assert "未发送草稿🙂" in "\n".join(screen.display)
    child.send("\x03")
    child.send("/details\r")
    child.expect("Tool details: expanded")
    child.expect("Enter send")
    checks.append("narrow terminal resize and /details fallback remain usable")
    child.send("/details\r")
    child.expect("Tool details: compact")
    child.expect("Enter send")
    control({"events": [], "eventDelayMs": 2})
    child.send("slow\r")
    child.expect("Thinking")
    child.send("\x0f")
    child.send("下一条草稿")
    child.send("\x1b")
    child.expect(r"\[aborted\]")
    child.expect("下一条草稿")
    snapshot("busy-draft")
    checks.append("busy Ctrl+O and Escape stop retain the next draft and confirm server abort")
    child.send("\x03/exit\r")
    child.expect(pexpect.EOF); child.close()
    assert child.exitstatus == 0
    assert "\x1b[?2004l" in raw.getvalue()
    checks.append("normal exit restores bracketed paste and terminal mode")

    # Standalone run/attach uses the same renderer; JSONL remains machine data.
    with urllib.request.urlopen(urllib.request.Request(url + "/v1/sessions/s-travel/messages",
            data=json.dumps({"content": "standalone"}).encode(), headers={"content-type": "application/json"})) as response:
        run_id = json.load(response)["runId"]
    child = pexpect.spawn(node, [str(entry), "attach", run_id, "--url", url], env=environment,
                          encoding="utf-8", timeout=10, dimensions=(24, 100))
    child.expect(pexpect.EOF); child.close()
    assert child.exitstatus == 0
    result = subprocess.run([node, str(entry), "attach", run_id, "--url", url, "--jsonl"],
                            env=environment, capture_output=True, text=True, timeout=10)
    records = [json.loads(line) for line in result.stdout.splitlines()]
    assert result.returncode == 0 and records[-1]["type"] == "run.snapshot"
    checks.append("standalone attach exits cleanly and JSONL remains parseable")

    (destination / "activity-terminal.ansi").write_text(raw.getvalue())
    result = {"version": subprocess.check_output([node, str(entry), "--version"], text=True).strip(),
              "platform": sys.platform, "passed": len(checks), "checks": checks,
              "local_first_prompt_ms": prompt_ms, "windows_linux_native_terminal": "not run"}
    (destination / "activity-pty-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    if child and child.isalive():
        child.terminate(force=True)
    server.terminate(); server.wait(timeout=5)
    temporary.cleanup()
