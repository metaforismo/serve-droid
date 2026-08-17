# Architecture

The core package owns the typed Android operation contracts and the bounded ADB implementation.
CLI and MCP use that service directly. The server additionally owns the live scrcpy session used by
the browser cockpit.

```text
                         ┌── ADB ───── core ───── CLI / MCP
Android device ──────────┤                 └──── server fallback
                         └── scrcpy video + control ── server ── browser
```

Each active device has one helper process, one bounded Logcat buffer, one H.264 source, one scrcpy
control writer, and one private state file. Video is relayed without host-side decode/re-encode.
Latency-sensitive browser tap, swipe, wheel, trackpad, and multi-point gesture actions use the
control writer from that same scrcpy generation. ADB is used only when control is unavailable, such
as during startup or bounded helper replacement; a partially failed scrcpy action is never replayed
through ADB.

The pointer controller snapshots the current encoded video dimensions, maps normalized coordinates
to that exact frame, serializes callers onto one finger pointer, caps queued actions and generated
move messages, and sends a best-effort cancel if an active gesture fails. The restarting video
wrapper exposes only the controller belonging to its current helper generation.

Observations combine display metadata, foreground activity, a normalized UIAutomator hierarchy,
incremental package logs, and a screenshot reference. Element misses and ambiguities are errors;
pixel guesses are never a fallback.
