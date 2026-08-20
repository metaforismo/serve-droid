# Session activity

Serve Droid keeps a small in-memory history of recent structured session events so an authenticated
human or agent can understand what just happened without enabling a recording or reading raw
Logcat.

Activity is bounded to the latest 256 events. It is session-local, is not persisted, and is cleared
when the server process ends. The same retained stream is available in the browser inspector, the
CLI, and the authenticated HTTP API; none of those surfaces maintains a separate event history.

## CLI

Read the current retained Activity page from the only live session:

```bash
serve-droid activity
```

Select a specific session by device serial or model when more than one session is running:

```bash
serve-droid activity emulator-5554
serve-droid --device emulator-5554 activity
```

Resume after a previously observed cursor:

```bash
serve-droid activity --since 42
```

Use the global `--json` flag for stable machine-readable output:

```bash
serve-droid --json activity --since 42
```

The JSON result includes the server Activity page plus the selected session's serial and model. The
CLI uses the persisted live-session token internally for the authenticated request, but never emits
that token in normal or JSON output. Session selection rejects missing or ambiguous matches instead
of guessing which live device to inspect.

## Browser inspector

Open **Activity** in the cockpit inspector to see the same privacy-filtered stream. The browser only
polls while the Activity tab is selected and the inspector is visible, then resumes from its last
cursor when reopened. If the client falls behind the bounded retention window, it replaces stale
local history with the retained server window instead of presenting a discontinuous timeline as
complete.

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
