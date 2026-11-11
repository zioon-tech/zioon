#!/usr/bin/env python3
"""Real PTY checks. Dependencies: pexpect, pyte. Writes reviewable terminal captures."""
import io
import json
import os
from pathlib import Path
import statistics
import signal
import subprocess
import sys
import time
import urllib.request
import pexpect
import pyte

root = Path(__file__).resolve().parent.parent
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
entry = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=True)
server = subprocess.Popen([node, str(root / "scripts/cli-ux-fixture.mjs")], stdout=subprocess.PIPE, text=True)
url = server.stdout.readline().strip()
screen = pyte.Screen(90, 28)
stream = pyte.Stream(screen)
raw = io.StringIO()
class Capture:
    def write(self, value):
        raw.write(value)
        stream.feed(value)
    def flush(self):
        pass

child = None
process = None
captures = {}
def snapshot(name):
    # Consume any final cursor positioning bytes after the text matched by expect.
    try:
        while True:
            child.read_nonblocking(65536, timeout=0.05)
    except pexpect.TIMEOUT:
        pass
    captures[name] = "\n".join(line.rstrip() for line in screen.display).rstrip() + "\n"
    (destination / f"terminal-{name}.txt").write_text(captures[name])

def state():
    with urllib.request.urlopen(url + "/__state") as response:
        return json.load(response)

try:
    start = time.perf_counter()
    child = pexpect.spawn(node, [str(entry), "chat", "--url", url, "--title", "交互验收"],
                          encoding="utf-8", timeout=8, dimensions=(28, 90),
                          env={**os.environ, "TERM": "xterm-256color"})
    child.delaybeforesend = 0
    child.logfile_read = Capture()
    child.expect("Enter send")
    ready_ms = round((time.perf_counter() - start) * 1000, 1)
    snapshot("welcome")
    start = time.perf_counter()
    child.send("\x1b[200~请检查交互🙂\n第二行：不要误发送\x1b[201~")
    child.expect("第二行：不要误发送")
    input_ms = round((time.perf_counter() - start) * 1000, 1)
    assert state()["prompts"] == [], "Paste submitted before Enter"
    snapshot("multiline")
    child.setwinsize(12, 36)
    screen.resize(lines=12, columns=36)
    child.send("\x0c")
    snapshot("narrow")
    child.setwinsize(28, 90)
    screen.resize(lines=28, columns=90)
    child.send("\r")
    child.expect("completed")
    child.expect("Enter send")
    assert state()["prompts"] == ["请检查交互🙂\n第二行：不要误发送"]
    snapshot("answer")
    child.send("/sessions\r")
    child.expect("select")
    child.send("苏州")
    child.expect("苏州旅行计划")
    snapshot("session-search")
    child.send("\r")
    child.expect("Session: s-travel")
    child.expect("Enter send")
    child.send("slow\r")
    child.expect("Thinking")
    child.send("\x03")
    child.expect(r"\[aborted\]")
    child.expect("Enter send")
    assert state()["aborts"] == 1
    snapshot("stopped")
    child.send("keep this draft")
    child.send("\x03")
    child.expect("Enter send")
    child.send("/help\r")
    child.expect("Bracketed paste")
    child.expect("Enter send")
    child.send("\x04")
    child.expect(pexpect.EOF)
    child.close()
    assert child.exitstatus == 0, child.exitstatus
    assert "\x1b[?2004l" in raw.getvalue(), "Bracketed paste not disabled"
    (destination / "terminal-transcript.ansi").write_text(raw.getvalue())
    with urllib.request.urlopen(urllib.request.Request(
            url + "/v1/sessions/s-travel/messages",
            data=json.dumps({"content": "slow"}).encode(),
            headers={"content-type": "application/json"})) as response:
        detached_run = json.load(response)["runId"]
    process = subprocess.Popen([node, str(entry), "attach", detached_run, "--url", url, "--jsonl"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    first = json.loads(process.stdout.readline())
    assert first["type"] == "run.attached"
    process.send_signal(signal.SIGINT)
    stdout, stderr = process.communicate(timeout=5)
    assert process.returncode == 130, (process.returncode, stderr)
    error = json.loads(stderr)
    assert error["type"] == "cli.error" and error["runId"] == detached_run
    assert state()["aborts"] == 1, "Detaching unexpectedly aborted the server Run"
    for line in stdout.splitlines():
        json.loads(line)
    child = pexpect.spawn(node, [str(entry), "chat", "--url", url],
                          encoding="utf-8", timeout=8, dimensions=(28, 90),
                          env={**os.environ, "TERM": "xterm-256color"})
    child.expect("Enter send")
    child.kill(signal.SIGTERM)
    child.expect(pexpect.EOF)
    assert "\x1b[?2004l" in child.before
    child.close()
    assert child.exitstatus == 130
    metrics = {"pty_checks": 14, "local_first_prompt_ms": ready_ms, "paste_to_display_ms": input_ms,
               "prompts_received": state()["prompts"], "abort_requests": state()["aborts"],
               "normal_exit_code": 0, "signal_exit_code": child.exitstatus, "jsonl_sigint_exit_code": process.returncode}
    (destination / "pty-results.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
finally:
    if child and child.isalive():
        child.terminate(force=True)
    if process and process.poll() is None:
        process.kill()
        process.communicate(timeout=5)
    server.terminate()
    server.wait(timeout=5)
