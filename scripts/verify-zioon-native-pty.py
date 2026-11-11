#!/usr/bin/env python3
"""Exercise the bundled CLI in Unix PTY or Windows ConPTY against local HTTP."""
import base64
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

root = Path(__file__).resolve().parent.parent
entry = root / "packages/zioon-cli/bin/zioon.mjs"
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
checks, transcript = [], []
with tempfile.TemporaryDirectory(prefix="zioon-native-") as temporary:
    directory = Path(temporary)
    env = {**os.environ, "TERM": "xterm-256color", "ZIOON_CHAT_STATE_DIR": str(directory / "state"),
           "ZION_RUNTIME_CLI_CONFIG": str(directory / "missing.json")}
    server = subprocess.Popen([node, str(root / "scripts/cli-ux-fixture.mjs")],
                              stdout=subprocess.PIPE, text=True, encoding="utf-8", env=env)
    child = None
    try:
        url = server.stdout.readline().strip()
        assert url.startswith("http://127.0.0.1:"), url
        args = [node, str(entry), "--url", url]
        if os.name == "nt":
            from winpty import PtyProcess
            child = PtyProcess.spawn(args, env=env, dimensions=(30, 96))
        else:
            import pexpect
            child = pexpect.spawn(node, args[1:], encoding="utf-8", timeout=15,
                                  dimensions=(30, 96), env=env)
            child.delaybeforesend = 0
        received = queue.Queue()
        stopped = threading.Event()

        def reader():
            try:
                while not stopped.is_set():
                    if os.name == "nt":
                        text = child.read()
                    else:
                        try:
                            text = child.read_nonblocking(65536, timeout=0.1)
                        except pexpect.TIMEOUT:
                            continue
                    if not text:
                        break
                    transcript.append(text)
                    received.put(text)
            except EOFError:
                pass
            except Exception as error:
                if not stopped.is_set():
                    received.put(error)
            finally:
                received.put(None)

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        buffered = ""

        def expect(text, timeout=20):
            global buffered
            deadline = time.monotonic() + timeout
            while text not in buffered:
                try:
                    chunk = received.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    raise AssertionError(f"Missing {text!r}; tail={buffered[-1200:]!r}")
                if chunk is None:
                    raise AssertionError(f"Terminal exited before {text!r}; tail={buffered[-1200:]!r}")
                if isinstance(chunk, Exception):
                    raise chunk
                buffered += chunk
                if time.monotonic() >= deadline:
                    raise AssertionError(f"Timed out waiting for {text!r}")
            buffered = buffered.split(text, 1)[1]

        def send(text):
            if os.name == "nt":
                child.write(text)
            else:
                child.send(text)

        def state():
            with urllib.request.urlopen(url + "/__state", timeout=5) as response:
                return json.load(response)

        expect("Enter send")
        checks.append("bundled package starts in native terminal")
        send("/model\r")
        expect("Enter open")
        send("smart\r")
        expect("Current model: smart")
        expect("Enter send")
        checks.append("model menu filters and selects")
        # Bracketed paste keeps the entire Chinese multiline draft unsubmitted.
        send("\x1b[200~你好🙂\nsecond line\x1b[201~")
        expect("second line")
        assert state()["prompts"] == []
        send("\r")
        expect("completed")
        expect("Enter send")
        assert state()["prompts"] == ["你好🙂\nsecond line"]
        checks.append("Chinese emoji and multiline paste submit once")
        attachment = directory / "中文 evidence.md"
        attachment.write_text("Native attachment evidence", encoding="utf-8")
        send(f'/file "{attachment}"\r')
        expect("Attached")
        expect("Enter send")
        send("read attachment\r")
        expect("completed")
        expect("Enter send")
        assert "Native attachment evidence" in state()["prompts"][-1]
        checks.append("attachment path preserves spaces and Chinese")
        image = directory / "截图 evidence.png"
        image.write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD5sAAAAASUVORK5CYII="))
        send(f'/image "{image}"\r')
        expect("[Image 1]")
        expect("Enter send")
        send("inspect screenshot\r")
        expect("completed")
        expect("Enter send")
        submitted = state()["sends"][-1]
        with urllib.request.urlopen(url + "/v1/sessions", timeout=5) as response:
            sessions = json.load(response)["sessions"]
        assert sessions[-1]["model"]["profileId"] == "smart", sessions
        assert any(part.get("type") == "image_url" for part in submitted["content"]), submitted
        assert len(state()["uploads"]) == 1
        checks.append("native image path uploads and sends with selected image model")
        send("slow\r")
        expect("Thinking")
        send("\x1b")
        expect("[aborted]")
        expect("Enter send")
        assert state()["aborts"] == 1
        checks.append("stop sends one abort and returns to input")
        send("/exit\r")
        deadline = time.monotonic() + 10
        while child.isalive() and time.monotonic() < deadline:
            stopped.wait(0.05)
        assert not child.isalive(), "CLI did not exit"
        thread.join(timeout=3)
        stopped.set()
        assert not thread.is_alive(), "Terminal reader did not finish"
        if os.name != "nt":
            child.close()
        assert child.exitstatus == 0, child.exitstatus
        assert "\x1b[?2004l" in "".join(transcript), "Bracketed paste was not disabled"
        checks.append("exit restores terminal and closes process")
        result = {"platform": sys.platform, "terminal": "ConPTY" if os.name == "nt" else "PTY",
                  "checks": checks, "passed": len(checks)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        (output / "native-pty-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        (output / "native-terminal.ansi").write_text("".join(transcript), encoding="utf-8")
        if child is not None and child.isalive():
            if os.name == "nt":
                child.close(force=True)
            else:
                child.terminate(force=True)
        server.terminate()
        server.wait(timeout=5)
