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
