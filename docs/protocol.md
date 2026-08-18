# HTTP and WebSocket protocol

All responses include `schemaVersion: 1`. Every endpoint except `GET /api/v1/health` requires
`Authorization: Bearer <token>`.

- `GET /api/v1/devices`, `/session`, `/observe`, `/tree`, `/screenshot`
- `GET /api/v1/logs` uses Server-Sent Events.
- `GET /api/v1/recording` returns the bounded local recorder status or `null`.
- `GET /api/v1/video` upgrades to a binary H.264 WebSocket. Clients that explicitly opt into the
  decoded-frame extension may additionally exchange the bounded JSON messages described below.
- `GET /api/v1/control` upgrades to a JSON action WebSocket.
- `POST /api/v1/actions`, `/apps`, `/permissions`, `/files` mutate device state.

Browser WebSockets pass `serve-droid, token.<base64url-token>` in `Sec-WebSocket-Protocol`.
Credentials never appear in URL query parameters.

Authenticated JSON mutation bodies and control WebSocket messages must decode to JSON objects.
Malformed JSON and valid non-object JSON such as `null` or arrays fail as `INVALID_ARGUMENT` before
device input is attempted.

Decoded-frame screenshots are an opt-in extension to the video socket. A capable browser sends
`{"schemaVersion":1,"type":"decoded-frame-provider"}` after the socket opens. Only a socket that
sent that declaration is eligible to receive a `capture-decoded-frame` text request or return a
`decoded-frame` response. Video clients that do not opt in preserve the original binary-only H.264
output contract.

Accepted WebSocket connections contain protocol/transport `error` events so parser-level failures
such as an oversized frame cannot escape as an uncaught server exception. The control socket uses
the bounded JSON action payload limit, audio accepts at most 256 KiB inbound messages, and the video
socket uses the decoded-frame payload limit. Outbound video is skipped for a client at 4 MiB of
buffered data; outbound audio is skipped at 512 KiB. Decoded-frame providers at 256 KiB of buffered
data are not selected for new capture work, malformed provider JSON is ignored without consuming a
later valid response, and the configured video-client count is enforced before upgrade. These are
bounded-memory/fail-closed contracts, not lossless-delivery guarantees.

Uploads use `application/octet-stream` with `X-File-Name`. APKs install; other files are pushed to
`/sdcard/Download`. The limit is 256 MiB. Malformed URI encoding or NUL-containing file names fail
as `INVALID_ARGUMENT` before a temporary file or ADB operation is created. Browser clients report
byte-accurate request upload progress, then switch to a distinct indeterminate install or push phase
while waiting for ADB. The server does not invent a percentage for Android-side work. Successful
responses identify the `install` or `push` operation and include the remote destination for pushed
files.

Rotation actions complete only after the device reports the requested logical orientation. If
display metadata does not settle within five seconds, the action fails instead of allowing a later
normalized coordinate action to use stale dimensions.

Tap, swipe, and gesture requests use the control writer from the active scrcpy video session whenever
it is available. Normalized coordinates are mapped against a snapshot of that encoded frame's
dimensions. Pointer lifecycles are serialized, generated move messages and queued actions are
bounded, and an active failed gesture receives best-effort cleanup. ADB input is the startup and
helper-replacement fallback only. Once scrcpy injection begins, an error is returned as
`TRANSPORT_FAILED`; the action is not replayed through ADB because doing so could duplicate a tap or
complete only part of a gesture. Browser wheel and trackpad bursts are coalesced into swipe actions,
so they use the same control path without creating one device command per browser event.

A two-finger request adds `secondaryPoints` to the existing gesture envelope:

```json
{
  "type": "gesture",
  "gesture": {
    "points": [
      { "x": 0.4, "y": 0.5 },
      { "x": 0.2, "y": 0.5, "durationMs": 240 }
    ],
    "secondaryPoints": [
      { "x": 0.6, "y": 0.5 },
      { "x": 0.8, "y": 0.5 }
    ]
  }
}
```

The two arrays must contain the same 2–64 positions. Durations belong only to `points` and define one
shared timeline for both fingers; `secondaryPoints` must contain coordinates only. The controller
captures the encoded dimensions once, assigns two stable positive scrcpy pointer IDs, presses the
primary then secondary pointer, emits bounded synchronized moves, and releases the secondary then
primary pointer. A partial failure sends one aggregate cancel followed by reverse-order releases to
clear scrcpy's pointer state. When no scrcpy controller is ready, this request fails before device
input with `TRANSPORT_FAILED` and `details.safeToFallback: false`; two fingers are never approximated
as sequential ADB swipes.

The browser cockpit additionally streams a direct pointer lifecycle over `/api/v1/control` using the
existing gesture action envelope:

```json
{
  "type": "gesture",
  "gesture": {
    "points": [{ "x": 0.42, "y": 0.67 }],
    "stream": {
      "id": "9f30b9d6e495d70df4a8dc6498ff2f658b21",
      "phase": "begin"
    }
  }
}
```

`phase` is `begin`, `move`, `end`, or `cancel`; every message contains exactly one normalized point
and must not include `secondaryPoints`. The browser serializes responses and coalesces pending moves
to the newest point. The stream id must contain 16–128 URL-safe characters and owns one exclusive
scrcpy finger lifecycle. Frame dimensions are captured at `begin` and remain fixed until
termination.

When no scrcpy controller is ready, the ADB adapter rejects `begin` as `TRANSPORT_FAILED` with
`details.safeToFallback: true` before issuing any device command. The browser may then use its
bounded release-time tap/swipe action. It never falls back after a successful `begin`. Socket loss,
move failure, or an end failure is therefore fail-closed. Stationary holds send a sparse same-point
heartbeat; a stream abandoned without a final message is cancelled after two seconds of inactivity.

UI hierarchy capture verifies display metadata and foreground app identity before and after the
UIAutomator dump, then checks declared element packages against that app. A context or package
change triggers one fresh capture; a second mismatch fails with `TRANSPORT_FAILED` rather than
returning elements from a mixed snapshot. Hierarchies that omit package attributes remain valid.

The scrcpy video helper has one restart attempt per session. The first startup or runtime failure
replaces the helper while keeping browser clients connected. The pointer controller is retired with
the failed helper and the replacement controller becomes visible only after its video metadata is
ready. A second failure is terminal and is reported as `TRANSPORT_FAILED` with bounded restart
metadata; duplicate errors from the failed helper cannot consume additional attempts.

Log streams are scoped to the current foreground package and PID by default. Pass `package=<id>` to
follow a different package or `system=true` to opt into unfiltered system logs. These options are
mutually exclusive. A successful launch, package deep link, stop, clear, or uninstall invalidates
the cached PID; tracked packages attempt to resolve the replacement PID before the action completes
and retry safely when new entries arrive, so a long-lived stream cannot continue accepting entries
from the previous process. CLI `logs` and MCP `android_read_logs` use the foreground package by
default, accept an explicit package override, and require an explicit `--system` or `system: true`
opt-in for unfiltered logs.

HTTP Logcat streams emit Server-Sent Event `id` fields equal to each log cursor. A reconnect can send
`Last-Event-ID`; the server resumes after the newer valid cursor from that header or the explicit
`since` query parameter. If `ServerResponse.write()` reports backpressure, the server ends that SSE
response and removes its live-log subscription instead of accumulating an unbounded response queue.
This is a bounded-memory and resume contract, not a claim of lossless delivery across disconnects.
