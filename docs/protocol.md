# HTTP and WebSocket protocol

All responses include `schemaVersion: 1`. Every endpoint except `GET /api/v1/health` requires
`Authorization: Bearer <token>`.

- `GET /api/v1/devices`, `/session`, `/observe`, `/tree`, `/screenshot`
- `GET /api/v1/logs` uses Server-Sent Events.
- `GET /api/v1/recording` returns the bounded local recorder status or `null`.
- `GET /api/v1/video` upgrades to a binary H.264 WebSocket.
- `GET /api/v1/control` upgrades to a JSON action WebSocket.
- `POST /api/v1/actions`, `/apps`, `/permissions`, `/files` mutate device state.

Browser WebSockets pass `serve-droid, token.<base64url-token>` in `Sec-WebSocket-Protocol`.
Credentials never appear in URL query parameters.

Uploads use `application/octet-stream` with `X-File-Name`. APKs install; other files are pushed to
`/sdcard/Download`. The limit is 256 MiB. Browser clients report byte-accurate request upload
progress, then switch to a distinct indeterminate install or push phase while waiting for ADB. The
server does not invent a percentage for Android-side work. Successful responses identify the
`install` or `push` operation and include the remote destination for pushed files.

Rotation actions complete only after the device reports the requested logical orientation. If
display metadata does not settle within five seconds, the action fails instead of allowing a later
normalized coordinate action to use stale dimensions.

Tap, swipe, and multi-point gesture requests use the control writer from the active scrcpy video
session whenever it is available. Normalized coordinates are mapped against a snapshot of that
encoded frame's dimensions. One finger lifecycle is serialized, generated move messages and queued
actions are bounded, and an active failed gesture receives a best-effort cancel. ADB input is the
startup and helper-replacement fallback only. Once scrcpy injection begins, an error is returned as
`TRANSPORT_FAILED`; the action is not replayed through ADB because doing so could duplicate a tap or
complete only part of a gesture. Browser wheel and trackpad bursts are coalesced into swipe actions,
so they use the same control path without creating one device command per browser event.

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
