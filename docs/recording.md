# Opt-in session recording

Recording is off by default. Enable it only for a session that you are authorized to capture:

```sh
serve-droid start --record ./recordings --record-max-mb 1024 --record-max-minutes 60
```

The selected root receives a private `session-<serial>-<timestamp>-<id>` directory. serve-droid does
not upload recordings or delete them automatically.

## Format

- `video.h264`: the original H.264 Annex-B stream from scrcpy. The host does not decode or
  re-encode it.
- `events.jsonl`: bounded lifecycle and control-event summaries. New events include a monotonic
  microsecond timestamp and sequence number in addition to wall-clock time. Trace export treats that
  monotonic clock as authoritative for new recordings and validates that it never regresses.
- `manifest.json`: schema version, device serial, limits, timestamps, byte count, and final status.

Events intentionally exclude bearer tokens, Logcat, screenshots, clipboard data, typed text, deep
link URLs, local and remote file paths, and file contents. Text actions retain only their character
count. A recording can still contain sensitive pixels rendered by the device; review it before
sharing.

## Browser controls

Recording controls are disabled unless the host explicitly authorizes a directory. To allow the
browser cockpit to start and stop recordings without recording immediately:

```sh
serve-droid start --record-controls ./recordings --record-max-mb 1024 --record-max-minutes 60
```

The browser can only toggle recording inside the host-selected root and limits. It cannot supply a
path, byte limit, or duration. `--record` still starts recording immediately and also makes the same
start/stop control available for later recordings in that root. Anyone holding a valid session
token can use an authorized browser control, so do not enable it for a session whose authenticated
viewers should not be allowed to capture device pixels.

## Limits and retention

The byte limit applies to the combined H.264 and event streams. A complete chunk that would exceed
the limit is not written. The time limit stops new recording writes but leaves the live device
session running. The final manifest records `completed`, `size-limit`, or `time-limit`.

Recordings remain until explicitly removed. Cleanup accepts only a directory containing a
recognized serve-droid manifest and refuses a recording owned by a live process:

```sh
serve-droid recording remove ./recordings/session-emulator-5554-... --yes
```

## Trace export

A finalized or recovered recording can be exported without decoding the H.264 video:

```sh
serve-droid recording trace ./recordings/session-emulator-5554-... -o session.trace.json
```

The output is streaming Chrome Trace Event JSON that can be opened in Perfetto. Lifecycle, input,
device, capture, and transport events are placed on separate tracks. The exporter reuses only the
privacy-filtered metadata already present in `events.jsonl`; it does not add Logcat, tokens, typed
text, deep-link URLs, local/remote file paths, or file contents.

New recordings use monotonic microsecond timestamps and strictly increasing event sequence metadata;
a regression makes export fail closed. Older recordings that predate monotonic metadata fall back to
relative wall-clock timestamps. If the host clock moved backwards, trace export preserves JSONL event
order by clamping only the affected legacy event to the previous trace timestamp and marks the event
with `timingAdjusted` plus its original `sourceTimestampUs` value. This avoids drawing a misleading
backwards timeline without pretending the legacy source clock was monotonic.

Trace export refuses active/unrecovered recordings, unsafe stream-file types, malformed manifests,
and existing output files. It caps each source event line at 64 KiB, streams the input instead of
loading the entire recording into memory, and deletes a partially written trace if validation fails.
A recovered crash may end with an incomplete final JSONL fragment; only that final unterminated
fragment is dropped and its byte count is reported.

## Crash recovery

While active, a recording has `manifest.partial.json`. Starting another recording in the same root
automatically marks valid partial manifests owned by dead processes as `manifest.crashed.json`; it
never touches a live recorder. Recovery verifies that both recording streams are regular files and
reconstructs `bytesWritten` from the bytes actually persisted before the crash rather than trusting
the stale partial-manifest counter. Recovery can also be requested explicitly:

```sh
serve-droid recording recover ./recordings
```

The H.264 and JSONL files remain usable up to the last fully written chunk after a crash.
