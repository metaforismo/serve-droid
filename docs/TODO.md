# Release checklist

This is the living, evidence-based checklist for `serve-droid`. Checked items exist in the current
tree and pass local verification. Unchecked items require hardware, another operating system,
external credentials, or additional implementation. A target is not considered supported merely
because its code path compiles.

## Repository and supply chain

- [x] Apache-2.0 license and third-party notices.
- [x] pnpm workspace with strict TypeScript, ESLint, Prettier, Vitest, and Changesets.
- [x] Node `>=22` package metadata and unscoped `serve-droid` package name.
- [x] Cross-platform CI matrix for macOS, Ubuntu, and Windows on Node 22 and 24.
- [x] CodeQL, Dependabot, issue forms, pull-request template, and release workflow.
- [x] Ignore local SDK data, APKs, recordings, screenshots, tokens, state, and environment files.
- [x] Bundle the CLI so a published package has no workspace dependency references.
- [x] Vendor scrcpy-server 3.3.3 and verify its recorded SHA-256 in tests.
- [x] Pack the npm artifact and install it in an isolated directory.
- [x] Run the installed executable and validate versioned `doctor --json` output.
- [x] Verify GitHub access as `metaforismo` and publish through protected pull requests.
- [x] Create the public `metaforismo/serve-droid` repository after CI is green.
- [x] Enable branch protection, secret scanning, push protection, and required checks.
- [x] Add a reproducible README cockpit screenshot that is explicitly labeled as demo data.
- [ ] Re-authenticate npm with publishing rights.
- [ ] Publish a release candidate with npm provenance.
- [ ] Install the release candidate from the public registry on clean macOS, Linux, and Windows.
- [ ] Sign and publish the v0.1.0 Git tag and GitHub release with checksums.

## Discovery and diagnostics

- [x] Resolve ADB from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then `PATH`.
- [x] Parse `adb devices -l` into explicit device, offline, and unauthorized states.
- [x] Detect emulator versus physical hardware using device properties.
- [x] Collect model, manufacturer, API, ABI, display size, density, and orientation.
- [x] Reject Android versions older than API 26 before session startup.
- [x] Select by serial, exact name, or unique case-insensitive name and reject ambiguity.
- [x] Provide machine-readable and human-readable doctor output.
- [x] Link to official Platform Tools setup without downloading ADB.
- [x] Diagnose occupied fixed ports before device startup and expose a typed `PORT_IN_USE` error.
- [ ] Add browser capability probing to `doctor`.
- [ ] Verify unauthorized and offline recovery with real devices.
- [ ] Verify Wi-Fi pairing and document observed OEM-specific behavior.

## Session, transport, and streaming

- [x] Start one authenticated HTTP/WebSocket server and one scrcpy source per device session.
- [x] Use Tango ADB/scrcpy packages and the official scrcpy server artifact.
- [x] Relay H.264 configuration and data packets without host decode/re-encode.
- [x] Decode H.264 in Chromium through WebCodecs.
- [x] Allocate an ephemeral port by default and persist private per-device state.
- [x] Support foreground and explicitly detached lifecycle modes.
- [x] Keep the device helper alive across browser disconnects.
- [x] Bound slow-client video buffering.
- [x] Tear down HTTP, Logcat, video, and state if startup fails.
- [ ] Confirm the first decoded browser frame within five seconds on a warmed emulator.
- [ ] Measure tap-to-visible-response p95 below 200 ms.
- [ ] Sustain interactive 30 FPS during ordinary UI motion.
- [ ] Restart a failed scrcpy helper exactly once and expose the terminal structured error.
- [ ] Exercise resolution changes, keyframes, rotation, and malformed packets on real transport.
- [ ] Prove two simultaneous browser clients can view and control one session.
- [ ] Run and measure a bounded 60-minute session.

## Actions and observation

- [x] Validate normalized coordinates and duration-bounded swipes.
- [x] Support taps, swipes, multi-step gestures, text, Android keys, and rotation.
- [x] Support install, launch, stop, clear, uninstall, deep links, and safe file push.
- [x] Require confirmation for destructive CLI and MCP app actions.
- [x] Restrict file destinations to `/sdcard` and reject non-APK installs.
- [x] Normalize UIAutomator XML to stable session-local elements and normalized bounds.
- [x] Reject zero and ambiguous semantic matches in the core lookup implementation.
- [x] Parse structured Logcat entries into a bounded cursor-addressable buffer.
- [x] Return screenshot, display, foreground app, elements, and incremental logs in observations.
- [x] Scope permission operations to an explicit permission map and package.
- [ ] Route browser pointer and gesture input through scrcpy control rather than ADB input.
- [ ] Add two-finger control-channel gesture injection.
- [x] Add bounded browser clipboard paste with an explicit printable-ASCII contract and documented
      device-keyboard fallback for Unicode.
- [x] Wait for fresh display metadata after rotation before accepting coordinates.
- [x] Detect hierarchy staleness after rotation and foreground-app changes.
- [ ] Capture agent screenshots from the decoded stream before using ADB fallback.
- [ ] Reset package PID filtering automatically after every app relaunch.
- [ ] Add typed errors for locked/secure screens and OEM input restrictions.

## Browser cockpit

- [x] Responsive portrait/landscape canvas with pointer input.
- [x] Connection, device, resolution, foreground app, and frame indicators.
- [x] Back, Home, Recents, Power, rotation, and screenshot controls.
- [x] Searchable semantic tree with normalized hover overlays and click targeting.
- [x] Bounded searchable Logcat panel.
- [x] APK/file drag-and-drop with safe server-side limits.
- [x] Keyboard focus, ARIA labels, visible focus, reduced motion, and live status.
- [x] Prefer WebCodecs and lazily fall back to Tango TinyH264 in Safari and Firefox.
- [x] Keep authenticated control and semantic inspection independent from video decoding.
- [x] Record same-stream stable-Chrome fallback latency and process-CPU evidence against WebCodecs.
- [x] Keep bearer tokens out of query strings, server logs, and non-loopback HTML.
- [x] Add a LAN token-entry screen and document fragment-based handoff.
- [x] Add priority and combined tag/message Logcat filters plus pause/clear/copy controls.
- [x] Add clipboard UI with manual entry and browser Clipboard API loading.
- [x] Add byte-accurate browser upload progress with a separate Android install/push phase.
- [ ] Run Playwright interaction, accessibility, upload, reconnect, and auth suites.

## CLI, HTTP, MCP, and Agent Skill

- [x] Provide the planned CLI command families with stable JSON output.
- [x] Expose versioned health, devices, session, observation, tree, screenshot, logs, action,
      app, permission, file, video, and control routes.
- [x] Require authentication on device data, mutations, logs, video, and control.
- [x] Expose the explicit 13-tool MCP surface over stdio.
- [x] Return MCP image content plus structured observation metadata.
- [x] Include Codex, Claude, Cursor, VS Code, and generic MCP examples.
- [x] Ship an Agent Skill with observe-act-verify, deep-link, failure, and cleanup rules.
- [x] Add a dedicated element-targeting MCP action that never falls back to guessed coordinates.
- [x] Contract-test every MCP tool with an in-memory transport.
- [ ] Add progress events for installs and pushes.
- [ ] Test backpressure and malformed input across every public transport.

## Fixture and platform acceptance

- [x] Include a Kotlin fixture with inputs, buttons, dialogs, scrolling, permissions, deep links,
      file selection, rotation state, accessibility labels, and intentional crash.
- [x] Unit-test ADB parsing, selection, transforms, gestures, hierarchy, matching, logs, and redaction.
- [x] Test HTTP authentication and vendored scrcpy checksum.
- [x] Configure a pinned Linux Android emulator CI job.
- [ ] Add Gradle Wrapper files and build the fixture APK in CI.
- [ ] Execute the complete install-launch-observe-act-crash-log-relaunch agent scenario.
- [ ] Test helper crash, stale state, port conflict, disconnect, reconnect, malformed XML, and large logs.
- [ ] Verify one emulator and one USB device on macOS.
- [ ] Verify one emulator and one USB device on Linux.
- [ ] Verify one emulator and one USB device on Windows.
- [ ] Verify one physical device through Wi-Fi ADB.
- [ ] Record OEM-specific restrictions and update the supported matrix.

## Deferred roadmap

- [x] Safari and Firefox TinyH264 decoder fallback with bounded packet backpressure.
- [x] Opt-in Opus audio streaming with mute-by-default playback and bounded backpressure.
- [x] Opt-in raw H.264 and privacy-filtered JSONL session recording.
- [x] Enforce recording byte/time limits with explicit verified cleanup.
- [x] Recover partial manifests only when their owning process is dead.
- [ ] Rich trace export and browser recording controls.
- [x] Expiring foreground named tunnels with explicit consent, revocation, and visible state.
- [ ] Multi-user collaboration roles.
- [x] Discover installed AVDs independently and provide explicit start/stop lifecycle controls.
- [x] Detect missing AVD system images without downloading content or accepting licenses.
- [x] Exercise AVD discovery/start validation across the macOS, Linux, and Windows CI matrix.
- [ ] AVD creation/provisioning.
- [x] Bounded loopback multi-device grid with isolated sessions and explicit takeover state.
- [ ] Cloud device providers.
- [ ] iOS support.
