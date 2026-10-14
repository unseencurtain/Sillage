#!/usr/bin/env python3
"""Build a minimal SSH config from named ~/.ssh/config blocks, excluding unsafe system includes."""
from __future__ import annotations

import os
import shlex
import stat
import sys
import tempfile
from pathlib import Path

if len(sys.argv) < 2:
    raise SystemExit("Usage: ssh-config-for-aliases.py <alias> [alias ...]")
source = Path.home() / ".ssh/config"
if not source.is_file():
    raise SystemExit(f"Missing SSH config: {source}")
requested = list(dict.fromkeys(sys.argv[1:]))
blocks: dict[str, dict[str, str]] = {}
current: list[str] = []
for raw in source.read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    try:
        fields = shlex.split(line, comments=True)
    except ValueError:
        continue
    if not fields:
        continue
    key, *values = fields
    key = key.lower()
    if key == "host":
        current = [v for v in values if not any(ch in v for ch in "*!?")]
        for alias in current:
            blocks.setdefault(alias, {})
        continue
    if key in {"hostname", "user", "port", "identityfile", "identitiesonly", "stricthostkeychecking", "connecttimeout"} and values:
        for alias in current:
            # The first matching value wins, as in ssh_config.
            blocks[alias].setdefault(key, values[0])

lines = ["# Generated for Sillage deploy; excludes unsafe system-wide includes."]
for alias in requested:
    config = blocks.get(alias)
    if not config or not config.get("hostname"):
        raise SystemExit(f"No explicit HostName for SSH alias: {alias}")
    lines.extend((f"Host {alias}", f"  HostName {config['hostname']}"))
    for key in ("user", "port", "identityfile"):
        if key in config:
            value = config[key].replace("~/", f"{Path.home()}/", 1)
            lines.append(f"  {key} {value}")
    lines.append("  IdentitiesOnly yes")
    lines.append("  BatchMode yes")
    lines.append("  ConnectTimeout 15")
    if "stricthostkeychecking" in config:
        lines.append(f"  StrictHostKeyChecking {config['stricthostkeychecking']}")
    lines.append("")
fd, path = tempfile.mkstemp(prefix="sillage-ssh-", text=True)
os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
with os.fdopen(fd, "w") as output:
    output.write("\n".join(lines))
print(path)
