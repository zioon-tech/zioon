"""Add only the canonical shared-reader route, with validation and rollback."""
import copy
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HOST = "workbench.zioon.tech"
MARKER = "# Zioon shared conversation reader"
BLOCK = """    # Zioon shared conversation reader
    @zioonSharedReader {
        host workbench.zioon.tech
        path /share /share/*
    }
    handle @zioonSharedReader {
        reverse_proxy 127.0.0.1:8766
    }
"""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def candidate(text):
    if MARKER in text:
        if BLOCK not in text:
            raise RuntimeError("Existing shared reader marker has an unexpected configuration")
        return text
    if "@zioonSharedReader" in text:
        raise RuntimeError("Shared reader matcher already exists without its managed marker")
    headers = list(re.finditer(r"(?m)^[ \t]*[^#\r\n]*\bworkbench\.zioon\.tech\b[^{}\r\n]*\{[ \t]*\r?$", text))
    if len(headers) != 1:
        raise RuntimeError("Expected exactly one canonical Workbench site header")
    position = headers[0].end()
    return text[:position] + "\n" + BLOCK.rstrip("\n") + text[position:]


def route_matches(value):
    matches = value.get("match")
    if not isinstance(matches, list):
        return []
    return [match for match in matches
            if isinstance(match, dict) and isinstance(match.get("host"), list)]


def host_routes(value):
    result = []
    if isinstance(value, dict):
        if any(HOST in match["host"] for match in route_matches(value)):
            result.append(value)
        for item in value.values():
            result.extend(host_routes(item))
    elif isinstance(value, list):
        for item in value:
            result.extend(host_routes(item))
    return result


def planned_json(config):
    planned = copy.deepcopy(config)
    routes = [route for route in host_routes(planned)
              if any(HOST in match["host"] and not match.get("path")
                     for match in route_matches(route))
              and any(handler.get("handler") == "subroute" for handler in route.get("handle", []))]
    if len(routes) != 1:
        raise RuntimeError("Expected exactly one adapted canonical Workbench route")
    handlers = [handler for handler in routes[0].get("handle", []) if handler.get("handler") == "subroute"]
    if len(handlers) != 1:
        raise RuntimeError("Canonical Workbench route must use a subroute")
    handlers[0].setdefault("routes", []).insert(0, {
        "match": [{"host": [HOST], "path": ["/share", "/share/*"]}],
        "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8766"}]}],
        "terminal": True,
    })
    return planned


def atomic_write(path, value, attributes):
    fd, name = tempfile.mkstemp(prefix=".zioon-share-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchown(stream.fileno(), attributes.st_uid, attributes.st_gid)
            os.fchmod(stream.fileno(), attributes.st_mode & 0o777)
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, str(path))
        fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def transaction(path, before, after, validate, reload, verify, backup, record):
    if path.read_bytes() != before:
        raise RuntimeError("Configuration changed after preflight")
    if before == after:
        validate()
        verify()
        record("already_configured")
        return
    attributes = path.stat()
    shutil.copy2(str(path), str(backup))
    with backup.open("rb") as stream:
        os.fsync(stream.fileno())
    record("prepared")
    atomic_write(path, after, attributes)
    try:
        validate()
        reload()
        verify()
        record("applied")
    except BaseException:
        if path.read_bytes() != after:
            record("configuration_changed")
            raise RuntimeError("Concurrent configuration change requires reconciliation")
        atomic_write(path, before, attributes)
        try:
            validate()
            reload()
            record("rolled_back")
        except BaseException:
            record("rollback_failed")
            raise
        raise


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError("Configuration command failed: " + args[0])
    return result.stdout


def verify_routes():
    probes = [
        ("/share/" + "A" * 43 + "/content", 404, {"state": "unavailable"}),
        ("/share/" + "A" * 43 + "/presence", 404, {"code": "document_link_unavailable"}),
        ("/health", 200, None),
    ]
    for path, expected, value in probes:
        request = urllib.request.Request("https://" + HOST + path, headers={"Cache-Control": "no-cache"})
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            if response.getcode() != expected or value is not None and json.loads(body.decode()) != value:
                raise RuntimeError("Shared reader routing check failed: " + path)


def run(check_only=True):
    config_root = pathlib.Path("/etc/caddy")
    main = config_root / "Caddyfile"
    files = [main] + sorted(config_root.glob("*.caddy")) + sorted(config_root.glob("*.conf"))
    found = []
    for path in files:
        if path.is_file():
            text = path.read_text()
            if re.search(r"(?m)^[ \t]*[^#\r\n]*\bworkbench\.zioon\.tech\b[^{}\r\n]*\{[ \t]*\r?$", text):
                found.append((path, text))
    if len(found) != 1:
        raise RuntimeError("Canonical Workbench Caddy source is ambiguous")
    path, text = found[0]
    lock_path = pathlib.Path("/run/lock/zioon-share-proxy.lock")
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.read_text() != text:
            raise RuntimeError("Configuration changed during inspection")
        adapted = json.loads(command(["caddy", "adapt", "--config", str(main), "--adapter", "caddyfile"]))
        planned = planned_json(adapted)
        after = candidate(text).encode()
        with tempfile.TemporaryDirectory(prefix="zioon-share-validation-") as directory:
            json_path = pathlib.Path(directory) / "caddy.json"
            json_path.write_text(json.dumps(planned))
            command(["caddy", "validate", "--config", str(json_path)])
        receipt = {"host": HOST, "file": str(path), "beforeSha256": digest(text.encode()),
                   "afterSha256": digest(after), "routes": ["/share", "/share/*"]}
        if check_only:
            print(json.dumps(dict(receipt, status="proxy_preflight_passed")), flush=True)
            return
        directory = pathlib.Path("/var/backups/zioon-share-proxy")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = directory / (str(int(time.time())) + "-" + receipt["beforeSha256"][:16] + ".caddy")
        journal = directory / "operations.jsonl"

        def record(status):
            with journal.open("a") as stream:
                stream.write(json.dumps(dict(receipt, timestamp=int(time.time()), status=status,
                                             backup=str(backup))) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            print(json.dumps(dict(receipt, status=status)), flush=True)

        transaction(path, text.encode(), after,
                    lambda: command(["caddy", "validate", "--config", str(main)]),
                    lambda: command(["systemctl", "reload", "caddy"]),
                    verify_routes, backup, record)


def self_test():
    source = "workbench.zioon.tech {\n    handle {\n        root * /srv/zioon-workbench/current\n        file_server\n    }\n}\n"
    updated = candidate(source)
    assert updated.count(BLOCK) == 1
    assert candidate(updated) == updated
    assert "root * /srv/zioon-workbench/current" in updated
    other = "other.example {\n    respond ok\n}\n"
    assert candidate(other + source).startswith(other)
    for invalid in [other, source + source, source.replace("handle {", "@zioonSharedReader path /share/*\n    handle {")]:
        try:
            candidate(invalid)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Ambiguous configuration must be rejected")
    original = {"apps": {"http": {"servers": {"test": {"routes": [{
        "match": [{"host": [HOST]}], "handle": [{"handler": "subroute", "routes": [{"handle": [{"handler": "file_server"}]}]}]
    }]}}}}}
    planned = planned_json(original)
    assert len(host_routes(original)[0]["handle"][0]["routes"]) == 1
    assert len(host_routes(planned)[0]["handle"][0]["routes"]) == 2
    mixed = copy.deepcopy(original)
    mixed["unrelated"] = {"match": "a string used outside a route",
                          "children": [{"match": None}, {"match": ["string", None]},
                                       {"match": [{"host": None}]}]}
    mixed_planned = planned_json(mixed)
    assert mixed_planned["unrelated"] == mixed["unrelated"]
    assert len(host_routes(mixed_planned)[0]["handle"][0]["routes"]) == 2
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "site.caddy"
        backup = pathlib.Path(directory) / "backup.caddy"
        path.write_text(source)
        events, reloads = [], []
        transaction(path, source.encode(), updated.encode(), lambda: None,
                    lambda: reloads.append(True), lambda: None, backup, events.append)
        assert path.read_text() == updated and backup.read_text() == source
        assert events == ["prepared", "applied"] and len(reloads) == 1
        path.write_text(source)
        events, reloads = [], []

        def failure():
            raise RuntimeError("fixture route check failed")

        try:
            transaction(path, source.encode(), updated.encode(), lambda: None,
                        lambda: reloads.append(True), failure, backup, events.append)
        except RuntimeError as error:
            assert str(error) == "fixture route check failed"
        else:
            raise AssertionError("Failed routing must roll back")
        assert path.read_text() == source
        assert events == ["prepared", "rolled_back"] and len(reloads) == 2
    print(json.dumps({"passed": True, "checks": ["route insertion", "idempotency", "existing route preservation",
          "ambiguous source rejection", "adapted route preservation", "non-route match field shapes",
          "atomic application", "failed routing rollback"]}))


if __name__ == "__main__" and "--self-test" in sys.argv:
    self_test()
