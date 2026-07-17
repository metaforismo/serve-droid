# Contributing

1. Open an issue for behavior or protocol changes.
2. Keep device operations in `@serve-droid/core`; adapters must not duplicate ADB behavior.
3. Add deterministic tests, run `pnpm verify`, and add a Changeset for user-visible changes.
4. Never commit APKs, Android SDK files, recordings, screenshots, device identifiers, or tokens.

Use Conventional Commits. Pull requests must describe verification on each affected host/device.
