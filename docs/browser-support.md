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

Run browser acceptance against the same device, motion script, viewport, and 30-second sample. Log
the decoder label shown in the header, rendered frames, p50/p95 frame arrival-to-render latency,
and browser-process CPU. Compare Safari and Firefox independently against the Chrome WebCodecs run;
do not combine host machines or device traces. Results belong in the release evidence and must name
browser versions, host hardware, Android device/API, and whether WebGL was available.

The software path is a compatibility fallback, not a promise of Chromium-equivalent performance.
The release checklist keeps real-browser performance numbers separate from functional support.
