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
Latency-sensitive browser input uses the control writer from that same scrcpy generation. ADB is
used only when control is unavailable, such as during startup or bounded helper replacement; a
partially started scrcpy action is never replayed through ADB.

Direct browser pointer input is streamed as an explicit `begin → move* → end` lifecycle over the
authenticated control WebSocket. The browser keeps at most one request and one latest move pending,
so high-frequency pointer events cannot create an unbounded command queue. The scrcpy controller
holds one exclusive finger stream, snapshots the encoded frame size at `begin`, and maps every later
move against that same coordinate space. A cryptographically random stream id prevents unrelated
callers from taking over the active pointer.

If scrcpy control is unavailable before `begin`, the ADB adapter rejects the stream before issuing a
device command and marks the response as safe for the existing bounded tap/swipe fallback. Once a
live `DOWN` has been accepted, later errors fail closed. A sparse same-point browser heartbeat keeps
stationary long presses alive; an abandoned stream receives a best-effort `CANCEL` after two seconds
without a move, end, heartbeat, or explicit cancel. Discrete taps, swipes, wheel
bursts, and multi-point gestures remain serialized and bounded by the same controller.

Observations combine display metadata, foreground activity, a normalized UIAutomator hierarchy,
incremental package logs, and a screenshot reference. Element misses and ambiguities are errors;
pixel guesses are never a fallback.
