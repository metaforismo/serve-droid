# Session activity

Serve Droid keeps a small in-memory history of recent structured session events so an authenticated
human or agent can understand what just happened without enabling a recording or reading raw
Logcat.

Activity is bounded to the latest 256 events. It is session-local, is not persisted, and is cleared
when the server process ends.

## HTTP API

Read the current retained page:

```http
GET /api/v1/activity
Authorization: Bearer <session-token>
```

Resume after a previously observed cursor:

```http
GET /api/v1/activity?since=42
Authorization: Bearer <session-token>
```

The response contains:

```json
{
  "schemaVersion": 1,
  "events": [],
  "nextCursor": "42",
  "truncated": false
}
```

`nextCursor` is the newest event cursor known to the server. A client should use it as the next
`since` value. `truncated: true` means the requested cursor fell behind the bounded retention window;
the response then contains every event still retained. Malformed, negative, fractional, or unsafe
integer cursors are rejected with `INVALID_ARGUMENT`.

## Privacy boundary

Activity uses an explicit metadata allowlist for each event type. Unknown fields are discarded
before an event enters the buffer. In particular, Activity does not retain:

- bearer tokens or other credentials;
- typed text or clipboard contents;
- deep-link URLs;
- local or remote file paths;
- uploaded file contents;
- Logcat messages;
- screenshot or video bytes.

Text input records only its character count. File events retain only the operation. Screenshot events
retain only source and dimensions. String metadata that is allowed is capped to 256 UTF-8 bytes.

The same sanitized event is forwarded to `events.jsonl` when session recording is active. This keeps
the live Activity view and recording trace on one redaction policy instead of maintaining two
slightly different copies of the same event metadata.

## Retention semantics

The buffer stores at most 256 events and returns copies of retained entries so a consumer cannot
mutate server state. Activity is deliberately not a durable audit log: use opt-in session recording
when persistence is required, and review the recording privacy model before sharing captured device
pixels.
