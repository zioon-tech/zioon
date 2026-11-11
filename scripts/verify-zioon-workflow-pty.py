#!/usr/bin/env python3
"""Cross-process CLI journeys against local HTTP; no remote data or model calls."""
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import pexpect
import pyte

root = Path(__file__).resolve().parent.parent
entry, output_dir = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
output_dir.mkdir(parents=True, exist_ok=True)
temp = tempfile.TemporaryDirectory(prefix="zioon-workflow-pty-")
directory = Path(temp.name)
server = subprocess.Popen([node, str(root / "scripts/cli-ux-fixture.mjs")], stdout=subprocess.PIPE, text=True)
url = server.stdout.readline().strip()
checks = []
env = {**os.environ, "TERM": "xterm-256color", "ZIOON_CHAT_STATE_DIR": str(directory / "state"),
       "ZION_RUNTIME_CLI_CONFIG": str(directory / "missing.json"), "COLORFGBG": "0;15"}
editor = directory / "test editor.py"
editor.write_text("from pathlib import Path\nimport sys\np=Path(sys.argv[1]);p.write_text(p.read_text()+'\\nfrom editor')\n")
env["VISUAL"] = f'"{sys.executable}" "{editor}"'
child = None
raw = io.StringIO()
screen = pyte.Screen(96, 30)
stream = pyte.Stream(screen)

class Capture:
    def write(self, text):
        raw.write(text)
        stream.feed(text)
    def flush(self):
        pass

def start(*args):
    global child
    child = pexpect.spawn(node, [str(entry), "--url", url, *args], encoding="utf-8",
                          timeout=12, dimensions=(30, 96), env=env)
    child.delaybeforesend = 0
    child.logfile_read = Capture()
    child.expect("Enter send")

def command(text, expected="Enter send"):
    child.send(text + "\r")
    child.expect(expected)

def close():
    child.send("/exit\r")
    child.expect(pexpect.EOF)
    child.close()
    assert child.exitstatus == 0, child.exitstatus

def state():
    with urllib.request.urlopen(url + "/__state") as response:
        return json.load(response)

def capture(name):
    try:
        while True:
            child.read_nonblocking(65536, timeout=0.05)
    except pexpect.TIMEOUT:
        pass
    (output_dir / f"workflow-{name}.txt").write_text("\n".join(line.rstrip() for line in screen.display) + "\n")

try:
    started = time.perf_counter()
    start()
    prompt_ms = round((time.perf_counter() - started) * 1000, 1)
    assert state()["prompts"] == []
    checks.append("empty chat creates no messages")
    command("/model", "Enter open")
    child.send("smart\r")
    child.expect("Current model: smart")
    child.expect("Enter send")
    child.send("editor seed\x07")
    child.expect("from editor")
    child.expect("Enter send")
    assert state()["prompts"] == []
    child.send("\x03")
    checks.append("external editor returns multiline draft without sending")
    command("/settings tools", "Tool details: expanded")
    child.expect("Enter send")
    command("first message", "completed")
    child.expect("Enter send")
    checks.append("searchable model picker and message submission")
    command("/tools 1", "workspace ready")
    child.expect("Enter send")
    capture("tools-light")
    checks.append("expanded tool request and result in light theme")
    child.send("恢复草稿🙂")
    child.expect("恢复草稿🙂")
    # Wait for durable autosave by checking its actual record, not a fixed delay.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if any("恢复草稿" in p.read_text() for p in (directory / "state").rglob("*.json")):
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Draft was not saved")
    child.kill(signal.SIGTERM)
    child.expect(pexpect.EOF)
    child.close()
    start("--continue")
    assert "Draft restored" in raw.getvalue()
    capture("restored")
    assert state()["prompts"] == ["first message"], "Restored draft was sent automatically"
    child.send("\r")
    child.expect("completed")
    child.expect("Enter send")
    assert state()["prompts"][-1] == "恢复草稿🙂"
    checks.append("SIGTERM draft recovery and --continue without automatic send")
    child.send("\x12first")
    child.expect("history")
    child.send("\r")
    capture("history")
    assert "› first message" in "\n".join(screen.display), "History selected a stale query result"
    checks.append("Ctrl+R query restores the current match without sending")
    assert state()["prompts"] == ["first message", "恢复草稿🙂"]
    child.send("\x03")
    command("lose-response", "Acceptance unconfirmed")
    child.expect("Enter send")
    close()
    start("--continue")
    command("/recover", "was accepted")
    child.expect("completed")
    child.expect("Enter send")
    assert state()["prompts"].count("lose-response") == 1
    checks.append("lost HTTP response reconciled after process restart without duplicate")
    text_path = directory / "中文  source.md"
    text_path.write_text("Attachment evidence")
    child.send(f"/file {directory}/中\t")
    child.expect(r"\.md")
    child.send("\r")
    child.expect("Attached")
    child.expect("Enter send")
    command("read the attachment", "completed")
    child.expect("Enter send")
    assert "Attachment evidence" in state()["prompts"][-1]
    checks.append("Tab path completion preserves Chinese and repeated spaces")
    export = directory / "history.md"
    command(f"/export {export}", "Exported:")
    child.expect("Enter send")
    assert "恢复草稿🙂" in export.read_text()
    command("/context", "transcript tokens")
    child.expect("Enter send")
    command("/compact force", "Context:")
    child.expect("Enter send")
    checks.append("original transcript export and explicit context compression")
    command("slow", "Thinking")
    child.send("\x1b")
    child.expect(r"\[aborted\]")
    child.expect("Enter send")
    assert state()["aborts"] == 1
    checks.append("one server abort and terminal status confirmation")
    capture("completed")
    close()
    assert "\x1b[?2004l" in raw.getvalue()
    (output_dir / "workflow-terminal.ansi").write_text(raw.getvalue())
    result = {"platform": sys.platform, "terminal": "PTY", "checks": checks,
              "passed": len(checks), "local_prompt_ms": prompt_ms}
    (output_dir / "workflow-pty-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    if child and child.isalive():
        child.terminate(force=True)
    server.terminate()
    server.wait(timeout=5)
    temp.cleanup()
