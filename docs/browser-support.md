# Browser video support

serve-droid keeps control, authentication, Logcat, and semantic inspection on the same HTTP and
WebSocket APIs in every browser. Only the video decoder changes.

| Browser                 | Decoder        | Acceleration                            | Expected trade-off           |
| ----------------------- | -------------- | --------------------------------------- | ---------------------------- |
| Current Chrome and Edge | WebCodecs      | Browser hardware preference             | Primary, lowest-latency path |
| Current Safari          | Tango TinyH264 | WebAssembly worker plus WebGL rendering | Higher CPU and latency       |
| Current Firefox         | Tango TinyH264 | WebAssembly worker plus WebGL rendering | Higher CPU and latency       |

The cockpit selects WebCodecs when available and otherwise loads TinyH264 lazily. The software
fallback is not part of the initial JavaScript chunk. It requires WebAssembly, Web Workers, and a
working canvas renderer; a clear error is shown when those capabilities are unavailable.

TinyH264 supports H.264 Baseline profile through level 4 and no B-frames. serve-droid therefore
requests that compatible profile from scrcpy for the shared session. Slow software decoders drop
queued non-keyframes under backpressure instead of consuming unbounded memory. Human control and
semantic targeting continue even if video decoding fails.

## Performance verification

### Local synthetic baseline

On 2026-07-17, the Playwright acceptance test decoded its generated 64x64, three-frame H.264
Baseline Level 4 fixture through the forced TinyH264 path on an Apple M3. First decoded frame,
including lazy module, worker, and WebAssembly startup, was 293.5 ms in Chromium, 394.0 ms in
Firefox, and 331.0 ms in WebKit (Playwright 1.61.1). These are functional startup measurements,
not steady-state device-stream latency or browser CPU measurements, and they must not be used to
claim parity with WebCodecs.

The same Apple M3 host then ran a 640x360, 30 FPS, three-second generated stream through stable
Chrome 150.0.7871.116. WebCodecs rendered 90 frames in 540.9 ms using 0.417 browser-process CPU
seconds. Forced TinyH264 rendered 85 frames in 633.5 ms using 0.759 CPU seconds. In this bounded
sample, the fallback used 1.82x the measured process CPU and took 1.17x the elapsed time. The test
uses Chrome DevTools process counters before and after each decoder run in the same browser process;
run it with `SERVE_DROID_STABLE_CHROME=1 pnpm test:browser --project stable-chrome`. These numbers
are comparative browser-decoder evidence, not a real-device network or end-to-end latency claim.

Run browser acceptance against the same device, motion script, viewport, and 30-second sample. Log
the decoder label shown in the header, rendered frames, p50/p95 frame arrival-to-render latency,
and browser-process CPU. Compare Safari and Firefox independently against the Chrome WebCodecs run;
do not combine host machines or device traces. Results belong in the release evidence and must name
browser versions, host hardware, Android device/API, and whether WebGL was available.

The software path is a compatibility fallback, not a promise of Chromium-equivalent performance.
The release checklist keeps real-device performance numbers separate from functional browser
support.
