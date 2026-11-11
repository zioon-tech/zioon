#!/usr/bin/env python3
"""Image composer journeys in a real PTY, against the local HTTP fixture."""
import base64
import io
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
import pexpect
import pyte

root = Path(__file__).resolve().parent.parent
entry, destination = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
temporary = tempfile.TemporaryDirectory(prefix="zioon-image-pty-")
directory = Path(temporary.name)
server = subprocess.Popen([node, str(root / "scripts/cli-ux-fixture.mjs")], stdout=subprocess.PIPE, text=True)
url = server.stdout.readline().strip()
checks, child = [], None
raw = io.StringIO()
screen = pyte.Screen(100, 32)
stream = pyte.Stream(screen)

def png(rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + bytes(rgb) * 2) * 2)) + chunk(b"IEND", b"")

first, second = directory / "红 图.png", directory / "蓝 图.png"
first.write_bytes(png([255, 0, 0]))
second.write_bytes(png([0, 0, 255]))
helper = directory / "osascript"
clipboard_mode = directory / "clipboard-mode"
clipboard_mode.write_text("png")
helper.write_text(f"""#!{sys.executable}
from pathlib import Path
import subprocess
import sys
mode=Path({str(clipboard_mode)!r}).read_text().strip()
encoded={base64.b64encode(png([0, 255, 0])).decode()!r}
args=sys.argv[1:]
script=args[-1].replace('$.NSPasteboard.generalPasteboard','$.NSPasteboard.pasteboardWithUniqueName')
source="const source=$.NSData.alloc.initWithBase64EncodedStringOptions('"+encoded+"',0); "
if mode=='tiff':
    source+="p.setDataForType($.NSBitmapImageRep.imageRepWithData(source).TIFFRepresentation,'public.tiff'); "
elif mode=='png':
    source+="p.setDataForType(source,'public.png'); "
elif mode=='invalid':
    source+="p.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions('aW52YWxpZA==',0),'public.png'); "
elif mode=='text':
    source+="p.setStringForType('test clipboard text','public.utf8-plain-text'); "
script=script.replace('const images=',source+'const images=')
result=subprocess.run(['/usr/bin/osascript',*args[:-1],script],capture_output=True)
sys.stdout.buffer.write(result.stdout); sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
""")
helper.chmod(0o700)
environment = {**os.environ, "TERM": "xterm-256color", "ZIOON_CHAT_STATE_DIR": str(directory / "state"),
               "ZION_RUNTIME_CLI_CONFIG": str(directory / "absent.json"), "PATH": f"{directory}:{os.environ['PATH']}"}

class Capture:
    def write(self, text):
        raw.write(text)
        stream.feed(text)
    def flush(self):
        pass

def start(*args):
    global child
    child = pexpect.spawn(node, [str(entry), "--url", url, *args], env=environment,
                          encoding="utf-8", timeout=12, dimensions=(32, 100))
    child.delaybeforesend = 0
    child.logfile_read = Capture()
    child.expect("Enter send")

def drain():
    try:
        while True:
            child.read_nonblocking(65536, timeout=0.1)
    except pexpect.TIMEOUT:
        pass

def state():
    with urllib.request.urlopen(url + "/__state") as response:
        return json.load(response)

def snapshot(name):
    drain()
    destination.joinpath(f"images-{name}.txt").write_text("\n".join(line.rstrip() for line in screen.display) + "\n")

try:
    start()
    child.send("比较一下这两张图片")
    child.send(f"\x1b[200~'{first}' '{second}'\x1b[201~")
    child.expect("Image attached")
    assert not state()["uploads"] and not state()["prompts"]
    snapshot("composer")
    display = "\n".join(screen.display)
    assert "比较一下这两张图片" in display and "[Image 2]" in display
    checks.append("bracketed multi-file drop adds numbered attachments while preserving Chinese draft; no upload yet")

    child.send("\x1bi")
    child.expect("View")
    child.send("\x1b")
    child.expect("比较一下这两张图片")
    child.send("\x1bi")
    child.expect("View")
    child.send("remove 2\r")
    child.expect("Image removed")
    snapshot("removed")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    checks.append("Alt+I cancel and selective removal return to the unsent text")

    child.send("\x16")
    child.expect("Image attached")
    child.send("\x16")
    child.expect("Image attached")
    snapshot("clipboard")
    assert len(list((directory / "state").rglob("*.png"))) == 3
    checks.append("Ctrl+V invokes native AppKit PNG conversion on private pasteboard, deduplicates and preserves draft")
    clipboard_mode.write_text("tiff")
    child.send("\x1b[200~")
    child.send("\x1b[201~")
    child.expect("Image attached")
    snapshot("empty-paste")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    assert not state()["prompts"]
    checks.append("empty bracketed paste invokes native screenshot TIFF conversion and preserves Chinese draft")
    for sequence in ["\x1bv", "\x1b[118;5u", "\x1b[118;3u", "\x1b[118;9u", "\x1b[27;5;118~", "\x1b[27;3;118~"]:
        child.send(sequence)
        child.expect("Image attached")
    checks.append("Alt+V, CSI-u Ctrl/Alt/Cmd+V and modifyOtherKeys paste bindings import images")
    clipboard_mode.write_text("text")
    child.send("\x16")
    child.expect("Clipboard has no image")
    snapshot("no-image")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    assert not state()["prompts"]
    assert "Ctrl+Cmd+Shift+4" in raw.getvalue()
    checks.append("text-only clipboard explains screenshot-to-clipboard shortcut and leaves draft intact")
    clipboard_mode.write_text("invalid")
    child.send("\x16")
    child.expect("Clipboard image could not be converted")
    snapshot("invalid-image")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    checks.append("invalid image bytes produce visible conversion failure without clearing the draft")
    clipboard_mode.write_text("tiff")
    child.send(f"'{first}' ")
    child.expect("Image attached")
    snapshot("raw-drop")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    assert not state()["prompts"]
    checks.append("raw terminal file drop preserves an existing draft and deduplicates its image")

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        records = [json.loads(path.read_text()) for path in (directory / "state").rglob("*.json")]
        if any(len(record.get("images", [])) == 2 and record.get("draft") == "比较一下这两张图片" for record in records):
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Image draft did not persist")
    child.kill(signal.SIGTERM); child.expect(pexpect.EOF); child.close()
    first.unlink(); second.unlink()
    start()
    assert "Draft restored" in raw.getvalue()
    snapshot("restored")
    assert "[Image 2]" in "\n".join(screen.display)
    assert not state()["prompts"]
    checks.append("process restart restores draft and image bytes after original files are removed")

    child.send("\r")
    child.expect("supports images")
    child.send("\x1b")
    child.expect("Draft retained")
    child.expect("Enter send")
    snapshot("model-cancel")
    assert "比较一下这两张图片" in "\n".join(screen.display)
    assert not state()["uploads"]
    checks.append("unsupported-model picker cancellation restores input without uploading")

    child.send("\r")
    child.expect("supports images")
    child.send("\r")
    child.expect("Current model: smart")
    child.expect("completed")
    child.expect("Enter send")
    current = state()
    assert len(current["uploads"]) == 2 and len(current["prompts"]) == 1
    assert current["prompts"][0][0]["text"] == "比较一下这两张图片"
    assert len([part for part in current["prompts"][0] if part["type"] == "image_url"]) == 2
    checks.append("model picker submits original text and two images exactly once")

    child.send("\x16"); child.expect("Image attached")
    child.setwinsize(20, 42); screen.resize(20, 42)
    child.send("窄窗口继续编辑")
    child.expect("窄窗口继续编辑")
    snapshot("narrow")
    assert any("[Image 1]" in line for line in screen.display)
    checks.append("attachment strip and Chinese editing remain usable at 42 columns")
    child.send("\x03/images clear\r")
    child.expect("No images.")
    child.send("/paste\r")
    child.expect(r"\[Image 1\]")
    assert len(state()["prompts"]) == 1 and len(state()["uploads"]) == 2
    checks.append("/paste fallback invokes native TIFF conversion without submitting another message")
    child.send("/images clear\r"); child.expect("No images.")
    child.send("/exit\r"); child.expect(pexpect.EOF); child.close()
    assert child.exitstatus == 0
    checks.append("clear attachments and exit restore terminal modes")
    destination.joinpath("images-terminal.ansi").write_text(raw.getvalue())
    result = {"platform": sys.platform, "passed": len(checks), "checks": checks,
              "clipboard_key": "Real PTY paste bindings and native AppKit conversion; private pasteboard replaces only the clipboard source",
              "windows_linux_native_terminal": "not run"}
    result["version"] = subprocess.check_output([node, str(entry), "--version"], text=True).strip()
    destination.joinpath("images-pty-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    if child and child.isalive():
        child.terminate(force=True)
    server.terminate(); server.wait(timeout=5)
    temporary.cleanup()
