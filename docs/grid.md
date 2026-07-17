# Multi-device grid

`serve-droid grid` starts one fully isolated serve-droid session per selected connected device and
a loopback-only dashboard that embeds those cockpits. Automatic selection includes every ready ADB
device only when it fits the explicit bound.

```bash
serve-droid grid emulator-5554 RF8M --max-devices 2
serve-droid grid --max-devices 4 --json
```

The default concurrent limit is four and the compiled hard maximum is eight. Exceeding the selected
limit is an error; the grid never silently truncates devices. Sessions start sequentially to avoid
simultaneous helper, Logcat, and hierarchy spikes. Each child retains its own random bearer token,
scrcpy helper, bounded Logcat ring, video backpressure, state record, and cleanup lifecycle. Grid
JSON deliberately omits child tokens. Each child accepts at most two simultaneous video clients;
additional authenticated video upgrades receive `503` instead of creating unbounded fan-out.

The green card is the shared human-takeover indicator. Selecting **Take control** changes explicit
server state; it does not guess a device from focus and does not disable authenticated agent access.
Every action still goes to the independently authenticated child URL for that device.

Offline devices and individual helper failures are reported as partial failures while healthy
sessions stay available. The dashboard health-checks children, stops stale helpers, and retries the
same device after a bounded five-second backoff without changing explicit takeover when recovery
succeeds. If no child can start, grid startup fails and cleans up every child. SIGINT and SIGTERM
stop the dashboard and all children. The dashboard is always bound to `127.0.0.1` and its
state/takeover APIs require a separate bearer token that is injected only into the local page.

The grid is a bounded local debugging view, not a cloud device lab or multi-user authorization
system. Stable-release certification still requires multi-device physical/emulator soak evidence.
