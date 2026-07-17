# Agent instructions

- Run `pnpm verify` before claiming completion.
- Use `--json` for machine-readable CLI output.
- Never parse human CLI text, guess coordinates after a missing UI element, or invoke arbitrary ADB
  shell commands through public interfaces.
- All coordinates are normalized to `0..1` and refer to the current logical orientation.
- Do not weaken loopback binding or bearer authentication.
- Do not commit generated APKs, tokens, state files, recordings, screenshots, or Android SDK files.
- Real-device claims require `SERVE_DROID_DEVICE_TEST=1` evidence and the tested device matrix.
