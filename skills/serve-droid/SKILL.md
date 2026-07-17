---
name: serve-droid
description: Stream, inspect, and control an Android emulator or physical device from a browser or agent.
license: Apache-2.0
---

# serve-droid

Use serve-droid for Android API 26+ devices visible to ADB. It provides a browser cockpit, normalized
gestures, screenshots, semantic UI elements, foreground app state, bounded logs, and app operations.

## Prerequisites

Run `npx serve-droid doctor` first. Node 22+, Android Platform Tools, an authorized ADB device, and a
current Chromium browser are required. Do not proceed if doctor fails.

## Start and discover

```sh
npx serve-droid start --detach --json
npx serve-droid list --json
```

Always surface the returned browser URL. Use `--device <serial>` when multiple devices are attached.

## Agent rules

- Coordinates are normalized `0..1`, logical top-left origin.
- Use semantic elements before coordinates.
- If an element query returns zero or multiple matches, stop and report it. Never guess.
- In MCP clients, use `android_tap_element` with exactly one exact selector after observing.
- Use `tap` for taps and one `swipe` or gesture transaction for motion.
- Use `--json`; never parse human output.
- `clear` and `uninstall` are destructive and require explicit confirmation.
- Stop detached helpers with `npx serve-droid stop <device>` when finished.
- Never expose ADB or the serve-droid listener to an untrusted network.

See `references/workflows.md` for verified loops.
