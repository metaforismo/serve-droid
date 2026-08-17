from pathlib import Path

path = Path("packages/server/src/server.ts")
content = path.read_text(encoding="utf-8")
old = 'Buffer.from(message as ArrayBuffer).toString("utf8")'
new = 'Buffer.from(message).toString("utf8")'
if old in content:
    path.write_text(content.replace(old, new, 1), encoding="utf-8")
elif new not in content:
    raise SystemExit("decoded frame WebSocket message marker was not found")
