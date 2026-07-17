# serve-droid

**A shared browser cockpit and agent control plane for Android.** Stream an emulator or physical
device, control it from Chrome or Edge, inspect its semantic UI tree and Logcat, or hand the same
session to an MCP-compatible coding agent.

> Status: v0.1 development release. The public API is versioned, but video transport and device
> compatibility still need validation on the published support matrix.

```bash
npx serve-droid
# → Browser cockpit at a local authenticated URL
```

![serve-droid browser cockpit showing a demo Android fixture, searchable Logcat console, and device controls](docs/assets/serve-droid-cockpit.jpg)

_Deterministic documentation demo: live device stream, semantic UI tree, filtered Logcat, and
human controls share the same session. This image is not real-device validation; hardware evidence
is tracked separately in the release checklist._

## What you get

- H.264 device streaming and control in a local browser cockpit.
- Exact semantic element targeting that stops on missing or ambiguous matches.
- Searchable, priority-filtered Logcat with pause, clear, and copy controls.
- One bounded observation containing the screen, UI hierarchy, foreground app, device state, and
  incremental logs.
- The same capabilities through CLI, authenticated HTTP/WebSocket APIs, MCP, and an Agent Skill.

## Why

Android Studio mirrors devices, scrcpy provides excellent native display/control, and Maestro is a
strong test automation system. serve-droid focuses on a different loop: a human and an AI agent
sharing one observable browser session during development and debugging.

## Requirements

- Node.js 22 or newer
- [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) with
  `adb` on `PATH`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT`
- An Android 8 / API 26+ emulator or device visible in `adb devices -l`
- A current Chrome, Edge, Safari, or Firefox browser. Chromium uses WebCodecs; Safari and Firefox
  use the higher-cost TinyH264 software fallback.

Android Platform Tools are never downloaded silently or redistributed.

## Quick start

```bash
npx serve-droid doctor
npx serve-droid avd list
npx serve-droid start --detach
npx serve-droid list --json
```

When selecting a fixed port, probe it before touching the device. Occupied ports return the stable
`PORT_IN_USE` code and exit status `31`; `--port 0` keeps safe ephemeral allocation.

```bash
npx serve-droid doctor --port 47321 --json
npx serve-droid start --port 47321
```

Device playback audio is opt-in and browser playback remains muted until a human enables it:

```bash
npx serve-droid start --audio
```

See [device audio and privacy](docs/audio.md).

Open the printed local URL. The server listens on `127.0.0.1`, generates a random token, and injects
it into the local UI. To select a device:

```bash
npx serve-droid --device emulator-5554
```

Installed emulators can be managed explicitly with `serve-droid avd start <name>` and
`serve-droid avd stop <serial>`. No SDK content is downloaded or licensed automatically; see the
[AVD lifecycle guide](docs/avd.md).

To inspect several connected devices with independent tokens and bounded resources:

```bash
npx serve-droid grid --max-devices 4
```

See the [multi-device grid security and isolation model](docs/grid.md).

Coordinates are normalized: `(0, 0)` is the logical top-left and `(1, 1)` is the bottom-right.

```bash
npx serve-droid tap 0.5 0.5
npx serve-droid swipe 0.5 0.8 0.5 0.2 --duration 350
npx serve-droid app deep-link 'servedroid://fixture/example'
```

Session capture is explicit and bounded. `--record ./recordings` stores the original H.264 stream
plus privacy-filtered event summaries; it never records tokens, Logcat, typed text, URLs, or file
contents. See the [recording and retention guide](docs/recording.md).

## MCP

```json
{
  "mcpServers": {
    "serve-droid": {
      "command": "npx",
      "args": ["-y", "serve-droid", "mcp"]
    }
  }
}
```

The MCP surface deliberately provides explicit bounded tools instead of arbitrary shell access. See
[the MCP guide](docs/mcp.md).

## Security

- Loopback-only binding by default.
- Bearer authentication for reads, mutations, video, and control.
- Browser WebSockets carry credentials in a subprotocol header, not a URL.
- No arbitrary ADB or host shell endpoint.
- Uploads are capped at 256 MiB, written to a private temporary directory, and removed immediately.
- `clear` and `uninstall` require explicit confirmation from non-interactive clients.

Read [SECURITY.md](SECURITY.md) before binding to a LAN interface.

Short-lived remote access through an existing named Cloudflare Tunnel is available only with
explicit consent, HTTPS, bearer authentication, and a hard expiry. Read the
[tunnel threat model and setup guide](docs/tunnels.md) before using it.

## Supported and deferred

v0.1 targets macOS, Linux, Windows, Android API 26+, local emulators, USB devices, Wi-Fi ADB,
Chrome, Edge, Safari, and Firefox. Installed AVD lifecycle controls, opt-in bounded local recording,
the TinyH264 browser fallback, opt-in device audio for API 30+, and opt-in expiring named-tunnel
support are included. Cloud device labs, accounts, multi-user roles, AVD creation/provisioning, iOS,
and arbitrary shell access are deferred. See the [browser support matrix](docs/browser-support.md).

## Development

```bash
pnpm install
pnpm verify
pnpm --filter @serve-droid/cli dev -- doctor
```

The Android fixture source is under `fixtures/android-test-app`. Real-device tests run only when
`SERVE_DROID_DEVICE_TEST=1` is set.

See the evidence-based [release checklist](docs/TODO.md) for completed work and the remaining
hardware, platform, and publication gates.

## Project TODO

- [x] Publish the open repository with protected `main`, CodeQL, Dependabot, and secret scanning.
- [x] Ship the shared CLI, HTTP/WebSocket, MCP, Agent Skill, and browser cockpit foundation.
- [x] Add a reproducible, clearly labeled cockpit screenshot to this README.
- [x] Add searchable Logcat controls with priority filtering, pause, clear, and copy.
- [ ] Complete the real-device acceptance matrix on macOS, Linux, and Windows.
- [ ] Publish and validate the npm release candidate before tagging v0.1.0.

The complete, evidence-based checklist lives in [docs/TODO.md](docs/TODO.md). Items stay unchecked
until the repository contains the implementation or the required external evidence.

## License

Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
