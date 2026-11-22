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
environment = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
child = subprocess.Popen(["node", "scripts/spaces-preview-cli.mjs", "partner", "chat"],
                         cwd=repository, env=environment, stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True)
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
    wait_for("Space:")
    send("/resources")
    wait_for("共享测试目录")
    send("读取共享文件")
    wait_for("明确分享的测试目录")
    wait_for("completed")
    wait_for("Enter send")
    send("/space " + config["accounts"][1]["personalSpaceId"])
    wait_for("Space:")
    wait_for("Enter send")
    send("/space " + config["teamSpaceId"])
    wait_for("Space:")
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
    result = {"status": "PASS", "terminal": "macOS native PTY, xterm-256color, 140x40",
              "checks": ["scope banner", "/resources", "shared model + Node folder result",
                         "/space personal", "/space team", "/exit"]}
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
    (directory / "acceptance" / "native-terminal.log").write_bytes(transcript)
    (directory / "acceptance" / "native-terminal.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
