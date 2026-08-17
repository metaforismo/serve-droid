from pathlib import Path

path = Path("packages/core/src/interaction-errors.ts")
content = path.read_text(encoding="utf-8")
content = content.replace(
    "function boundedMessage(value: string): string {",
    "export function boundedInteractionMessage(value: string): string {",
    1,
)
content = content.replace("return boundedMessage(value);", "return boundedInteractionMessage(value);", 1)
content = content.replace(
    "return boundedMessage(value.message);",
    "return boundedInteractionMessage(value.message);",
    1,
)
content = content.replace(
    "return boundedMessage(String(value));",
    "return boundedInteractionMessage(String(value));",
    1,
)
content = content.replace(
    "return boundedMessage(result.stderr || result.stdout || `adb exited ${result.exitCode}`);",
    "return boundedInteractionMessage(\n    result.stderr || result.stdout || `adb exited ${result.exitCode}`,\n  );",
    1,
)
if "function boundedMessage" in content or "boundedMessage(" in content:
    raise SystemExit("not every bounded message reference was migrated")
if "export function boundedInteractionMessage" not in content:
    raise SystemExit("shared bounded message export was not created")
path.write_text(content, encoding="utf-8")
