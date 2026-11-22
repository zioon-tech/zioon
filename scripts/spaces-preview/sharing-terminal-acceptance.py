import json
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import fcntl
import time
from pathlib import Path

repository = Path(__file__).resolve().parents[2]
directory = repository / ".runtime-data" / "spaces-preview"
config = json.loads((directory / "config.local.json").read_text())
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
child = subprocess.Popen(["node", "scripts/spaces-preview-cli.mjs", "partner", "chat"],
                         cwd=repository, env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
transcript = bytearray()
cursor = 0


def wait_for(text, timeout=15):
    global cursor
    target = text.encode()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        match = transcript.find(target, cursor)
        if match >= 0:
            cursor = match + len(target)
            return
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                transcript.extend(os.read(master, 65536))
            except OSError:
                break
        if child.poll() is not None:
            break
    raise AssertionError("Terminal did not display: " + text)


def send(text):
    os.write(master, text.encode() + b"\r")


try:
    wait_for("Private conversation")
    wait_for("Enter send")
    send("/shares")
    wait_for("对象分享的模型")
    wait_for("Enter send")
    send("/model share." + config["sharingModelId"])
    wait_for("Current model:")
    wait_for("Enter send")
    send("用对象分享的模型整理周末行程")
    wait_for("本地测试模型")
    wait_for("completed")
    wait_for("Enter send")
    send("/shared " + config["sharingDocumentShareId"])
    wait_for("Shared:")
    wait_for("Enter send")
    send("/model spaces-local-fixture")
    wait_for("Current model:")
    wait_for("Enter send")
    send("在共同旅行计划里补充交通方案")
    wait_for("本地测试模型")
    wait_for("completed")
    wait_for("Enter send")
    send("/new")
    wait_for("Private conversation")
    wait_for("Enter send")
    send("/exit")
    deadline = time.monotonic() + 10
    while child.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                transcript.extend(os.read(master, 65536))
            except OSError:
                break
    child.wait(timeout=1)
    assert child.returncode == 0
    assert b"Space:" not in transcript
    result = {"status": "PASS", "terminal": "macOS native PTY, xterm-256color, 140x40",
              "checks": ["private startup", "received sharing list", "borrowed model in private chat",
                         "original shared conversation", "own model in shared chat",
                         "streaming Chinese Markdown answer", "return to private chat", "clean exit"]}
except Exception as error:
    result = {"status": "FAIL", "error": str(error)}
    raise
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
    os.close(master)
    (directory / "acceptance/sharing-native-terminal.log").write_bytes(transcript)
    (directory / "acceptance/sharing-native-terminal.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
