#!/usr/bin/env python3
"""Read-only queries for biography/events.jsonl."""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path


def load_events(path):
    events = []
    try:
        with Path(os.path.expanduser(path)).open("r", encoding="utf-8") as stream:
            for line in stream:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and value.get("id"):
                    events.append(value)
    except FileNotFoundError as error:
        raise SystemExit(f"Biography file is unavailable: {path}") from error
    return events


def event_time(event):
    return str(event.get("at", ""))


def sorted_events(events):
    return sorted(events, key=event_time, reverse=True)


def index(events):
    projects = Counter(event.get("project") for event in events if event.get("project"))
    topics = Counter(topic for event in events for topic in event.get("topics", []) if topic)
    return {
        "projects": [{"label": label, "count": count} for label, count in sorted(projects.items(), key=lambda item: (-item[1], item[0]))],
        "topics": [{"label": label, "count": count} for label, count in sorted(topics.items(), key=lambda item: (-item[1], item[0]))],
        "eventCount": len(events),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("index", "project", "topic", "event", "session", "recent"))
    parser.add_argument("value", nargs="?")
    parser.add_argument("--path", required=True, help="Absolute events.jsonl path from the plugin data location")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    events = load_events(args.path)

    if args.command == "index":
        result = index(events)
    else:
        limit = max(1, min(args.limit, 100))
        if args.command == "project":
            matches = [event for event in events if event.get("project") == args.value]
        elif args.command == "topic":
            matches = [event for event in events if args.value in event.get("topics", [])]
        elif args.command == "event":
            matches = [event for event in events if event.get("id") == args.value]
        elif args.command == "session":
            matches = [event for event in events if event.get("sessionId") == args.value]
        else:
            matches = events
        matches = sorted_events(matches)
        result = {
            "query": {"command": args.command, "value": args.value},
            "total": len(matches),
            "hasMore": len(matches) > limit,
            "events": matches[:limit],
        }

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
