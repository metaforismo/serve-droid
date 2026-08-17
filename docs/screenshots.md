# Agent screenshots

serve-droid uses the already-decoded browser frame before starting a separate Android screenshot
command. This keeps the screenshot aligned with what the operator is viewing and avoids unnecessary
ADB work while the cockpit is active.

## Capture order

1. An authenticated agent request asks the server for a JPEG up to 1080 pixels wide at quality 75.
2. An authenticated browser explicitly advertises `decoded-frame-provider` on its existing video
   WebSocket. Only opted-in sockets may receive a small `capture-decoded-frame` request; legacy video
   clients continue to receive binary H.264 only.
3. Each browser snapshots its current decoded canvas, scales it proportionally, and performs at most
   six bounded JPEG encoding attempts. Frames are never uploaded periodically.
4. The first canonical response received within one second wins.
5. If no provider is connected, every provider reports that no frame is ready, a response is invalid,
   or the deadline expires, the server runs the existing bounded ADB `screencap` fallback.

HTTP `GET /api/v1/screenshot` reports the selected path in
`X-Serve-Droid-Screenshot-Source: stream|device` and includes actual JPEG dimensions when available.
MCP `android_observe` includes the same source, dimensions, and capture timestamp in its text
metadata while returning the JPEG as image content.

## Security and resource bounds

The decoded-frame request uses a cryptographically random 128-bit identifier and travels over the
same bearer-authenticated video WebSocket as the H.264 stream, after the browser explicitly opts in.
No token is added to a query string and no new listener is opened.

Browser responses are capped at 1,500,000 decoded bytes and the video socket accepts at most a
2,100,000-byte inbound message. The server validates the version, request ID, MIME type, canonical
base64 representation, JPEG start/end markers, real SOF dimensions, declared dimensions, requested
maximum width, and total byte count. A malformed provider is removed from the current request; another
connected provider may still succeed. Concurrent callers with identical bounds share one in-flight
capture; callers with different width, quality, byte, or timeout bounds are serialized so one caller
can never inherit a looser request.

Only screenshot metadata is recorded. JPEG bytes and base64 content are never written to the session
event log. Closing the server resolves an outstanding request as unavailable before sockets are
closed.

## Honest limitations

A browser must have rendered at least one decoded frame and be allowed to export its canvas. A
protected Android surface may still appear blank in the stream. serve-droid does not treat a blank
image as proof of a secure screen. When browser capture is unavailable it uses the existing ADB path,
which may return the typed secure-screen or device-policy errors documented in
[interaction-errors.md](interaction-errors.md).
