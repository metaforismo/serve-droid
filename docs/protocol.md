# HTTP and WebSocket protocol

All responses include `schemaVersion: 1`. Every endpoint except `GET /api/v1/health` requires
`Authorization: Bearer <token>`.

- `GET /api/v1/devices`, `/session`, `/observe`, `/tree`, `/screenshot`
- `GET /api/v1/logs` uses Server-Sent Events.
- `GET /api/v1/video` upgrades to a binary H.264 WebSocket.
- `GET /api/v1/control` upgrades to a JSON action WebSocket.
- `POST /api/v1/actions`, `/apps`, `/permissions`, `/files` mutate device state.

Browser WebSockets pass `serve-droid, token.<base64url-token>` in `Sec-WebSocket-Protocol`.
Credentials never appear in URL query parameters.

Uploads use `application/octet-stream` with `X-File-Name`. APKs install; other files are pushed to
`/sdcard/Download`. The limit is 256 MiB.
