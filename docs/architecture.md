# Architecture

The core package owns every Android operation. CLI, HTTP, browser, and MCP are adapters over that
single service.

```text
Android device ── ADB ── core ── server ── browser
                         │   └──── MCP
                         └──────── CLI
```

Each active device has one helper process, one bounded Logcat buffer, one H.264 source, and one
private state file. Video is relayed without host-side decode/re-encode. Device input remains an
explicit typed operation.

Observations combine display metadata, foreground activity, a normalized UIAutomator hierarchy,
incremental package logs, and a screenshot reference. Element misses and ambiguities are errors;
pixel guesses are never a fallback.
