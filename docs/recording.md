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
- `events.jsonl`: bounded lifecycle and control-event summaries.
- `manifest.json`: schema version, device serial, limits, timestamps, byte count, and final status.

Events intentionally exclude bearer tokens, Logcat, screenshots, clipboard data, typed text, deep
link URLs, local and remote file paths, and file contents. Text actions retain only their character
count. A recording can still contain sensitive pixels rendered by the device; review it before
sharing.

## Limits and retention

The byte limit applies to the combined H.264 and event streams. A complete chunk that would exceed
the limit is not written. The time limit stops new recording writes but leaves the live device
session running. The final manifest records `completed`, `size-limit`, or `time-limit`.

Recordings remain until explicitly removed. Cleanup accepts only a directory containing a
recognized serve-droid manifest and refuses a recording owned by a live process:

```sh
serve-droid recording remove ./recordings/session-emulator-5554-... --yes
```

## Crash recovery

While active, a recording has `manifest.partial.json`. Starting another recording in the same root
automatically marks partial manifests owned by dead processes as `manifest.crashed.json`; it never
touches a live recorder. Recovery can also be requested explicitly:

```sh
serve-droid recording recover ./recordings
```

The H.264 and JSONL files remain usable up to the last fully written chunk after a crash.
