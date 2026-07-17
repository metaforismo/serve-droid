# Device audio

Audio capture is explicit and disabled by default. Start a session with
`serve-droid start --audio` to request Android playback audio. The browser still begins muted and
creates its authenticated audio WebSocket only after the user selects **Unmute device audio**.

serve-droid supports playback capture on Android 11 / API 30 and newer. It requests Opus at 48 kHz
stereo through scrcpy and uses the browser WebCodecs `AudioDecoder`. Android versions below API 30,
devices that deny playback capture, unavailable Opus encoders, and browsers without AudioDecoder
report audio as unavailable while video, controls, Logcat, and semantic inspection continue.

Each binary WebSocket message starts with an eight-byte signed big-endian presentation timestamp
in microseconds followed by one Opus access unit. The browser bounds the decoder queue and resets
its playback clock when it is stale or more than 500 ms ahead. This favors live debugging over
gapless playback. Audio reconnect uses bounded exponential backoff and does not reconnect video.

Audio may contain private conversations, notifications, or copyrighted media. Enable it only with
the device owner's consent. serve-droid does not place audio in session recordings.

## Verification

Automated tests cover packet framing, authenticated relay, playback-clock synchronization, bounded
decoder and socket backpressure, and reconnect backoff. A stable-release device matrix must
additionally verify audible playback on at least one API 30 device and one current Android device.
